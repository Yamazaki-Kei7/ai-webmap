/**
 * The internal class breaks of `values` in `classes` classes: ascending, without duplicates, at most `classes - 1`.
 * A break starts a class: class k holds the values from `breaks[k - 1]` (inclusive) up to `breaks[k]` (exclusive),
 * which is how a MapLibre `step` expression reads its stops. Values that are not finite are ignored. When the data
 * has too few distinct values for `classes` classes there are fewer breaks, and none when all values are equal.
 *
 * - `equal`: `min + i * (max - min) / classes` for i = 1 .. classes - 1.
 * - `quantile`: the value at index `floor(i * n / classes)` of the n sorted values, for i = 1 .. classes - 1, so each
 *   class gets about n / classes values. When that value is not above the previous break (the minimum for the first;
 *   ties, e.g. many zeros) the break moves up to the smallest value that is, so skewed data keeps its classes; when
 *   there is none the remaining breaks are dropped.
 */
export function computeBreaks(values: readonly number[], method: 'quantile' | 'equal', classes: number): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (sorted.length === 0) return [];
  const min = sorted[0];
  const max = sorted[sorted.length - 1];
  if (method === 'equal') {
    return Array.from({ length: Math.max(classes - 1, 0) }, (_, k) => min + ((k + 1) * (max - min)) / classes).filter(
      (value) => value > min
    );
  }
  const breaks: number[] = [];
  let previous = min;
  for (let i = 1; i < classes; i++) {
    const candidate = sorted[Math.floor((i * sorted.length) / classes)];
    const next = candidate > previous ? candidate : sorted.find((value) => value > previous);
    if (next === undefined) break;
    breaks.push(next);
    previous = next;
  }
  return breaks;
}
