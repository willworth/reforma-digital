// Servidor MCP del CREM (Centro Regional de Estadística de la Región de Murcia): las tablas de su
// banco de datos SICREM, que se publican en XML sin clave. No hay API de búsqueda propia: el
// catálogo sale del portal de datos abiertos de la Región (CKAN), que enlaza cada tabla.
import { z } from 'zod';
import {
  decode,
  get,
  matches,
  READ_ONLY_EXTERNAL,
  run,
  server,
  SourceError,
  words,
  type Fetch,
} from './comun';

const CKAN = 'https://datosabiertos.regiondemurcia.es/api/3/action/package_search';
const SICREM = 'https://econet.carm.es/web/crem/inicio/-/crem/sicrem/';
// Las condiciones de reutilización del portal piden citar al propietario y la fecha de
// actualización: https://datosabiertos.regiondemurcia.es/avisolegal
const SOURCE =
  'Origen de los datos: Centro Regional de Estadística de la Región de Murcia (CREM, econet.carm.es) y el organismo que indica `origen`. Cita la fecha de `actualizada`.';
// Una tabla de municipios por meses pasa de 2.000 datos: más no le sirve al asistente.
const MAX_DATOS = 200;

const INSTRUCTIONS = `Estadísticas del Centro Regional de Estadística de Murcia (CREM): paro registrado, población, nacimientos, migraciones, educación y elecciones de la Región de Murcia y de cada uno de sus 45 municipios.
Se llega a un dato en tres pasos: buscar_tabla (por palabras del tema; los títulos dicen «según municipios», no «Yecla»), ver_tabla (qué contiene y cuándo se actualizó) y datos_tabla (los datos, filtrados por palabras como «Yecla octubre 2026»).
Algunas tablas llevan años sin actualizarse: di siempre la fecha de \`actualizada\` (o que el CREM no la da) y, si es antigua, avisa de que el INE puede tener un dato más reciente. Un valor null es un dato que el CREM no da (por ejemplo, de un año en que el municipio aún no existía): no es un cero.
Solo están las tablas que enlaza el portal de datos abiertos de la Región, no todo el banco de datos del CREM. Si el nombre del portal y el título de la tabla no coinciden, vale el título.
${SOURCE}`;

type Tabla = { id: string; nombre: string; modificada: string; aviso?: string };
let catalogo: Promise<Tabla[]> | undefined;

// El id es la ruta de la tabla dentro de SICREM; el portal la enlaza con http:// o https://.
const RUTA = String.raw`PU\w*\/(?:\w+\/)*xml\w*\.xml`;
const ID = new RegExp(
  String.raw`^https?:\/\/econet\.carm\.es\/web\/crem\/inicio\/-\/crem\/sicrem\/(${RUTA})$`,
);

async function pedirCatalogo(fetchImpl: Fetch) {
  const query = new URLSearchParams({
    fq: 'res_url:*sicrem*',
    fl: 'title,metadata_modified,res_url',
    rows: '1000',
  });
  const body = (await (await get(fetchImpl, `${CKAN}?${query}`)).json()) as {
    result: {
      count: number;
      results: { title: string; metadata_modified: string; res_url: string[] }[];
    };
  };
  if (body.result.count > body.result.results.length)
    throw new SourceError('El catálogo del CREM tiene más tablas de las que se pueden pedir.');
  // El portal enlaza a veces un mismo XML con nombres distintos («Hombres» y «Ambos sexos»): no
  // se sabe cuál es el bueno sin abrirlo.
  const porId = new Map<string, { nombres: Set<string>; modificada: string }>();
  for (const p of body.result.results)
    for (const url of p.res_url) {
      const id = ID.exec(url)?.[1];
      if (!id) continue;
      const tabla = porId.get(id) ?? { nombres: new Set<string>(), modificada: '' };
      tabla.nombres.add(p.title);
      const modificada = p.metadata_modified.slice(0, 10);
      if (modificada > tabla.modificada) tabla.modificada = modificada;
      porId.set(id, tabla);
    }
  return [...porId].map(([id, { nombres, modificada }]): Tabla => ({
    id,
    nombre: [...nombres].join(' | '),
    modificada,
    aviso:
      nombres.size > 1
        ? 'El portal enlaza esta tabla con varios nombres: mira su título con ver_tabla antes de usarla.'
        : undefined,
  }));
}

