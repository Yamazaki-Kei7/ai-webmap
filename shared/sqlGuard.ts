/**
 * SQL guard: checks the SQL the LLM writes before DuckDB-WASM runs it (backend tool handler and browser, both).
 *
 * `SET lock_configuration = true` does not stop LOAD, INSTALL, reading external URLs or COPY ... TO, and
 * `enable_external_access = false` would also block the registered file buffers. So this guard is the main
 * defence against reading outside data and changing the in-browser database. False positives are acceptable,
 * false negatives are not.
 */

import { queryConfig } from './config.js';
import { allowedFunctions, parenthesisKeywords } from './sqlFunctions.js';

export type SqlGuardResult = { ok: true; sql: string; tables: string[] } | { ok: false; reason: string };

/** Words that may not appear in the code (whole words, outside comments, literals and quoted identifiers). `OR REPLACE` is checked apart: plain `replace(...)` is a string function. */
export const forbiddenKeywords: readonly string[] = [
  'INSERT',
  'UPDATE',
  'DELETE',
  'MERGE',
  'UPSERT',
  'CREATE',
  'DROP',
  'ALTER',
  'TRUNCATE',
  'ATTACH',
  'DETACH',
  'COPY',
  'EXPORT',
  'IMPORT',
  'INSTALL',
  'LOAD',
  'SET',
  'RESET',
  'PRAGMA',
  'CALL',
  'USE',
  'CHECKPOINT',
  'VACUUM',
  'BEGIN',
  'COMMIT',
  'ROLLBACK',
  'TRANSACTION',
  'PREPARE',
  'EXECUTE',
  'DEALLOCATE'
];

/** `REPLACE` is forbidden only right after `OR`. */
export const orReplaceWords = { first: 'OR', second: 'REPLACE' } as const;

/** Identifiers (also inside double quotes) that read outside data or the catalog, compared in lower case. */
export const forbiddenFunctionNames: readonly string[] = [
  'glob',
  'query',
  'query_table',
  'sniff_csv',
  'st_read',
  'st_read_meta',
  'st_readosm',
  'st_drivers',
  'load_extension',
  'getenv',
  'st_transform',
  'json_execute_serialized_sql',
  'json_serialize_sql',
  'json_deserialize_sql',
  'enable_logging',
  'disable_logging',
  'truncate_duckdb_logs',
  'checkpoint',
  'force_checkpoint',
  'arrow_scan_dumb',
  'which_secret',
  'sql_auto_complete',
  'check_peg_parser',
  'test_all_types',
  'test_vector_types'
];

/** Prefixes and suffixes of forbidden identifiers (lower case). Second layer: a call must also be in the allow list (`sqlFunctions.ts`). */
export const forbiddenFunctionAffixes = {
  prefixes: ['read_', 'parquet_', 'duckdb_', 'iceberg_', 'delta_', 'pragma_', 'st_read'],
  suffixes: ['_scan', '_query', '_sql']
} as const;

/** A literal or quoted name that looks like a URL, path or file name: a `/`, `\` or `?`, a dot and a letter (`.csv`, `../`), or a leading `~`. */
const dataReferencePattern = /[/\\?]|\.[A-Za-z]|^\s*~/;

/** Longest function name a rejection reason repeats. */
const maxNameChars = 64;

const allowedFunctionSet = new Set([...allowedFunctions, ...parenthesisKeywords]);

const messages = {
  empty: 'The SQL is empty.',
  oneStatement: 'Only one SELECT or WITH statement is allowed.',
  startWord: 'The statement must start with SELECT or WITH.',
  unterminatedComment: 'The SQL has a comment that is not closed.',
  unterminatedString: 'The SQL has a string literal that is not closed.',
  unterminatedQuoted: 'The SQL has a quoted identifier that is not closed.',
  dollar: 'Dollar signs are not allowed; use single-quoted strings.',
  adjacentStrings: 'Adjacent string literals are not allowed.',
  quotedFunction: 'Quoted function names are not allowed.',
  escapeSequence: 'Escape sequences such as \\x, \\u or octal are not allowed in E strings.',
  unicodeSpace: 'Only ASCII white space is allowed between words.',
  numberThenName: 'A number may not be followed directly by a name.',
  dataReference: 'String literals and quoted names may not contain paths, URLs or file names.'
} as const;

type TokenKind = 'space' | 'comment' | 'word' | 'number' | 'string' | 'quoted' | 'punct';

/** `text` is the source text; `value` is the content of a word, literal or quoted identifier (quotes removed, escapes resolved). */
type Token = { kind: TokenKind; text: string; value: string };

type Scan = { token: Token; end: number } | { error: string };

