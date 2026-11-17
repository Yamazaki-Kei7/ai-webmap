import { describe, expect, it } from 'vitest';
import { buildFeatureCollection, type FeatureRow } from './geojson';

const row = (geometry: object | null, properties: FeatureRow['properties'] = {}): FeatureRow => ({
  geometry: geometry === null ? null : JSON.stringify(geometry),
  properties
});
const point = (lon: number, lat: number) => ({ type: 'Point', coordinates: [lon, lat] });

describe('buildFeatureCollection', () => {
  it('turns each geometry type into a feature of its family', () => {
    const cases: [object, string][] = [
      [point(1, 2), 'point'],
      [{ type: 'MultiPoint', coordinates: [[1, 2], [3, 4]] }, 'point'],
      [{ type: 'LineString', coordinates: [[0, 0], [1, 1]] }, 'line'],
      [{ type: 'MultiLineString', coordinates: [[[0, 0], [1, 1]], [[2, 2], [3, 3]]] }, 'line'],
      [{ type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 0]]] }, 'polygon'],
      [{ type: 'MultiPolygon', coordinates: [[[[0, 0], [1, 0], [1, 1], [0, 0]]]] }, 'polygon']
    ];
    for (const [geometry, family] of cases) {
      const result = buildFeatureCollection([row(geometry)]);
      expect(result).toMatchObject({ ok: true, geometryType: family });
    }
  });

  it('uses the attributes as properties and the row index as id', () => {
    const result = buildFeatureCollection([row(point(1, 2), { name: 'a', n: 3 }), row(point(3, 4), { name: 'b', n: null })]);
    expect(result).toEqual({
      ok: true,
      geometryType: 'point',
      bbox: [1, 2, 3, 4],
      features: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', id: 0, geometry: point(1, 2), properties: { name: 'a', n: 3 } },
          { type: 'Feature', id: 1, geometry: point(3, 4), properties: { name: 'b', n: null } }
        ]
      }
    });
  });

  it('leaves out a row with no geometry (NULL or empty)', () => {
    const result = buildFeatureCollection([row(null), row(point(5, 6)), row({ type: 'Point', coordinates: [] })]);
    expect(result).toMatchObject({ ok: true, bbox: [5, 6, 5, 6] });
    if (result.ok) expect(result.features.features.map((feature) => feature.id)).toEqual([1]);
  });

  it('computes the bbox over negative and crossing values', () => {
    const result = buildFeatureCollection([row(point(-10.5, 20)), row(point(30, -40.25)), row(point(-179.9, 89.5))]);
    expect(result).toMatchObject({ ok: true, bbox: [-179.9, -40.25, 30, 89.5] });
  });

  it('computes the bbox of a polygon with a hole and of a multi polygon from every ring', () => {
    const polygon = {
      type: 'Polygon',
      coordinates: [
        [[0, 0], [10, 0], [10, 10], [0, 10], [0, 0]],
        [[2, 2], [3, 2], [3, 3], [2, 2]]
      ]
    };
    expect(buildFeatureCollection([row(polygon)])).toMatchObject({ bbox: [0, 0, 10, 10] });
    const multi = { type: 'MultiPolygon', coordinates: [polygon.coordinates, [[[20, -5], [21, -5], [21, -4], [20, -5]]]] };
    expect(buildFeatureCollection([row(multi)])).toMatchObject({ bbox: [0, -5, 21, 10] });
  });

  it('ignores the height of a position', () => {
    expect(buildFeatureCollection([row({ type: 'Point', coordinates: [1, 2, 900] })])).toMatchObject({ bbox: [1, 2, 1, 2] });
  });

  it('refuses two families and names them', () => {
    const result = buildFeatureCollection([row(point(1, 2)), row({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })]);
    expect(result).toEqual({ ok: false, reason: 'mixed', message: 'The query returned points and lines; a layer holds one geometry type.' });
  });

  it('refuses a value that is not GeoJSON instead of throwing', () => {
    for (const text of ['not json', '[1,2]', 'null', '"x"']) {
      expect(buildFeatureCollection([{ geometry: text, properties: {} }])).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses coordinates that do not nest as the type says', () => {
    const wrong = [
      { type: 'Point', coordinates: [[1, 2]] },
      { type: 'Point', coordinates: [1] },
      { type: 'Point', coordinates: ['1', '2'] },
      { type: 'LineString', coordinates: [1, 2] },
      { type: 'LineString', coordinates: [[[0, 0], [1, 1]]] },
      { type: 'Polygon', coordinates: [[0, 0], [1, 1]] },
      { type: 'MultiPolygon', coordinates: [[[0, 0], [1, 1]]] },
      { type: 'MultiPoint', coordinates: [[0, 'x']] }
    ];
    for (const geometry of wrong) {
      expect(buildFeatureCollection([row(geometry)]), JSON.stringify(geometry)).toMatchObject({ ok: false, reason: 'invalid' });
    }
  });

  it('refuses a GeometryCollection', () => {
    const result = buildFeatureCollection([row({ type: 'GeometryCollection', geometries: [] })]);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain('GeometryCollection');
  });

  it('has no family and a zero bbox when no feature is left', () => {
    expect(buildFeatureCollection([])).toEqual({ ok: true, geometryType: undefined, bbox: [0, 0, 0, 0], features: { type: 'FeatureCollection', features: [] } });
    expect(buildFeatureCollection([row(null)])).toMatchObject({ ok: true, geometryType: undefined, bbox: [0, 0, 0, 0] });
  });
});