export async function buscarTabla(fetchImpl: Fetch, q: string) {
  catalogo ??= pedirCatalogo(fetchImpl).catch((error: unknown) => {
    catalogo = undefined;
    throw error;
  });
  const w = words(q);
  const found = (await catalogo)
    .filter((t) => matches(t.nombre, w))
    .sort((a, b) => b.modificada.localeCompare(a.modificada));
  return { total: found.length, tablas: found.slice(0, 30) };
}

const texto = (s: string) => decode(s).replace(/\s+/g, ' ').trim();

// Formato español: «1.531.878» y «100,0». Lo que no es un número se da tal cual.
const numero = (valor: string) =>
  /^-?\d{1,3}(\.\d{3})*(,\d+)?$|^-?\d+(,\d+)?$/.test(valor)
    ? Number(valor.replaceAll('.', '').replace(',', '.'))
    : valor;

const ilegible = () =>
  new SourceError('El CREM ha dado esta tabla con un formato que el servidor no sabe leer.');

/** Una tabla del SICREM: sus datos, uno por cada combinación de dimensiones, y su ficha. */
function leerTabla(xml: string) {
  const info = /<info val="([^"]*)"/.exec(xml)?.[1];
  const titulo = /<titulo>([\s\S]*?)<\/titulo>/.exec(xml)?.[1];
  if (titulo === undefined) throw new SourceError('El CREM no ha dado una tabla con ese id.');
  const cuerpo = /<datos>([\s\S]*)<\/datos>/.exec(xml)?.[1];
  // Una dimensión o un nombre vacíos descuadrarían los nombres de los datos que los siguen.
  if (cuerpo === undefined || /<(dimension|nombre)\b[^>]*\/>/.test(cuerpo)) throw ilegible();
  // Por orden: la fecha de actualización, notas y «- Organismo». Puede faltar la fecha o el organismo.
  const fuente = [...xml.matchAll(/<fuente>([\s\S]*?)<\/fuente>/g)].map((m) => texto(m[1] ?? ''));
  const fecha = /^Fecha de actualización: (\d{2})\/(\d{2})\/(\d{4})/.exec(fuente[0] ?? '');
  if (fecha) fuente.shift();
  const origen = /^-\s*(.+)/.exec(fuente.at(-1) ?? '')?.[1];
  if (origen !== undefined) fuente.pop();
  const niveles: Set<string>[] = [];
  const datos: { serie: string; valor: number | string | null }[] = [];
  const ruta: string[] = [];
  // Cada <dimension> anida a las siguientes; las hojas llevan <valor>, o <valor/> si no hay dato.
  for (const m of cuerpo.matchAll(
    /<dimension\b[^>]*>|<\/dimension>|<nombre>([\s\S]*?)<\/nombre>|<valor>([\s\S]*?)<\/valor>|<valor\s*\/>/g,
  )) {
    if (m[0] === '</dimension>') ruta.pop();
    else if (m[0].startsWith('<dimension')) ruta.push('');
    else if (ruta.length === 0) throw ilegible();
    else if (m[1] !== undefined) {
      const nombre = texto(m[1]);
      ruta[ruta.length - 1] = nombre;
      (niveles[ruta.length - 1] ??= new Set()).add(nombre);
    } else {
      const valor = texto(m[2] ?? '');
      datos.push({ serie: ruta.join(' · '), valor: valor === '' ? null : numero(valor) });
    }
  }
  if (datos.length === 0) throw ilegible();
  return {
    ficha: {
      titulo: texto(titulo).replace(/^\d+\.\s*/, ''),
      // En las tablas de un corte (un mes, un sexo…), cuál es.
      corte: info === undefined ? undefined : texto(info),
      actualizada: fecha ? `${fecha[3]}-${fecha[2]}-${fecha[1]}` : undefined,
      origen,
      notas: fuente,
    },
    niveles: niveles.map((n) => [...n]),
    datos,
  };
}

