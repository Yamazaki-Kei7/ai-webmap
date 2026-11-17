import { describe, expect, it } from 'vitest';
import { computeBreaks } from './classify';

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe('computeBreaks: equal', () => {
  it('cuts the range into equal widths', () => {
    expect(computeBreaks([0, 3, 10], 'equal', 5)).toEqual([2, 4, 6, 8]);
    expect(computeBreaks([10, 20], 'equal', 2)).toEqual([15]);
  });

  it('does not depend on the order or the count of values', () => {
    expect(computeBreaks([9, 1, 5, 1, 9], 'equal', 4)).toEqual([3, 5, 7]);
  });

  it('gives no break for one class', () => {
    expect(computeBreaks([1, 2, 3], 'equal', 1)).toEqual([]);
  });
});

describe('computeBreaks: quantile', () => {
  it('starts each class at the value at index floor(i * n / classes)', () => {
    const values = range(1, 10);
    expect(computeBreaks(values, 'quantile', 2)).toEqual([6]);
    expect(computeBreaks(values, 'quantile', 5)).toEqual([3, 5, 7, 9]);
    expect(computeBreaks(values, 'quantile', 4)).toEqual([3, 6, 8]);
  });

  it('gives classes of about equal size under the break rule (>= break starts the next class)', () => {
    const values = range(1, 100);
    const breaks = computeBreaks(values, 'quantile', 4);
    expect(breaks).toEqual([26, 51, 76]);
    const sizes = [0, 1, 2, 3].map((k) => values.filter((v) => (k === 0 || v >= breaks[k - 1]) && (k === 3 || v < breaks[k])).length);
    expect(sizes).toEqual([25, 25, 25, 25]);
  });

  it('sorts the values itself', () => {
    expect(computeBreaks([10, 1, 9, 2, 8, 3, 7, 4, 6, 5], 'quantile', 2)).toEqual([6]);
  });

  it('moves a break that ties repeat up to the next larger value, and never repeats one', () => {
    expect(computeBreaks([1, 1, 1, 1, 1, 1, 2, 3], 'quantile', 4)).toEqual([2, 3]);
    expect(computeBreaks([1, 1, 1, 2, 2, 2], 'quantile', 3)).toEqual([2]);
  });

  it('keeps several classes for skewed data with many equal values', () => {
    const zeros = [...Array.from({ length: 90 }, () => 0), ...range(1, 10)];
    const breaks = computeBreaks(zeros, 'quantile', 5);
    expect(breaks).toEqual([1, 2, 3, 4]);
    expect(computeBreaks([...Array.from({ length: 9 }, () => 1), 100], 'quantile', 2)).toEqual([100]);
    expect(computeBreaks([...Array.from({ length: 9 }, () => 1), 100], 'quantile', 5)).toEqual([100]);
  });
});

describe('computeBreaks: edge cases', () => {
  it.each(['quantile', 'equal'] as const)('%s: ignores non-finite values', (method) => {
    const clean = [1, 2, 3, 4, 5, 6];
    const dirty = [Number.NaN, 1, Number.POSITIVE_INFINITY, 2, 3, Number.NEGATIVE_INFINITY, 4, 5, 6];
    expect(computeBreaks(dirty, method, 3)).toEqual(computeBreaks(clean, method, 3));
  });

  it.each(['quantile', 'equal'] as const)('%s: gives no break for no values or all values equal', (method) => {
    expect(computeBreaks([], method, 5)).toEqual([]);
    expect(computeBreaks([Number.NaN], method, 5)).toEqual([]);
    expect(computeBreaks([7], method, 5)).toEqual([]);
    expect(computeBreaks([7, 7, 7, 7], method, 5)).toEqual([]);
  });

  it('gives fewer breaks than classes - 1 for fewer distinct values than classes', () => {
    expect(computeBreaks([1, 2, 2, 2, 1, 1], 'quantile', 5)).toEqual([2]);
    expect(computeBreaks([5, 5, 5, 9, 9, 9, 9], 'quantile', 4)).toEqual([9]);
    expect(computeBreaks([1, 2, 3], 'quantile', 9)).toEqual([2, 3]);
  });

  it.each(['quantile', 'equal'] as const)('%s: breaks are ascending, unique and at most classes - 1', (method) => {
    const values = [3, 3, 3, 8, 1, 1, 4, 4, 4, 4, 100, 2, 2];
    for (let classes = 2; classes <= 9; classes++) {
      const breaks = computeBreaks(values, method, classes);
      expect(breaks.length).toBeLessThanOrEqual(classes - 1);
      expect(breaks).toEqual([...new Set(breaks)].sort((a, b) => a - b));
    }
  });

  it('does not change its input', () => {
    const values = [5, 3, Number.NaN, 9, 1];
    const copy = [...values];
    computeBreaks(values, 'quantile', 3);
    computeBreaks(values, 'equal', 3);
    expect(values).toEqual(copy);
    const frozen = Object.freeze([5, 3, 9, 1]);
    expect(() => computeBreaks(frozen, 'quantile', 2)).not.toThrow();
  });
});
