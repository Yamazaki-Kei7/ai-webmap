import { describe, expect, it } from 'vitest';
import { toolError, toolErrorCodeSchema, toolErrorSchema } from './toolProtocol';

describe('toolError', () => {
  it('builds a failed result with the hint', () => {
    expect(toolError('TIMEOUT', 'too slow', 'filter')).toEqual({ ok: false, error: { code: 'TIMEOUT', message: 'too slow', hint: 'filter' } });
  });

  it('has no hint key when there is no hint', () => {
    expect(toolError('SQL_ERROR', 'bad')).toEqual({ ok: false, error: { code: 'SQL_ERROR', message: 'bad' } });
    expect('hint' in toolError('SQL_ERROR', 'bad').error).toBe(false);
  });

  it('is accepted by the error schema', () => {
    expect(toolErrorSchema.safeParse(toolError('NO_GEOMETRY', 'm', 'h').error).success).toBe(true);
  });
});

describe('toolErrorCodeSchema', () => {
  it('lists the eleven codes of the protocol', () => {
    expect(toolErrorCodeSchema.options).toHaveLength(11);
    expect(toolErrorCodeSchema.safeParse('NOPE').success).toBe(false);
  });
});
