import { describe, expect, it } from 'vitest';
import { agentConfig, chatConfig } from '../../../shared/config';
import { toolNameSchema } from '../../../shared/toolProtocol';
import { notAllowedUiMessage } from '../duckdb/errors';
import { activityText, canSend, chatEngineState, draftLength, mayRestoreFocus, inputBlock, inputBlockText, isNearBottom, isSendKey, utteranceLength } from './chatPanelState';

describe('chatEngineState', () => {
  it('tells a refused account from a failure a retry may fix, and treats idle and loading as coming', () => {
    expect(chatEngineState({ state: 'ready', duckdbVersion: '1' })).toBe('ready');
    expect(chatEngineState({ state: 'loading', step: 'x' })).toBe('loading');
    expect(chatEngineState({ state: 'idle' })).toBe('loading');
    expect(chatEngineState({ state: 'error', message: 'timeout' })).toBe('failed');
    expect(chatEngineState({ state: 'error', message: notAllowedUiMessage })).toBe('denied');
  });
});

describe('inputBlock', () => {
  it('blocks for the engine before the running turn, and not at all when both are fine', () => {
    expect(inputBlock('ready', false)).toBeNull();
    expect(inputBlock('ready', true)).toBe('busy');
    expect(inputBlock('loading', true)).toBe('loading');
    expect(inputBlock('failed', false)).toBe('failed');
    expect(inputBlock('denied', false)).toBe('denied');
    expect(inputBlock('ready', false, true)).toBe('restoring');
    expect(inputBlock('ready', true, true)).toBe('restoring');
    expect(inputBlock('loading', false, true)).toBe('loading');
  });

  it('gives a reason line for loading and busy; the failure and the refusal are shown as banners', () => {
    expect(inputBlockText('loading')).toBe('データエンジンを準備しています');
    expect(inputBlockText('busy')).toBe(chatConfig.text.working);
    expect(inputBlockText('restoring', { done: 1, total: 3 })).toBe('地図を復元しています（1/3）');
    expect(inputBlockText('failed')).toBeNull();
    expect(inputBlockText('denied')).toBeNull();
  });
});

describe('the message length', () => {
  it('counts code points, not UTF-16 units', () => {
    expect(utteranceLength('駅')).toBe(1);
    expect(utteranceLength('😀😀')).toBe(2);
  });

  it('accepts a message that is not blank and not longer than the limit', () => {
    const max = agentConfig.maxUtteranceChars;
    expect(canSend('   ', max)).toBe(false);
    expect(canSend('駅', max)).toBe(true);
    expect(canSend('😀'.repeat(max), max)).toBe(true);
    expect(canSend('😀'.repeat(max + 1), max)).toBe(false);
  });
});

describe('isSendKey', () => {
  const enter = { key: 'Enter', shiftKey: false, isComposing: false, keyCode: 13 };
  it('sends on Enter only', () => {
    expect(isSendKey(enter)).toBe(true);
    expect(isSendKey({ ...enter, key: 'a' })).toBe(false);
  });
  it('does not send on Shift+Enter (a newline)', () => {
    expect(isSendKey({ ...enter, shiftKey: true })).toBe(false);
  });
  it('does not send the Enter of an IME composition', () => {
    expect(isSendKey({ ...enter, isComposing: true })).toBe(false);
    expect(isSendKey({ ...enter, keyCode: chatConfig.imeProcessKeyCode })).toBe(false);
  });
});

describe('isNearBottom', () => {
  it('follows within the threshold of the bottom and not beyond', () => {
    const threshold = chatConfig.autoScrollThresholdPx;
    expect(isNearBottom({ scrollTop: 600, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 600 - threshold, clientHeight: 400, scrollHeight: 1000 })).toBe(true);
    expect(isNearBottom({ scrollTop: 600 - threshold - 1, clientHeight: 400, scrollHeight: 1000 })).toBe(false);
  });
  it('is at the bottom of a list that does not scroll', () => {
    expect(isNearBottom({ scrollTop: 0, clientHeight: 400, scrollHeight: 300 })).toBe(true);
  });
});

describe('activityText', () => {
  it('has a Japanese phrase for every tool and state', () => {
    for (const tool of toolNameSchema.options) {
      for (const state of ['running', 'done', 'failed'] as const) expect(activityText(tool, state)).not.toBe('');
    }
    expect(activityText('runQuery', 'running')).toBe('クエリを実行中');
    expect(activityText('setView', 'running')).toBe('表示範囲を移動中');
  });
});

describe('activityText with a code', () => {
  it('adds the reason to a failed call only', () => {
    expect(activityText('addLayer', 'failed', 'TIMEOUT')).toBe('レイヤーの追加に失敗しました（時間切れ）');
    expect(activityText('addLayer', 'failed')).toBe('レイヤーの追加に失敗しました');
    expect(activityText('addLayer', 'done', 'TIMEOUT')).toBe('レイヤーを追加しました');
    expect(activityText('runQuery', 'failed', chatConfig.serverRejectedCode)).toBe(`クエリの実行に失敗しました（${chatConfig.text.serverRejectedReason}）`);
  });
});

describe('draftLength', () => {
  it('counts what is sent: trimmed, in code points', () => {
    expect(draftLength('  駅😀  ')).toBe(2);
  });
});

describe('mayRestoreFocus', () => {
  const body = document.body;
  const panel = document.createElement('div');
  const inside = document.createElement('button');
  panel.append(inside);
  const outside = document.createElement('button');
  it('restores when the focus is lost or inside the panel, not when the user moved it elsewhere', () => {
    expect(mayRestoreFocus(null, body, panel)).toBe(true);
    expect(mayRestoreFocus(body, body, panel)).toBe(true);
    expect(mayRestoreFocus(inside, body, panel)).toBe(true);
    expect(mayRestoreFocus(outside, body, panel)).toBe(false);
    expect(mayRestoreFocus(outside, body, undefined)).toBe(false);
  });
});
