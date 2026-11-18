import { describe, expect, it } from 'vitest';
import type { GeoJsonFeature, GeoJsonFeatureCollection, GeoJsonGeometry, Position } from '../duckdb/queryTypes';
import { derivedLabelPoints, polygonLabelPoint } from './labelPoint';

type Ring = Position[];
type Part = Ring[];

const ring = (...points: [number, number][]): Ring => [...points, points[0]];
const square = (x: number, y: number, size: number): Ring => ring([x, y], [x + size, y], [x + size, y + size], [x, y + size]);

/** Even-odd containment of a point in one part (outer ring and holes), written independently of the code under test. */
function insidePart(point: Position, part: Part): boolean {
  let inside = false;
  for (const ringOfPart of part) {
    for (let i = 0, j = ringOfPart.length - 1; i < ringOfPart.length; j = i++) {
      const [xi, yi] = ringOfPart[i];
      const [xj, yj] = ringOfPart[j];
      if (yi > point[1] !== yj > point[1] && point[0] < ((xj - xi) * (point[1] - yi)) / (yj - yi) + xi) inside = !inside;
    }
  }
  return inside;
}

const polygon = (...rings: Ring[]): GeoJsonGeometry => ({ type: 'Polygon', coordinates: rings });
const multi = (...parts: Part[]): GeoJsonGeometry => ({ type: 'MultiPolygon', coordinates: parts });

function pointOf(geometry: GeoJsonGeometry): Position {
  const point = polygonLabelPoint(geometry);
  if (point === undefined) throw new Error('expected a point');
  return point;
}

describe('polygonLabelPoint', () => {
  it('is the centroid of a convex polygon', () => {
    const [x, y] = pointOf(polygon(square(0, 0, 10)));
    expect(x).toBeCloseTo(5);
    expect(y).toBeCloseTo(5);
  });

  it('is the centroid of a triangle (a third of the way from the base)', () => {
    const [x, y] = pointOf(polygon(ring([0, 0], [6, 0], [0, 6])));
    expect(x).toBeCloseTo(2);
    expect(y).toBeCloseTo(2);
  });

  it('is the same for either winding', () => {
    const clockwise = pointOf(polygon([...square(0, 0, 10)].reverse()));
    expect(clockwise[0]).toBeCloseTo(5);
    expect(clockwise[1]).toBeCloseTo(5);
  });

  it('lies inside a concave "C" whose centroid is in the opening', () => {
    // A C opening to the right: the bar at the left is thin, the arms are long.
    const c = ring([0, 0], [10, 0], [10, 2], [2, 2], [2, 8], [10, 8], [10, 10], [0, 10]);
    const point = pointOf(polygon(c));
    expect(insidePart(point, [c])).toBe(true);
  });

  it('lies inside a "U" whose centroid is in the gap, in the widest part of the line through the centroid', () => {
    // A U opening upward: the base is 0..3 high, the arms stand 3 wide at x 0..3 and 7..10. The centroid is in the base or the gap.
    const u = ring([0, 0], [10, 0], [10, 10], [7, 10], [7, 3], [3, 3], [3, 10], [0, 10]);
    const point = pointOf(polygon(u));
    expect(insidePart(point, [u])).toBe(true);
  });

  it('puts the point of a "U" with a deep gap at the middle of the widest stretch', () => {
    // Arms 1 wide at x 0..1 and 9..10, a base 1 high; the centroid (about y 3.6) is in the gap.
    const u = ring([0, 0], [10, 0], [10, 10], [9, 10], [9, 1], [1, 1], [1, 10], [0, 10]);
    const [x, y] = pointOf(polygon(u));
    expect(insidePart([x, y], [u])).toBe(true);
    // The line through the centroid crosses the two arms (each 1 wide): the point is in one of them, at its middle.
    expect([0.5, 9.5].some((middle) => Math.abs(x - middle) < 1e-9)).toBe(true);
  });

  it('lies inside a polygon with a hole at the centroid, and not in the hole', () => {
    const outer = square(0, 0, 10);
    const hole: Ring = [...square(3, 3, 4)].reverse();
    const point = pointOf(polygon(outer, hole));
    expect(insidePart(point, [outer, hole])).toBe(true);
    const inHole = point[0] > 3 && point[0] < 7 && point[1] > 3 && point[1] < 7;
    expect(inHole).toBe(false);
  });

  it('takes the point in the largest part of a MultiPolygon with small islands', () => {
    const big = square(0, 0, 10);
    const islandFar = square(50, 50, 1);
    const islandNear = square(12, 0, 2);
    const point = pointOf(multi([islandFar], [big], [islandNear]));
    expect(insidePart(point, [big])).toBe(true);
  });

  it('chooses the part by area, with its holes taken off', () => {
    const holey = square(0, 0, 10);
    const bigHole: Ring = [...square(1, 1, 8)].reverse(); // the part's area is 100 - 64 = 36
    const solid = square(20, 0, 7); // 49
    const point = pointOf(multi([holey, bigHole], [solid]));
    expect(insidePart(point, [solid])).toBe(true);
  });

  it('is the point of a Polygon or of a MultiPolygon with one part alike', () => {
    expect(pointOf(multi([square(0, 0, 4)]))).toEqual(pointOf(polygon(square(0, 0, 4))));
  });

  it('is undefined for a geometry that is not a polygon, and for a polygon with no ring', () => {
    expect(polygonLabelPoint({ type: 'Point', coordinates: [1, 2] })).toBeUndefined();
    expect(polygonLabelPoint({ type: 'LineString', coordinates: [[0, 0], [1, 1]] })).toBeUndefined();
    expect(polygonLabelPoint({ type: 'Polygon', coordinates: [] })).toBeUndefined();
    expect(polygonLabelPoint({ type: 'MultiPolygon', coordinates: [] })).toBeUndefined();
  });

  it('gives a point on a flat ring (no area) instead of failing', () => {
    expect(polygonLabelPoint(polygon(ring([0, 0], [4, 0], [8, 0])))).toBeDefined();
  });
});

