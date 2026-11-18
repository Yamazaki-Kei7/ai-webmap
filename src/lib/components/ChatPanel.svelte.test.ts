import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chatConfig } from '../../../shared/config';
import type { EngineStatus } from '$lib/duckdb/engineCore';
import type { ChatSession, ToolActivity } from '$lib/chat/chatSession.svelte';

// The panel is mounted for real (jsdom); the session it is given is a stand-in whose state the tests set, and what the panel
// does with it (disabled input, Enter, the lines, the announcement, the focus) is read from the DOM.
type Fake = { messages: ChatSession['messages']; isLoading: boolean; activity: ToolActivity[]; error: string | null };
const fake: Fake = $state({ messages: [], isLoading: false, activity: [], error: null });
const send = vi.fn<ChatSession['send']>(async () => undefined);
const reset = vi.fn();

// The session is handed to the panel (the shell owns it).
const session: ChatSession = {
  get messages() {
    return fake.messages;
  },
  get isLoading() {
    return fake.isLoading;
  },
  get activity() {
    return fake.activity;
  },
  get error() {
    return fake.error;
  },
  conversationId: null,
  send,
  openConversation: async () => 'opened',
  reset,
  dispose: () => undefined
};
vi.mock('./narrowViewport', () => ({ narrowViewport: { current: false } }));

const { default: ChatPanel } = await import('./ChatPanel.svelte');

const ready: EngineStatus = { state: 'ready', duckdbVersion: 'x' };
const mounted: ReturnType<typeof mount>[] = [];

function render(engineStatus: EngineStatus = ready, restoring: { done: number; total: number } | null = null): HTMLElement {
  const target = document.createElement('div');
  document.body.append(target);
  mounted.push(mount(ChatPanel, { target, props: { engineStatus, session, owner: 'a', restoring, onRetry: () => undefined } }));
  flushSync();
  return target;
}

const byId = <T extends HTMLElement>(root: HTMLElement, id: string): T => {
  const element = root.querySelector<T>(`[data-testid=${id}]`);
  if (!element) throw new Error(`no ${id}`);
  return element;
};

function type(input: HTMLTextAreaElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
}

const enter = (init: KeyboardEventInit = {}): KeyboardEvent => new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, ...init });

afterEach(() => {
  for (const component of mounted.splice(0)) void unmount(component);
  document.body.replaceChildren();
  fake.messages = [];
  fake.isLoading = false;
  fake.activity = [];
  fake.error = null;
  send.mockClear();
  reset.mockClear();
});

describe('ChatPanel input', () => {
  it('sends on Enter, not on Shift+Enter, and not on the Enter of an IME composition', () => {
    const root = render();
    const input = byId<HTMLTextAreaElement>(root, 'chat-input');
    type(input, '学校を表示');

    input.dispatchEvent(enter({ shiftKey: true }));
    input.dispatchEvent(enter({ isComposing: true }));
    input.dispatchEvent(enter({ keyCode: chatConfig.imeProcessKeyCode }));
    expect(send).not.toHaveBeenCalled();

    const plain = enter();
    input.dispatchEvent(plain);
    expect(send).toHaveBeenCalledExactlyOnceWith('学校を表示');
    expect(plain.defaultPrevented).toBe(true);
  });

  it('is disabled, with the reason, while a turn runs', () => {
    fake.isLoading = true;
    const root = render();
    expect(byId<HTMLTextAreaElement>(root, 'chat-input').disabled).toBe(true);
    expect(byId(root, 'chat-block-reason').textContent).toBe(chatConfig.text.working);
  });

  it('is disabled, with the progress, while a saved map is rebuilt (even when no turn runs)', () => {
    const root = render(ready, { done: 1, total: 3 });
    expect(byId<HTMLTextAreaElement>(root, 'chat-input').disabled).toBe(true);
    expect(byId<HTMLButtonElement>(root, 'chat-send').disabled).toBe(true);
    expect(byId(root, 'chat-block-reason').textContent).toBe('地図を復元しています（1/3）');
    expect(byId<HTMLButtonElement>(root, 'chat-example').disabled).toBe(true);
  });

  it('is disabled while the engine starts, and for a refused account (with its message, and no send)', () => {
    const loading = render({ state: 'loading', step: 's' });
    expect(byId<HTMLTextAreaElement>(loading, 'chat-input').disabled).toBe(true);
    expect(byId(loading, 'chat-block-reason').textContent).toBe('データエンジンを準備しています');

    const denied = render({ state: 'error', message: 'このアカウントはデータを利用できません（許可リストにありません）' });
    expect(byId<HTMLTextAreaElement>(denied, 'chat-input').disabled).toBe(true);
    expect(byId(denied, 'chat-denied').textContent).toBe(chatConfig.text.notAllowed);
    expect(denied.querySelector('[data-testid=chat-engine-retry]')).toBeNull();
  });

  it('puts an example into the input', () => {
    const root = render();
    byId(root, 'chat-example').click();
    flushSync();
    expect(byId<HTMLTextAreaElement>(root, 'chat-input').value).toBe(chatConfig.text.examples[0]);
  });
});