const tabla = z
  .string()
  .regex(new RegExp(`^${RUTA}$`))
  .max(120)
  .describe('Id de la tabla, de buscar_tabla, como PU_paroRegistrado/xml/xml4.xml.');

async function pedirTabla(fetchImpl: Fetch, id: string) {
  let response: Response;
  try {
    // Con `application/xml`, el CREM responde 406.
    response = await get(fetchImpl, `${SICREM}${id}`, 'text/xml');
  } catch (error) {
    if (error instanceof SourceError && error.status === 404)
      throw new SourceError(`El CREM no tiene la tabla ${id}. Búscala con buscar_tabla.`);
    throw error;
  }
  // Los XML del SICREM vienen en ISO-8859-1: `response.text()` rompería las tildes.
  return leerTabla(new TextDecoder('latin1').decode(await response.arrayBuffer()));
}

export async function verTabla(fetchImpl: Fetch, id: string) {
  const { ficha, niveles, datos } = await pedirTabla(fetchImpl, id);
  return {
    ...ficha,
    total: datos.length,
    // De cada nivel, una muestra: datos_tabla filtra por texto.
    niveles: niveles.map((n) => ({ total: n.length, valores: n.slice(0, 60) })),
  };
}

export async function datosTabla(fetchImpl: Fetch, id: string, q?: string) {
  const { ficha, datos } = await pedirTabla(fetchImpl, id);
  const w = words(q);
  const found = datos.filter((d) => matches(d.serie, w));
  return {
    ...ficha,
    total: found.length,
    nota:
      found.length > MAX_DATOS
        ? `Solo los ${MAX_DATOS} primeros: afina con \`q\` (un municipio, un año) para ver otros.`
        : undefined,
    datos: found.slice(0, MAX_DATOS),
  };
}

export function createCremMcp(fetchImpl: Fetch = fetch) {
  return server({ name: 'reforma-digital-crem', title: 'CREM' }, INSTRUCTIONS, (s) => {
    s.registerTool(
      'buscar_tabla',
      {
        title: 'Buscar tabla',
        description:
          'Las tablas del CREM cuyo título contiene las palabras de `q`, de la modificada más recientemente en el portal a la más antigua. Los títulos nombran el tema, no el lugar: busca «paro registrado municipios», no «paro Yecla».',
        inputSchema: z.object({ q: z.string().min(2).max(100) }),
        annotations: READ_ONLY_EXTERNAL,
      },
      ({ q }) => run(SOURCE, () => buscarTabla(fetchImpl, q)),
    );
    s.registerTool(
      'ver_tabla',
      {
        title: 'Ver una tabla',
        description:
          'El título de una tabla, su fecha de actualización, su origen y notas, y los valores de cada nivel (los 60 primeros), para saber cómo filtrar datos_tabla.',
        inputSchema: z.object({ tabla }),
        annotations: READ_ONLY_EXTERNAL,
      },
      ({ tabla }) => run(SOURCE, () => verTabla(fetchImpl, tabla)),
    );
    s.registerTool(
      'datos_tabla',
      {
        title: 'Datos de una tabla',
        description: `Los datos de una tabla cuyo nombre contiene todas las palabras de \`q\`, como «Yecla 2026» o «total octubre 2026». Cada dato lleva el nombre de sus niveles, como «Yecla · Octubre 2026». Como mucho ${MAX_DATOS}.`,
        inputSchema: z.object({ tabla, q: z.string().max(200).optional() }),
        annotations: READ_ONLY_EXTERNAL,
      },
      ({ tabla, q }) => run(SOURCE, () => datosTabla(fetchImpl, tabla, q)),
    );
  });
}
