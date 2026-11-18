import { describe, expect, it } from 'vitest';
import { clipDistinct, clipTexts, truncate } from './clip';

describe('clipDistinct', () => {
  it('leaves short texts alone and ends a cut text in an ellipsis within the limit', () => {
    expect(clipDistinct(['abc', 'abcdefghij'], 6)).toEqual(['abc', 'abcde…']);
  });

  it('keeps texts with a shared long prefix apart, and marks every cut one', () => {
    const texts = Array.from({ length: 12 }, (_, i) => `東京都千代田区丸の内一丁目の長い名称${i}`);
    const shown = clipDistinct(texts, 12);
    expect(new Set(shown).size).toBe(12);
    for (const text of shown) {
      expect(text.length).toBeLessThanOrEqual(12);
      expect(text).toContain('…');
    }
  });

  it('does not let a cut text take the place of a short text that already looks like it', () => {
    expect(new Set(clipDistinct(['abcde…', 'abcdefghij'], 6)).size).toBe(2);
  });
});

describe('cutting by code points', () => {
  const hasLoneSurrogate = (text: string): boolean => /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text);

  it('truncate counts an emoji as one character and never leaves half of it', () => {
    const text = '😀'.repeat(10);
    const cut = truncate(text, 5);
    expect(Array.from(cut)).toHaveLength(5);
    expect(cut).toBe(`${'😀'.repeat(4)}…`);
    expect(hasLoneSurrogate(cut)).toBe(false);
    expect(truncate('😀😀😀', 3)).toBe('😀😀😀');
  });

  it('clipDistinct keeps short emoji texts whole and cuts long ones without a lone surrogate, also with a #n suffix', () => {
    const texts = Array.from({ length: 12 }, (_, i) => `😀`.repeat(20) + i);
    const shown = clipDistinct([...texts, '😀😀'], 8);
    expect(new Set(shown).size).toBe(13);
    for (const text of shown) {
      expect(Array.from(text).length).toBeLessThanOrEqual(8);
      expect(hasLoneSurrogate(text)).toBe(false);
    }
    expect(shown.at(-1)).toBe('😀😀');
  });
});

describe('clipTexts', () => {
  const long = (tail: string) => `東京都千代田区丸の内一丁目の長い名称${tail}`;

  it('gives the same shown text to the same text, and different texts different ones', () => {
    const shown = clipTexts([long('A'), long('B'), long('A'), 'short'], 12);
    expect(shown.size).toBe(3);
    expect(shown.get(long('A'))).not.toBe(shown.get(long('B')));
    expect(shown.get('short')).toBe('short');
    for (const text of shown.values()) expect(text.length).toBeLessThanOrEqual(12);
  });

  it('numbers the values of several lists together: one #n is one value', () => {
    const overrides = [long('A'), long('B')];
    const categories = [long('B'), long('C')];
    const shown = clipTexts([...overrides, ...categories], 12);
    expect(new Set(shown.values()).size).toBe(3);
  });
});
