/**
 * Cuts texts for the model (layer summaries in `<map_state>` and tool answers): one algorithm for both, so the same
 * long value reads the same everywhere.
 */

export const ellipsis = '…';

export const truncate = (text: string, maxChars: number): string => (text.length <= maxChars ? text : `${text.slice(0, maxChars - 1)}${ellipsis}`);

/**
 * Cuts each text to `maxChars` characters, ending in "…", and keeps the results apart: a cut text that would come out
 * like another text gets `#n` before the end, so two values are never merged into one.
 */
export function clipDistinct(texts: readonly string[], maxChars: number): string[] {
  const cut = texts.map((text) => truncate(text, maxChars));
  const occurrences = new Map<string, number>();
  for (const shown of cut) occurrences.set(shown, (occurrences.get(shown) ?? 0) + 1);
  const taken = new Set(texts.filter((text) => text.length <= maxChars));
  const numbered = new Map<string, number>();
  return texts.map((text, i) => {
    if (text.length <= maxChars) return text;
    if (occurrences.get(cut[i]) === 1 && !taken.has(cut[i])) return cut[i];
    let n = numbered.get(cut[i]) ?? 0;
    let unique: string;
    do {
      n++;
      const suffix = `#${n}`;
      unique = `${text.slice(0, maxChars - 1 - suffix.length)}${ellipsis}${suffix}`;
    } while (taken.has(unique));
    numbered.set(cut[i], n);
    taken.add(unique);
    return unique;
  });
}

/**
 * The shown text of every distinct text of `texts`, from one numbering: the same text always gets the same shown text,
 * and different texts never share one. Use it for values that one layer names in several places (the colours of its
 * categories and its overrides), so a `…#1` means one value.
 */
export function clipTexts(texts: readonly string[], maxChars: number): Map<string, string> {
  const distinct = [...new Set(texts)];
  const shown = clipDistinct(distinct, maxChars);
  return new Map(distinct.map((text, i) => [text, shown[i]]));
}
