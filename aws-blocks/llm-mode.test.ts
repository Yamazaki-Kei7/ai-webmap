import { describe, expect, it } from 'vitest';
import { defaultLlmMode, llmModeEnvName, parseLlmMode } from './llm-mode';

describe('parseLlmMode', () => {
  it('defaults to bedrock when unset', () => {
    expect(parseLlmMode(undefined)).toBe(defaultLlmMode);
    expect(defaultLlmMode).toBe('bedrock');
  });

  it('accepts bedrock and canned', () => {
    expect(parseLlmMode('bedrock')).toBe('bedrock');
    expect(parseLlmMode('canned')).toBe('canned');
  });

  it('rejects any other value, including an empty one, with the variable name in the message', () => {
    for (const value of ['', 'Canned', 'mock', ' canned']) {
      expect(() => parseLlmMode(value)).toThrow(llmModeEnvName);
    }
  });
});
