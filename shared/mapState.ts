import type { MapContext } from './mapSpec.js';

/**
 * The block that carries the map's state in a user message (design 4.1): the backend appends it, the chat UI strips it
 * for display. One definition of the tag, so the two sides cannot drift.
 */
export const mapStateTag = 'map_state';

const mapStateOpen = `<${mapStateTag}>`;
const mapStateClose = `</${mapStateTag}>`;

/** The tag's own `<` and `</` (any case), which the user's text must not contain. */
const tagInText = new RegExp(`<(/?${mapStateTag})`, 'gi');

/** The full-width `＜` stands in for a `<` that would open or close the block. */
const fullWidthLess = '＜';

/**
 * `message`, a blank line, then the minified map context in the tag. The message cannot forge the block (its `<map_state`
 * and `</map_state` get a full-width `＜`), and the JSON cannot close it (its `<` are escaped as `\u003c`, which parses to
 * the same value): layer names and category values come from the datasets.
 */
export function appendMapState(message: string, mapContext: MapContext): string {
  const text = message.replace(tagInText, `${fullWidthLess}$1`);
  const json = JSON.stringify(mapContext).replaceAll('<', '\\u003c');
  return `${text}\n\n${mapStateOpen}\n${json}\n${mapStateClose}`;
}

/** The message as the user typed it: the block `appendMapState` added is cut off. A message without the block is returned as it is. */
export function stripMapState(message: string): string {
  const start = message.lastIndexOf(`\n\n${mapStateOpen}\n`);
  if (start === -1 || !message.endsWith(`\n${mapStateClose}`)) return message;
  return message.slice(0, start);
}
