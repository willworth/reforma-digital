// @vitest-environment node
// CREM sin red: XML y respuestas del catálogo de datos abiertos con la forma de las reales
// (recortadas), para lo que se puede romper al leerlas.
import { describe, expect, it, vi } from 'vitest';
import {
  buscarTabla as buscarTablaCrem,
  datosTabla as datosTablaCrem,
  verTabla as verTablaCrem,
} from './crem';

const fetchJson = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => Response.json(body, { status }));

describe('CREM', () => {
  // Recortado de PU_paroRegistrado/xml/xml4.xml, con su codificación (ISO-8859-1).
  const paro = `<?xml version="1.0" encoding="iso-8859-1"?>
<publicacion codigo="PU1263" nombre="PARO REGISTRADO">
  <titulo>3. Evolución del paro registrado según municipios.</titulo>
  <info val="Paro registrado. CNAE-2009 - Total - TOTAL" />
  <fuente>Fecha de actualización: 04/11/2026.</fuente>
  <fuente>- Servicio Regional de Empleo y Formación. Paro Registrado</fuente>
  <datos>
    <dimension val="0">
      <nombre>MURCIA (Región de)</nombre><nivel>0</nivel>
      <dimension val="0"><nombre>Octubre    2026</nombre><nivel>0</nivel><valor>78.138</valor></dimension>
    </dimension>
    <dimension val="1">
      <nombre>Yecla</nombre><nivel>1</nivel>
      <dimension val="0"><nombre>Octubre    2026</nombre><nivel>0</nivel><valor>2191</valor></dimension>
      <dimension val="1"><nombre>Septiembre 2026</nombre><nivel>0</nivel><valor>-0,5</valor></dimension>
    </dimension>
  </datos>
</publicacion>`;
  const fetchXml = (xml = paro) =>
    vi.fn<typeof fetch>(async () => new Response(Buffer.from(xml, 'latin1')));

  it('lists the SICREM tables the portal links, newest first, and flags ids with two names', async () => {
    const xml = (ruta: string) => `http://econet.carm.es/web/crem/inicio/-/crem/sicrem/${ruta}`;
    const fetchImpl = fetchJson({
      result: {
        count: 4,
        results: [
          {
            title: 'Evolución de la población según municipios',
            metadata_modified: '2021-03-01T10:00:00',
            res_url: [
              xml('PU_padron/series/xml/xmlP6019_2.xml'),
              xml('PU_padron/series/excel/sec2.xls'),
            ],
          },
          {
            title: 'Evolución del paro registrado según municipios',
            metadata_modified: '2026-11-06T03:10:11',
            res_url: [xml('PU_paroRegistrado/xml/xml4.xml').replace('http:', 'https:')],
          },
          // El portal real enlaza el mismo XML con estos dos nombres.
          {
            title: 'Paro registrado según municipios y grupos de edad. Hombres',
            metadata_modified: '2026-11-06T03:10:00',
            res_url: [xml('PU_paroRegistrado/xml/xml5_c1.xml')],
          },
          {
            title: 'Paro registrado según municipios y grupos de edad. Ambos sexos',
            metadata_modified: '2026-11-06T03:10:00',
            res_url: [xml('PU_paroRegistrado/xml/xml5_c1.xml')],
          },
        ],
      },
    });
    expect(await buscarTablaCrem(fetchImpl, 'municipios')).toEqual({
      total: 3,
      tablas: [
        {
          id: 'PU_paroRegistrado/xml/xml4.xml',
          nombre: 'Evolución del paro registrado según municipios',
          modificada: '2026-11-06',
        },
        {
          id: 'PU_paroRegistrado/xml/xml5_c1.xml',
          nombre:
            'Paro registrado según municipios y grupos de edad. Hombres | Paro registrado según municipios y grupos de edad. Ambos sexos',
          modificada: '2026-11-06',
          aviso:
            'El portal enlaza esta tabla con varios nombres: mira su título con ver_tabla antes de usarla.',
        },
        {
          id: 'PU_padron/series/xml/xmlP6019_2.xml',
          nombre: 'Evolución de la población según municipios',
          modificada: '2021-03-01',
        },
      ],
    });
  });

  it('reads the table in ISO-8859-1, with its update date, origin and levels', async () => {
    expect(await verTablaCrem(fetchXml(), 'PU_paroRegistrado/xml/xml4.xml')).toEqual({
      titulo: 'Evolución del paro registrado según municipios.',
      corte: 'Paro registrado. CNAE-2009 - Total - TOTAL',
      actualizada: '2026-11-04',
      origen: 'Servicio Regional de Empleo y Formación. Paro Registrado',
      notas: [],
      total: 3,
      niveles: [
        { total: 2, valores: ['MURCIA (Región de)', 'Yecla'] },
        { total: 2, valores: ['Octubre 2026', 'Septiembre 2026'] },
      ],
    });
  });

  it('names each value by its levels and reads Spanish numbers', async () => {
    const fetchImpl = fetchXml();
    expect(
      (await datosTablaCrem(fetchImpl, 'PU_paroRegistrado/xml/xml4.xml', 'yecla')).datos,
    ).toEqual([
      { serie: 'Yecla · Octubre 2026', valor: 2191 },
      { serie: 'Yecla · Septiembre 2026', valor: -0.5 },
    ]);
    expect(
      (await datosTablaCrem(fetchImpl, 'PU_paroRegistrado/xml/xml4.xml', 'region')).datos,
    ).toEqual([{ serie: 'MURCIA (Región de) · Octubre 2026', valor: 78138 }]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://econet.carm.es/web/crem/inicio/-/crem/sicrem/PU_paroRegistrado/xml/xml4.xml',
      expect.objectContaining({ headers: { Accept: 'text/xml' } }),
    );
  });

  it('caps the data and says how to see the rest', async () => {
    const filas = Array.from(
      { length: 201 },
      (_, i) =>
        `<dimension val="${i}"><nombre>Año ${i}</nombre><nivel>0</nivel><valor>${i}</valor></dimension>`,
    ).join('');
    const xml = `<publicacion><titulo>Serie larga</titulo><fuente>Fecha de actualización: 01/01/2026.</fuente><fuente>- CREM</fuente><datos>${filas}</datos></publicacion>`;
    const result = await datosTablaCrem(fetchXml(xml), 'PU_x/xml/xml1.xml');
    expect(result).toMatchObject({ total: 201, nota: expect.stringContaining('afina con `q`') });
    expect(result.datos).toHaveLength(200);
  });

  it('gives null, not zero, for a value CREM leaves empty', async () => {
    const vacia = paro.replace('<valor>2191</valor>', '<valor/>');
    expect(
      (await datosTablaCrem(fetchXml(vacia), 'PU_paroRegistrado/xml/xml4.xml', 'yecla')).datos,
    ).toEqual([
      { serie: 'Yecla · Octubre 2026', valor: null },
      { serie: 'Yecla · Septiembre 2026', valor: -0.5 },
    ]);
  });

  it('does not take the update date or a note for the origin', async () => {
    const soloFecha = paro.replace(/<fuente>- [^<]*<\/fuente>/, '');
    expect(await verTablaCrem(fetchXml(soloFecha), 'PU_paroRegistrado/xml/xml4.xml')).toMatchObject(
      { actualizada: '2026-11-04', origen: undefined, notas: [] },
    );
    const sinFecha = paro.replace(/<fuente>Fecha[^<]*<\/fuente>/, '<fuente>Una nota.</fuente>');
    expect(await verTablaCrem(fetchXml(sinFecha), 'PU_paroRegistrado/xml/xml4.xml')).toMatchObject({
      actualizada: undefined,
      origen: 'Servicio Regional de Empleo y Formación. Paro Registrado',
      notas: ['Una nota.'],
    });
  });

  it.each([
    ['an empty level', (xml: string) => xml.replace('<dimension val="1">', '<dimension val="1"/>')],
    ['an empty name', (xml: string) => xml.replace('<nombre>Yecla</nombre>', '<nombre/>')],
    ['no data', (xml: string) => xml.replace(/<datos>[\s\S]*<\/datos>/, '')],
  ])('refuses a table with %s rather than misnaming or hiding its data', async (_, cambia) => {
    await expect(
      datosTablaCrem(fetchXml(cambia(paro)), 'PU_paroRegistrado/xml/xml4.xml'),
    ).rejects.toThrow('formato que el servidor no sabe leer');
  });

  it('says which table is missing instead of a bare 404', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('', { status: 404 }));
    await expect(datosTablaCrem(fetchImpl, 'PU_paroRegistrado/xml/xml99.xml')).rejects.toThrow(
      'El CREM no tiene la tabla PU_paroRegistrado/xml/xml99.xml',
    );
  });
});
