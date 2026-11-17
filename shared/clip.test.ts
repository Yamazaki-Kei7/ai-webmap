import { describe, expect, it } from 'vitest';
import { clipDistinct, clipTexts } from './clip';

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
