import { chatConfig } from '../../../shared/config';
import type { ToolErrorCode, ToolName } from '../../../shared/toolProtocol';
import type { EngineStatus } from '../duckdb/engineCore';
import { notAllowedUiMessage } from '../duckdb/errors';
import { restoreProgressText } from '../map/savedMaps';

/** What the chat panel needs of the data engine: whether it can be used, is coming, or is out of reach (and for whom the retry is no help). */
export type ChatEngineState = 'ready' | 'loading' | 'failed' | 'denied';

export function chatEngineState(status: EngineStatus): ChatEngineState {
  switch (status.state) {
    case 'ready':
      return 'ready';
    case 'error':
      return status.message === notAllowedUiMessage ? 'denied' : 'failed';
    case 'idle':
    case 'loading':
      return 'loading';
  }
}

/** Why the input is disabled, or null when it is not. */
export type InputBlock = 'denied' | 'failed' | 'loading' | 'restoring' | 'busy';

/** The reason the chat cannot take a message now: the engine first (nothing works without it), then a map being rebuilt (the conversation is about it), then the running turn. */
export function inputBlock(engine: ChatEngineState, busy: boolean, restoring = false): InputBlock | null {
  if (engine !== 'ready') return engine;
  if (restoring) return 'restoring';
  return busy ? 'busy' : null;
}

/** The line shown with a disabled input (`progress`: how far the map being rebuilt is); the failure and the refusal have their own banner. */
export function inputBlockText(block: InputBlock, progress?: { done: number; total: number } | null): string | null {
  switch (block) {
    case 'loading':
      return chatConfig.text.engineLoading;
    case 'busy':
      return chatConfig.text.working;
    case 'restoring':
      return progress ? restoreProgressText(progress) : null;
    case 'denied':
    case 'failed':
      return null;
  }
}

/** The length of a message as the server counts it: in Unicode code points, so an emoji is one. */
export const utteranceLength = (text: string): number => [...text].length;

export function canSend(text: string, maxChars: number): boolean {
  const length = draftLength(text);
  return length > 0 && length <= maxChars;
}

export type EnterKey = { key: string; shiftKey: boolean; isComposing: boolean; keyCode: number };

/** Enter sends; Shift+Enter is a newline, and the Enter that confirms an IME composition is not a send (`keyCode` 229 is the IME's own key in browsers that clear `isComposing` first). */
export function isSendKey({ key, shiftKey, isComposing, keyCode }: EnterKey): boolean {
  return key === 'Enter' && !shiftKey && !isComposing && keyCode !== chatConfig.imeProcessKeyCode;
}

export type ScrollPosition = { scrollTop: number; clientHeight: number; scrollHeight: number };

/** The list follows new text only while the reader is at (or within the threshold of) the bottom. */
export function isNearBottom({ scrollTop, clientHeight, scrollHeight }: ScrollPosition): boolean {
  return scrollHeight - (scrollTop + clientHeight) <= chatConfig.autoScrollThresholdPx;
}

export type ToolActivityState = 'running' | 'done' | 'failed';

/** The line of a tool call; a failed one says why (`code`) in words. */
export function activityText(tool: ToolName, state: ToolActivityState, code?: ToolErrorCode): string {
  const phrase = chatConfig.text.activity[tool][state];
  if (state !== 'failed' || code === undefined) return phrase;
  const [open, close] = chatConfig.text.toolErrorWrap;
  return `${phrase}${open}${chatConfig.text.toolErrorCodes[code]}${close}`;
}

/** The length the counter and the send check share: the trimmed message, in code points. */
export const draftLength = (draft: string): number => utteranceLength(draft.trim());

/**
 * The end of a turn may bring the focus back to the input only when nothing else has it: it is lost (a disabled textarea
 * drops it, which leaves `body` or nothing) or it is inside the chat panel. Never from where the user moved it.
 */
export function mayRestoreFocus(active: Element | null, body: Element, panel: Element | undefined): boolean {
  return active === null || active === body || (panel?.contains(active) ?? false);
}