function feature(id: number, geometry: GeoJsonGeometry, name: string): GeoJsonFeature {
  return { type: 'Feature', id, geometry, properties: { name, n: id } };
}

const collection = (...features: GeoJsonFeature[]): GeoJsonFeatureCollection => ({ type: 'FeatureCollection', features });

describe('derivedLabelPoints', () => {
  it('has one point per polygon feature, with the properties and the id of the feature', () => {
    const data = collection(
      feature(0, multi([square(0, 0, 10)], [square(20, 0, 2)], [square(30, 0, 2)]), '北海道'),
      feature(1, polygon(square(100, 0, 4)), '青森県')
    );
    const labels = derivedLabelPoints(data);
    expect(labels.type).toBe('FeatureCollection');
    expect(labels.features).toHaveLength(2);
    expect(labels.features.map(({ id }) => id)).toEqual([0, 1]);
    expect(labels.features.map(({ properties }) => properties.name)).toEqual(['北海道', '青森県']);
    for (const { geometry } of labels.features) expect(geometry.type).toBe('Point');
    const [first] = labels.features;
    expect(first.geometry.coordinates[0]).toBeGreaterThan(0);
    expect(first.geometry.coordinates[0]).toBeLessThan(10);
  });

  it('skips a feature that has no polygon', () => {
    const data = collection(feature(0, { type: 'Point', coordinates: [1, 1] }, 'p'), feature(1, polygon(square(0, 0, 2)), 'q'));
    expect(derivedLabelPoints(data).features.map(({ id }) => id)).toEqual([1]);
  });

  it('is built once per data object: the same collection gives the same result', () => {
    const data = collection(feature(0, polygon(square(0, 0, 2)), 'a'));
    expect(derivedLabelPoints(data)).toBe(derivedLabelPoints(data));
    expect(derivedLabelPoints(collection(feature(0, polygon(square(0, 0, 2)), 'a')))).not.toBe(derivedLabelPoints(data));
  });
});
