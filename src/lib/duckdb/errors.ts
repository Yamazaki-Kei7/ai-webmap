import { ApiError } from '@aws-blocks/blocks/client';
import { accessStatus } from '../../../shared/access';
import { engineConfig } from '../../../shared/config';

export const notAllowedUiMessage = 'このアカウントはデータを利用できません（許可リストにありません）';
export const initTimeoutMessage = 'データエンジンの起動がタイムアウトしました';
export const workerFailureMessage = 'データエンジンのワーカーでエラーが起きました';
const unknownFailureMessage = '原因不明のエラーです';
const urlPattern = /https?:\/\/\S+/g;
const urlPlaceholder = '[URL]';

/** The first line of a text with every URL (so every signed query string) replaced, cut at `maxChars`; undefined when nothing is left. */
export function firstLineWithoutUrls(text: string, maxChars: number): string | undefined {
  const firstLine = text.replace(urlPattern, urlPlaceholder).split('\n')[0].trim();
  if (firstLine === '') return undefined;
  return firstLine.length > maxChars ? `${firstLine.slice(0, maxChars)}…` : firstLine;
}

/** A short, one-line message for the UI: no URL (so no signed query string), no stack. */
export function describeEngineError(error: Error | string): string {
  if (error instanceof ApiError && error.status === accessStatus.forbidden) return notAllowedUiMessage;
  const text = typeof error === 'string' ? error : error.message;
  return firstLineWithoutUrls(text, engineConfig.maxErrorChars) ?? unknownFailureMessage;
}

/** A retry cannot fix a refused account. */
export function isRetryableMessage(message: string): boolean {
  return message !== notAllowedUiMessage;
}
