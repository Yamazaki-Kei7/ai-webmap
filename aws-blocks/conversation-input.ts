import { z } from 'zod';
import { agentConfig, mapConfig, resultConfig } from '../shared/config.js';
import { mapContextSchema, type MapContext } from '../shared/mapSpec.js';

/**
 * The checks of the conversation API's arguments (pure, so they are tested without a backend). A failure carries a
 * short message that never echoes the input; the API turns it into a 400.
 */

export type Checked<T> = { ok: true; value: T } | { ok: false; message: string };

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length;

function check<T>(schema: z.ZodType<T>, value: T, message: string): Checked<T> {
  const parsed = schema.safeParse(value);
  return parsed.success ? { ok: true, value: parsed.data } : { ok: false, message };
}

/** The ids `agent.createConversationId` issues are UUIDs. */
const conversationIdSchema = z.uuid();

export const checkConversationId = (value: string): Checked<string> => check(conversationIdSchema, value, 'Invalid conversation id');

const codePoints = (text: string): number => Array.from(text).length;

// "Characters" are code points (an emoji is one). The first bound is on UTF-16 units (at most two per code point), so
// that a huge string is refused before it is counted.
const messageSchema = z
  .string()
  .max(agentConfig.maxUtteranceChars * 2)
  .refine((text) => codePoints(text) <= agentConfig.maxUtteranceChars)
  .refine((text) => text.trim() !== '');

export const checkMessage = (value: string): Checked<string> =>
  check(messageSchema, value, `The message must be 1 to ${agentConfig.maxUtteranceChars} characters`);

export function checkMapContext(value: MapContext): Checked<MapContext> {
  const parsed = mapContextSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: 'Invalid map context' };
  if (utf8Bytes(JSON.stringify(parsed.data)) > mapConfig.summaryMaxBytes) return { ok: false, message: 'The map context is too large' };
  return { ok: true, value: parsed.data };
}

/** What the browser answers to one interrupt: the id and the JSON string of its result. */
export type InterruptAnswer = { interruptId: string; response: string };

const interruptAnswerSchema = z.strictObject({
  interruptId: z.string().min(1).max(agentConfig.maxInterruptIdChars),
  response: z.string()
});

const answersSchema = z.array(interruptAnswerSchema).min(1).max(agentConfig.maxInterruptResponses);

export function checkInterruptAnswers(value: InterruptAnswer[]): Checked<InterruptAnswer[]> {
  const parsed = answersSchema.safeParse(value);
  if (!parsed.success) return { ok: false, message: `Between 1 and ${agentConfig.maxInterruptResponses} responses are needed` };
  const sizes = parsed.data.map(({ response }) => utf8Bytes(response));
  if (sizes.some((size) => size > resultConfig.maxToolResultBytes)) return { ok: false, message: 'A response is too large' };
  if (sizes.reduce((total, size) => total + size, 0) > resultConfig.maxTotalResultBytes) return { ok: false, message: 'The responses are too large' };
  return { ok: true, value: parsed.data };
}
