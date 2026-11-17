import { describe, expect, it } from 'vitest';
import { cellKindOf, columnInfoOf, columnTypeOf, convertCell, shapeOf, type ColumnShape } from './values';

const shape = (kind: ColumnShape['kind'], scale = 0): ColumnShape => ({ name: 'c', kind, scale });

describe('cellKindOf / columnTypeOf', () => {
  it('maps the Arrow type names of DuckDB columns', () => {
    const expected: [string, string, string][] = [
      ['Int8', 'integer', 'number'],
      ['Int32', 'integer', 'number'],
      ['Int64', 'integer', 'number'],
      ['Uint16', 'integer', 'number'],
      ['Float32', 'float', 'number'],
      ['Float64', 'float', 'number'],
      ['Decimal[18e+3]', 'decimal', 'number'],
      ['Utf8', 'string', 'string'],
      ['LargeUtf8', 'string', 'string'],
      ['Bool', 'boolean', 'boolean'],
      ['Date32<DAY>', 'date', 'other'],
      ['Timestamp<MICROSECOND>', 'timestamp', 'other'],
      ['Timestamp<MICROSECOND, UTC>', 'timestamptz', 'other'],
      ['Time64<MICROSECOND>', 'other', 'other'],
      ['Binary', 'other', 'other'],
      ['Dictionary<Int8, Utf8>', 'other', 'other'],
      ['List<Int8>', 'other', 'other']
    ];
    for (const [typeName, kind, type] of expected) {
      expect(cellKindOf(typeName), typeName).toBe(kind);
      expect(columnTypeOf(cellKindOf(typeName)), typeName).toBe(type);
    }
  });

  it('reads the scale of a decimal only', () => {
    expect(shapeOf('price', { toString: () => 'Decimal[18e+3]', scale: 3 })).toEqual({ name: 'price', kind: 'decimal', scale: 3 });
    expect(shapeOf('n', { toString: () => 'Int32', scale: 7 })).toEqual({ name: 'n', kind: 'integer', scale: 0 });
    expect(columnInfoOf(shapeOf('name', { toString: () => 'Utf8' }))).toEqual({ name: 'name', type: 'string' });
  });
});

describe('convertCell', () => {
  it('keeps booleans and strings, and makes NULL null', () => {
    expect(convertCell(true, shape('boolean'))).toBe(true);
    expect(convertCell(false, shape('boolean'))).toBe(false);
    expect(convertCell('x', shape('string'))).toBe('x');
    expect(convertCell(null, shape('string'))).toBeNull();
    expect(convertCell(undefined, shape('integer'))).toBeNull();
  });

  it('makes a BIGINT a number when it is safe, else its digits', () => {
    expect(convertCell(42n, shape('integer'))).toBe(42);
    expect(convertCell(-7n, shape('integer'))).toBe(-7);
    expect(convertCell(BigInt(Number.MAX_SAFE_INTEGER), shape('integer'))).toBe(Number.MAX_SAFE_INTEGER);
    expect(convertCell(BigInt(Number.MAX_SAFE_INTEGER) + 1n, shape('integer'))).toBe('9007199254740992');
    expect(convertCell(-(BigInt(Number.MAX_SAFE_INTEGER) + 1n), shape('integer'))).toBe('-9007199254740992');
  });

  it('keeps numbers, and writes a value JSON cannot hold as text', () => {
    expect(convertCell(1.5, shape('float'))).toBe(1.5);
    expect(convertCell(Number.NaN, shape('float'))).toBe('NaN');
    expect(convertCell(Number.POSITIVE_INFINITY, shape('float'))).toBe('Infinity');
  });

  it('makes a DECIMAL a number with its scale; a HUGEINT (scale 0) like a BIGINT', () => {
    expect(convertCell({ toString: () => '12345' }, shape('decimal', 3))).toBe(12.345);
    expect(convertCell({ toString: () => '-12345' }, shape('decimal', 3))).toBe(-12.345);
    expect(convertCell({ toString: () => '5' }, shape('decimal', 3))).toBe(0.005);
    expect(convertCell({ toString: () => '-5' }, shape('decimal', 2))).toBe(-0.05);
    expect(convertCell({ toString: () => '0' }, shape('decimal', 2))).toBe(0);
    expect(convertCell({ toString: () => '17' }, shape('decimal'))).toBe(17);
    expect(convertCell({ toString: () => '18446744073709551616' }, shape('decimal'))).toBe('18446744073709551616');
    expect(convertCell({ toString: () => 'nope' }, shape('decimal', 2))).toBe('nope');
  });

  it('writes a date as YYYY-MM-DD, a TIMESTAMP as ISO 8601 without a zone and a TIMESTAMPTZ with Z', async () => {
    expect(convertCell(Date.UTC(2024, 2, 5), shape('date'))).toBe('2024-03-05');
    expect(convertCell(Date.UTC(2024, 2, 5, 10, 20, 30, 456), shape('timestamp'))).toBe('2024-03-05T10:20:30.456');
    expect(convertCell(Date.UTC(2024, 2, 5, 10, 20, 30, 456), shape('timestamptz'))).toBe('2024-03-05T10:20:30.456Z');
    expect(convertCell(new Date(Date.UTC(2020, 0, 2, 3)), shape('timestamp'))).toBe('2020-01-02T03:00:00.000');
    expect(convertCell(new Date(Date.UTC(2020, 0, 2, 3)), shape('timestamptz'))).toBe('2020-01-02T03:00:00.000Z');
    expect(convertCell(new Date(Date.UTC(2020, 0, 2, 3)), shape('date'))).toBe('2020-01-02');
    expect(convertCell(1e20, shape('timestamp'))).toBe('100000000000000000000');
  });

  it('writes a bigint of a column that is not an integer (a TIME, microseconds) as digits, never as a number', () => {
    expect(convertCell(45296000000n, shape('other'))).toBe('45296000000');
  });

  it('writes anything else as text (a blob, a list, a struct)', () => {
    expect(convertCell(new Uint8Array([1, 2, 3]), shape('other'))).toBe('1,2,3');
    expect(convertCell({ toString: () => '[1,2]' }, shape('other'))).toBe('[1,2]');
    expect(convertCell(12, shape('other'))).toBe(12);
  });
});