// Identifiers as DuckDB's scanner reads them: ASCII letter, `_` or any non-ASCII character that is not white space or a format character, then also digits and `$`.
const wordPattern = /(?:[A-Za-z_]|[^\x00-\x7F\s\p{Cf}\p{Z}])(?:[A-Za-z_0-9$]|[^\x00-\x7F\s\p{Cf}\p{Z}])*/uy;
const identifierStart = /[A-Za-z_]|[^\x00-\x7F\s\p{Cf}\p{Z}]/uy;
const numberPattern = /(?:[0-9][0-9_]*(?:\.[0-9_]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/y;
/** The only white space allowed in code. DuckDB and JavaScript disagree about the other Unicode white space and format characters, so they are rejected. */
const asciiSpacePattern = /[ \t\n\r\f\v]+/y;
const otherSpacePattern = /[\s\p{Cf}\p{Z}]/uy;
const lineEndPattern = /[\r\n]/;
const octalOrHexEscape = /[xuU0-7]/;

/** Escapes of an E string that stand for white space (the others stand for the next character itself). */
const spaceEscapes = 'ntrbf';

function matchAt(pattern: RegExp, sql: string, index: number): string | null {
  pattern.lastIndex = index;
  const match = pattern.exec(sql);
  return match === null ? null : match[0];
}

function makeScan(kind: TokenKind, sql: string, start: number, end: number, value: string): Scan {
  return { token: { kind, text: sql.slice(start, end), value }, end };
}

function scanLineComment(sql: string, start: number): Scan {
  const end = sql.slice(start).search(lineEndPattern);
  return makeScan('comment', sql, start, end === -1 ? sql.length : start + end, '');
}

/** Block comments nest, as in DuckDB. */
function scanBlockComment(sql: string, start: number): Scan {
  let depth = 0;
  let index = start;
  while (index < sql.length) {
    const pair = sql.slice(index, index + 2);
    if (pair === '/*') {
      depth += 1;
      index += 2;
    } else if (pair === '*/') {
      depth -= 1;
      index += 2;
      if (depth === 0) return makeScan('comment', sql, start, index, '');
    } else {
      index += 1;
    }
  }
  return { error: messages.unterminatedComment };
}

/** Scans `'...'` or `"..."` from the opening quote. A doubled quote is an escaped quote; `backslashEscapes` is for E strings. */
function scanQuoted(sql: string, start: number, backslashEscapes: boolean, textStart: number = start): Scan {
  const quote = sql[start];
  const kind: TokenKind = quote === '"' ? 'quoted' : 'string';
  const unterminated = kind === 'quoted' ? messages.unterminatedQuoted : messages.unterminatedString;
  let value = '';
  let index = start + 1;
  while (index < sql.length) {
    const char = sql[index];
    if (backslashEscapes && char === '\\') {
      const next = sql[index + 1];
      if (next === undefined) return { error: unterminated };
      if (octalOrHexEscape.test(next)) return { error: messages.escapeSequence };
      value += spaceEscapes.includes(next) ? ' ' : next;
      index += 2;
    } else if (char === quote) {
      if (sql[index + 1] !== quote) return makeScan(kind, sql, textStart, index + 1, value);
      value += quote;
      index += 2;
    } else {
      value += char;
      index += 1;
    }
  }
  return { error: unterminated };
}

function isEscapePrefix(word: string): boolean {
  return word === 'E' || word === 'e';
}

function scanToken(sql: string, start: number): Scan {
  const char = sql[start];
  const next = sql[start + 1];
  if (char === '-' && next === '-') return scanLineComment(sql, start);
  if (char === '/' && next === '*') return scanBlockComment(sql, start);
  if (char === "'") return scanQuoted(sql, start, false);
  if (char === '"') return scanQuoted(sql, start, false);
  if (char === '$') return { error: messages.dollar };
  const space = matchAt(asciiSpacePattern, sql, start);
  if (space !== null) return makeScan('space', sql, start, start + space.length, space);
  if (matchAt(otherSpacePattern, sql, start) !== null) return { error: messages.unicodeSpace };
  const number = matchAt(numberPattern, sql, start);
  if (number !== null) {
    if (matchAt(identifierStart, sql, start + number.length) !== null) return { error: messages.numberThenName };
    return makeScan('number', sql, start, start + number.length, number);
  }
  const word = matchAt(wordPattern, sql, start);
  if (word !== null) {
    if (word.includes('$')) return { error: messages.dollar };
    const end = start + word.length;
    if (isEscapePrefix(word) && sql[end] === "'") return scanQuoted(sql, end, true, start);
    return makeScan('word', sql, start, end, word);
  }
  return makeScan('punct', sql, start, start + 1, char);
}

/** Splits the SQL once, left to right, into tokens. The token texts joined give the SQL back. */
function lex(sql: string): Token[] | { error: string } {
  const tokens: Token[] = [];
  let index = 0;
  while (index < sql.length) {
    const scan = scanToken(sql, index);
    if ('error' in scan) return scan;
    tokens.push(scan.token);
    index = scan.end;
  }
  return tokens;
}

function isCode(token: Token): boolean {
  return token.kind !== 'space' && token.kind !== 'comment';
}

function isWord(token: Token | undefined, upper: string): boolean {
  return token !== undefined && token.kind === 'word' && token.value.toUpperCase() === upper;
}

function isSemicolon(token: Token): boolean {
  return token.kind === 'punct' && token.value === ';';
}

/** At most one `;`, and only as the last code token. */
function hasOnlyOneStatement(code: readonly Token[]): boolean {
  return code.every((token, index) => !isSemicolon(token) || index === code.length - 1);
}

function findForbiddenKeyword(code: readonly Token[]): string | null {
  for (const [index, token] of code.entries()) {
    if (token.kind !== 'word') continue;
    const upper = token.value.toUpperCase();
    if (forbiddenKeywords.includes(upper)) return upper;
    if (upper === orReplaceWords.second && isWord(code[index - 1], orReplaceWords.first)) {
      return `${orReplaceWords.first} ${orReplaceWords.second}`;
    }
  }
  return null;
}

/** Returns what to name in the rejection (the name, or the prefix / suffix pattern), or null if the identifier is allowed. */
function matchForbiddenName(identifier: string): string | null {
  const lower = identifier.toLowerCase();
  if (forbiddenFunctionNames.includes(lower)) return lower;
  const prefix = forbiddenFunctionAffixes.prefixes.find((candidate) => lower.startsWith(candidate));
  if (prefix !== undefined) return `${prefix}...`;
  const suffix = forbiddenFunctionAffixes.suffixes.find((candidate) => lower.endsWith(candidate));
  if (suffix !== undefined) return `...${suffix}`;
  return null;
}

function findForbiddenName(code: readonly Token[]): string | null {
  for (const token of code) {
    if (token.kind !== 'word' && token.kind !== 'quoted') continue;
    const name = matchForbiddenName(token.value);
    if (name !== null) return name;
  }
  return null;
}

function findDataReference(code: readonly Token[]): string | null {
  const points = code.some((token) => (token.kind === 'string' || token.kind === 'quoted') && dataReferencePattern.test(token.value));
  return points ? messages.dataReference : null;
}

/** DuckDB joins two string literals that only white space or comments separate. */
function hasAdjacentStrings(code: readonly Token[]): boolean {
  return code.some((token, index) => token.kind === 'string' && code[index + 1]?.kind === 'string');
}

/** A word or quoted name directly before `(` is a call: the name must be in the allow list. */
function findDisallowedCall(code: readonly Token[]): string | null {
  for (const [index, token] of code.entries()) {
    const next = code[index + 1];
    if (next === undefined || next.kind !== 'punct' || next.value !== '(') continue;
    if (token.kind === 'quoted') return messages.quotedFunction;
    if (token.kind === 'word' && !allowedFunctionSet.has(token.value.toLowerCase())) {
      return notAllowedName(token.value);
    }
  }
  return null;
}

/** The known views the SQL names, unique, in the order of `knownTables`. */
function referencedTables(code: readonly Token[], knownTables: readonly string[]): string[] {
  const referenced = (table: string): boolean =>
    code.some((token) => {
      if (token.kind === 'word') return token.value.toLowerCase() === table.toLowerCase();
      return token.kind === 'quoted' && token.value === table;
    });
  return [...new Set(knownTables)].filter(referenced);
}

/** Comments become one space; one trailing `;` goes; the result is trimmed, so it can be wrapped as a subquery. */
function cleanedSql(tokens: readonly Token[], code: readonly Token[]): string {
  const last = code[code.length - 1];
  const dropped = last !== undefined && isSemicolon(last) ? last : null;
  return tokens
    .map((token) => (token.kind === 'comment' ? ' ' : token === dropped ? '' : token.text))
    .join('')
    .trim();
}

function notAllowedName(name: string): string {
  return `The function or name ${name.slice(0, maxNameChars)} is not allowed; use the views and the allowed functions.`;
}

function deny(reason: string): SqlGuardResult {
  return { ok: false, reason };
}

/**
 * Checks `sql` and returns the cleaned statement. Callers must execute `result.sql`, never the input: the guard
 * and DuckDB may read the input differently, but the returned text is rebuilt from the tokens the guard checked.
 */
export function validateSql(sql: string, knownTables: readonly string[]): SqlGuardResult {
  if (sql.trim() === '') return deny(messages.empty);
  if (sql.length > queryConfig.maxSqlChars) return deny(`The SQL is longer than ${queryConfig.maxSqlChars} characters.`);

  const tokens = lex(sql);
  if ('error' in tokens) return deny(tokens.error);
  const code = tokens.filter(isCode);

  if (!hasOnlyOneStatement(code)) return deny(messages.oneStatement);
  if (!isWord(code[0], 'SELECT') && !isWord(code[0], 'WITH')) return deny(messages.startWord);

  const keyword = findForbiddenKeyword(code);
  if (keyword !== null) return deny(`The keyword ${keyword} is not allowed.`);

  const name = findForbiddenName(code);
  if (name !== null) {
    return deny(notAllowedName(name));
  }

  const dataReference = findDataReference(code);
  if (dataReference !== null) return deny(dataReference);
  if (hasAdjacentStrings(code)) return deny(messages.adjacentStrings);

  const call = findDisallowedCall(code);
  if (call !== null) return deny(call);

  return { ok: true, sql: cleanedSql(tokens, code), tables: referencedTables(code, knownTables) };
}
