import { ApiError } from '@aws-blocks/blocks/client';
import { accessStatus } from '../../../shared/access';
import { engineConfig } from '../../../shared/config';

export const notAllowedUiMessage = 'このアカウントはデータを利用できません（許可リストにありません）';
export const initTimeoutMessage = 'データエンジンの起動がタイムアウトしました';
export const workerFailureMessage = 'データエンジンのワーカーでエラーが起きました';
const unknownFailureMessage = '原因不明のエラーです';
const urlPattern = /https?:\/\/\S+/g;
const urlPlaceholder = '[URL]';

/** A short, one-line message for the UI: no URL (so no signed query string), no stack. */
export function describeEngineError(error: Error | string): string {
  if (error instanceof ApiError && error.status === accessStatus.forbidden) return notAllowedUiMessage;
  const text = typeof error === 'string' ? error : error.message;
  const firstLine = text.replace(urlPattern, urlPlaceholder).split('\n')[0].trim();
  if (firstLine === '') return unknownFailureMessage;
  return firstLine.length > engineConfig.maxErrorChars
    ? `${firstLine.slice(0, engineConfig.maxErrorChars)}…`
    : firstLine;
}

/** A retry cannot fix a refused account. */
export function isRetryableMessage(message: string): boolean {
  return message !== notAllowedUiMessage;
}