describe('ChatPanel tool lines', () => {
  it('says why a failed call failed', () => {
    fake.activity = [
      { id: 'a', tool: 'runQuery', state: 'done' },
      { id: 'b', tool: 'addLayer', state: 'failed', code: 'TIMEOUT' }
    ];
    const root = render();
    const lines = [...byId(root, 'chat-activity').querySelectorAll('li')].map((line) => line.textContent?.replace(/\s+/g, ' ').trim());
    expect(lines).toEqual(['✓ クエリを実行しました', '✕ レイヤーの追加に失敗しました（時間切れ）']);
  });
});

describe('ChatPanel accessibility', () => {
  it('announces the finished reply only: not while it streams, and the list itself is not a live region', async () => {
    const root = render();
    expect(root.querySelector('[aria-live]')).toBeNull();
    fake.isLoading = true;
    fake.messages = [{ id: 'm1', role: 'assistant', content: '途中の' }];
    flushSync();
    expect(byId(root, 'chat-announcement').textContent).toBe('');

    fake.messages = [{ id: 'm1', role: 'assistant', content: '途中の文が終わりました' }];
    fake.isLoading = false;
    flushSync();
    await tick();
    expect(byId(root, 'chat-announcement').textContent).toBe('途中の文が終わりました');
  });

  it('clears the announcement before the next reply, so that an identical reply is announced again', async () => {
    const root = render();
    const reply = [{ id: 'm1', role: 'assistant' as const, content: '同じ返事' }];
    const finishTurn = async (): Promise<void> => {
      fake.isLoading = true;
      flushSync();
      fake.messages = reply;
      fake.isLoading = false;
      flushSync();
      await tick();
    };
    await finishTurn();
    expect(byId(root, 'chat-announcement').textContent).toBe('同じ返事');

    fake.isLoading = true;
    flushSync();
    fake.isLoading = false;
    flushSync();
    expect(byId(root, 'chat-announcement').textContent, 'cleared first').toBe('');
    await tick();
    expect(byId(root, 'chat-announcement').textContent).toBe('同じ返事');
  });

  it('returns the focus to the input after a turn, but not from where the user has moved it', () => {
    const root = render();
    const input = byId<HTMLTextAreaElement>(root, 'chat-input');
    const outside = document.createElement('button');
    document.body.append(outside);

    type(input, '一つ目');
    input.dispatchEvent(enter());
    fake.isLoading = true;
    flushSync();
    fake.isLoading = false;
    flushSync();
    expect(document.activeElement).toBe(input);

    type(input, '二つ目');
    input.dispatchEvent(enter());
    fake.isLoading = true;
    flushSync();
    outside.focus();
    fake.isLoading = false;
    flushSync();
    expect(document.activeElement).toBe(outside);
  });
});
