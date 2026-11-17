import { queryConfig } from '../../../shared/config';
import { toolError, type ToolError } from '../../../shared/toolProtocol';
import { firstLineWithoutUrls } from './errors';
import { restartedMessage } from './registry';

const timeoutHint = 'Filter, aggregate or simplify the query.';
export const unavailableMessage = 'The data engine is not ready.';
export const sessionResetMessage = 'The data engine was restarted; run the query again.';
const unknownSqlErrorMessage = 'The query failed.';

const hintRules: readonly (readonly [RegExp, string])[] = [
  [/^Catalog Error/, 'Use only the views and the allowed functions.'],
  [/^Binder Error.*(column|not found)/i, 'Check the column names in the catalog.'],
  [/^Conversion Error/, 'Check the types; cast explicitly.']
];

export type FailedResult = { ok: false; error: ToolError };

function messageOf(error: Error | string): string {
  return typeof error === 'string' ? error : error.message;
}

/** A DuckDB error as `SQL_ERROR`: its first line (no URL, cut short), and a hint for the usual mistakes. */
export function sqlError(error: Error | string): FailedResult {
  const message = firstLineWithoutUrls(messageOf(error), queryConfig.maxErrorChars) ?? unknownSqlErrorMessage;
  const hint = hintRules.find(([pattern]) => pattern.test(message))?.[1];
  return toolError('SQL_ERROR', message, hint);
}

export function timeoutError(timeoutMs: number): FailedResult {
  return toolError('TIMEOUT', `The query took longer than ${timeoutMs / 1000} s.`, timeoutHint);
}

export function unavailableError(): FailedResult {
  return toolError('ENGINE_UNAVAILABLE', unavailableMessage);
}

export function sessionResetError(): FailedResult {
  return toolError('SESSION_RESET', sessionResetMessage);
}

/** A failure while the views were being registered: the engine restarted under it, or the data could not be loaded. */
export function viewsError(error: Error | string): FailedResult {
  const message = messageOf(error);
  if (message === restartedMessage) return sessionResetError();
  const reason = firstLineWithoutUrls(message, queryConfig.maxErrorChars);
  return toolError('ENGINE_UNAVAILABLE', reason === undefined ? 'The data could not be loaded.' : `The data could not be loaded: ${reason}`);
}
