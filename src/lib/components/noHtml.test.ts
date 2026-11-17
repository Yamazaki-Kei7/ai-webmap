import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const srcDir = join(import.meta.dirname, '..', '..');

function svelteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith('.svelte') ? [path] : [];
  });
}

describe('markup', () => {
  // The messages are the model's and the user's, the layer cards carry the data's text: all of it is shown as text. `{@html}` would run it as markup.
  it('has no component that renders text as HTML', () => {
    const files = svelteFiles(srcDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files.filter((file) => readFileSync(file, 'utf8').includes('{@html'))).toEqual([]);
  });
});
