import { describe, expect, it } from 'vitest';
import { agentConfig, mapConfig, resultConfig } from '../shared/config';
import type { MapContext } from '../shared/mapSpec';
import { checkConversationId, checkInterruptAnswers, checkMapContext, checkMessage } from './conversation-input';

const emptyContext: MapContext = { view: { center: [139.7, 35.7], zoom: 9 }, layers: [] };

const bytes = (text: string): number => new TextEncoder().encode(text).length;

describe('checkConversationId', () => {
  it('accepts a UUID', () => {
    expect(checkConversationId('3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d').ok).toBe(true);
  });

  it.each(['', 'abc', 'L1', '../x', '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d ', 'x'.repeat(10_000)])('rejects %j', (id) => {
    expect(checkConversationId(id).ok).toBe(false);
  });
});

describe('checkMessage', () => {
  it('accepts 1 to the maximum number of characters', () => {
    expect(checkMessage('あ').ok).toBe(true);
    expect(checkMessage('a'.repeat(agentConfig.maxUtteranceChars)).ok).toBe(true);
  });

  it('counts code points: an emoji is one character', () => {
    expect(checkMessage('😀'.repeat(agentConfig.maxUtteranceChars)).ok).toBe(true);
    expect(checkMessage('😀'.repeat(agentConfig.maxUtteranceChars + 1)).ok).toBe(false);
  });

  it('rejects an empty, a blank and an over-long message, without echoing it', () => {
    for (const message of ['', '  \n', 'a'.repeat(agentConfig.maxUtteranceChars + 1)]) {
      const checked = checkMessage(message);
      expect(checked.ok).toBe(false);
      if (!checked.ok) expect(checked.message).not.toContain('aaaa');
    }
  });
});

describe('checkMapContext', () => {
  it('accepts a valid context', () => {
    expect(checkMapContext(emptyContext)).toEqual({ ok: true, value: emptyContext });
  });

  it('rejects a context of the wrong shape', () => {
    // @ts-expect-error — deliberately outside the type
    expect(checkMapContext({ view: 1, layers: [] }).ok).toBe(false);
    // @ts-expect-error — strict: no extra keys
    expect(checkMapContext({ ...emptyContext, extra: true }).ok).toBe(false);
  });

  it('rejects a valid context whose JSON is over the size limit, and accepts one just under it', () => {
    const layer = (n: number) => ({ id: `L${n}`, name: 'n'.repeat(20) });
    const contextOf = (count: number): MapContext => ({ ...emptyContext, layers: Array.from({ length: count }, (_, n) => layer(n)) });
    let count = 1;
    while (bytes(JSON.stringify(contextOf(count + 1))) <= mapConfig.summaryMaxBytes) count++;
    expect(checkMapContext(contextOf(count)).ok).toBe(true);
    expect(checkMapContext(contextOf(count + 1)).ok).toBe(false);
  });
});

describe('checkInterruptAnswers', () => {
  const answer = (response: string, interruptId = 'tooluse_1') => ({ interruptId, response });

  it('accepts one to the maximum number of answers', () => {
    expect(checkInterruptAnswers([answer('{}')]).ok).toBe(true);
    expect(checkInterruptAnswers(Array.from({ length: agentConfig.maxInterruptResponses }, (_, n) => answer('{}', `id${n}`))).ok).toBe(true);
  });

  it('rejects none, too many, and an empty or over-long id', () => {
    expect(checkInterruptAnswers([]).ok).toBe(false);
    expect(checkInterruptAnswers(Array.from({ length: agentConfig.maxInterruptResponses + 1 }, (_, n) => answer('{}', `id${n}`))).ok).toBe(false);
    expect(checkInterruptAnswers([answer('{}', '')]).ok).toBe(false);
    expect(checkInterruptAnswers([answer('{}', 'i'.repeat(agentConfig.maxInterruptIdChars + 1))]).ok).toBe(false);
  });

  it('measures a response in UTF-8 bytes, not characters', () => {
    const fits = 'あ'.repeat(Math.floor(resultConfig.maxToolResultBytes / 3));
    expect(checkInterruptAnswers([answer(fits)]).ok).toBe(true);
    expect(checkInterruptAnswers([answer(`${fits}あ`)]).ok).toBe(false);
  });

  it('rejects a total over the limit even when every answer is within its own', () => {
    const each = 'a'.repeat(resultConfig.maxToolResultBytes);
    const count = resultConfig.maxTotalResultBytes / resultConfig.maxToolResultBytes;
    expect(checkInterruptAnswers(Array.from({ length: count }, (_, n) => answer(each, `id${n}`))).ok).toBe(true);
    expect(checkInterruptAnswers(Array.from({ length: count + 1 }, (_, n) => answer(each, `id${n}`))).ok).toBe(false);
  });

  it('rejects an extra field', () => {
    // @ts-expect-error — deliberately outside the type
    expect(checkInterruptAnswers([{ interruptId: 'a', response: '{}', approved: true }]).ok).toBe(false);
  });
});
