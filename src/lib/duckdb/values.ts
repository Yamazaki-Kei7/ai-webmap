import type { ColumnInfo, JsonValue } from './queryTypes';

/** What a column holds, as far as the conversion of its values and the model's `ColumnInfo` are concerned. */
export type CellKind = 'integer' | 'float' | 'decimal' | 'string' | 'boolean' | 'date' | 'timestamp' | 'timestamptz' | 'other';

/** A column of a result: `scale` is the decimal places of a `decimal`, else 0. */
export type ColumnShape = { name: string; kind: CellKind; scale: number };

/** The part of an Arrow `DataType` that is read (its `toString()` names the type, e.g. `Int64`, `Decimal[18e+3]`, `Timestamp<MICROSECOND>`). */
export type ArrowTypeLike = { toString: () => string; scale?: number };

/** A value as Arrow returns it: number, bigint, string, boolean, null, or an object (a decimal, a blob, a list, ...). */
export type RawCell = string | number | bigint | boolean | null | undefined | object;

const kindPatterns: readonly (readonly [RegExp, CellKind])[] = [
  [/^(Int|Uint)\d+$/, 'integer'],
  [/^Float\d+$/, 'float'],
  [/^Decimal\b/, 'decimal'],
  [/^(Large)?Utf8$/, 'string'],
  [/^Bool$/, 'boolean'],
  [/^Date\d*\b/, 'date'],
  // `Timestamp<MICROSECOND, UTC>`: with a time zone (TIMESTAMPTZ).
  [/^Timestamp<[^>,]*,/, 'timestamptz'],
  [/^Timestamp\b/, 'timestamp']
];

export function cellKindOf(typeName: string): CellKind {
  return kindPatterns.find(([pattern]) => pattern.test(typeName))?.[1] ?? 'other';
}

export function shapeOf(name: string, type: ArrowTypeLike): ColumnShape {
  const kind = cellKindOf(type.toString());
  return { name, kind, scale: kind === 'decimal' ? (type.scale ?? 0) : 0 };
}

const columnTypes: Record<CellKind, ColumnInfo['type']> = {
  integer: 'number',
  float: 'number',
  decimal: 'number',
  string: 'string',
  boolean: 'boolean',
  date: 'other',
  timestamp: 'other',
  timestamptz: 'other',
  other: 'other'
};

/** The type the model sees of a column. */
export function columnTypeOf(kind: CellKind): ColumnInfo['type'] {
  return columnTypes[kind];
}

export function columnInfoOf(shape: ColumnShape): ColumnInfo {
  return { name: shape.name, type: columnTypeOf(shape.kind) };
}

const decimalText = /^(-?)(\d+)$/;

/** An integer given as text: a number when it is exact, else the digits. */
function integerValue(digits: string): number | string {
  const value = BigInt(digits);
  return value >= BigInt(-Number.MAX_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : digits;
}

/** `unscaled` (the integer text of a decimal) with `scale` decimal places, as a number. */
function decimalValue(unscaled: string, scale: number): JsonValue {
  const match = decimalText.exec(unscaled);
  if (match === null) return unscaled;
  if (scale === 0) return integerValue(unscaled);
  const digits = match[2].padStart(scale + 1, '0');
  return Number(`${match[1]}${digits.slice(0, -scale)}.${digits.slice(-scale)}`);
}

function numberValue(value: number): JsonValue {
  return Number.isFinite(value) ? value : String(value);
}

/** A date as `YYYY-MM-DD`; a TIMESTAMP as ISO 8601 with no zone (it has none); a TIMESTAMPTZ as UTC with `Z`. Arrow gives milliseconds. */
function timeValue(ms: number, kind: CellKind): JsonValue {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return String(ms);
  const iso = date.toISOString();
  if (kind === 'date') return iso.slice(0, 10);
  return kind === 'timestamp' ? iso.slice(0, -1) : iso;
}

const isTimeKind = (kind: CellKind): boolean => kind === 'date' || kind === 'timestamp' || kind === 'timestamptz';

/** One value as JSON: wide integers within the safe range become numbers (else digits), decimals numbers, dates ISO 8601 text, NULL null, anything unknown text. */
export function convertCell(raw: RawCell, shape: ColumnShape): JsonValue {
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'boolean') return raw;
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'bigint') return shape.kind === 'integer' ? integerValue(raw.toString()) : String(raw);
  if (typeof raw === 'number') return isTimeKind(shape.kind) ? timeValue(raw, shape.kind) : numberValue(raw);
  if (shape.kind === 'decimal') return decimalValue(String(raw), shape.scale);
  if (raw instanceof Date) return timeValue(raw.getTime(), isTimeKind(shape.kind) ? shape.kind : 'timestamptz');
  return String(raw);
}
