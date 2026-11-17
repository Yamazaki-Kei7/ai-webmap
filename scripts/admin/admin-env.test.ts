import { describe, expect, it } from 'vitest';
import { dryRunFlag, hasOnlyDryRunFlag } from './admin-env.js';

describe('hasOnlyDryRunFlag', () => {
  it('accepts no arguments and the dry-run flag', () => {
    expect(hasOnlyDryRunFlag([])).toBe(true);
    expect(hasOnlyDryRunFlag([dryRunFlag])).toBe(true);
  });

  it('refuses any other argument, alone or beside the flag', () => {
    expect(hasOnlyDryRunFlag(['something'])).toBe(false);
    expect(hasOnlyDryRunFlag([dryRunFlag, 'something'])).toBe(false);
  });
});
