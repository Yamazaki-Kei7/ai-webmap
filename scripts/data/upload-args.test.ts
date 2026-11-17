import { describe, expect, it } from 'vitest';
import { defaultTarget, parseUploadArgs, uploadFlags, uploadTargets, usageLine } from './upload-args.js';

function refusalOf(args: string[]): string {
  const parsed = parseUploadArgs(args);
  if (parsed.ok) throw new Error('expected a refusal');
  return parsed.message;
}

describe('parseUploadArgs', () => {
  it('defaults to the local target with no flag', () => {
    expect(parseUploadArgs([])).toEqual({ ok: true, options: { target: defaultTarget, dryRun: false, verifyOnly: false } });
    expect(defaultTarget).toBe('local');
  });

  it('reads each flag', () => {
    expect(parseUploadArgs([uploadFlags.dryRun])).toEqual({ ok: true, options: { target: 'local', dryRun: true, verifyOnly: false } });
    expect(parseUploadArgs([uploadFlags.verifyOnly])).toEqual({ ok: true, options: { target: 'local', dryRun: false, verifyOnly: true } });
    for (const target of uploadTargets) {
      expect(parseUploadArgs([uploadFlags.target, target])).toEqual({ ok: true, options: { target, dryRun: false, verifyOnly: false } });
    }
  });

  it('reads a flag together with a target, in either order', () => {
    expect(parseUploadArgs([uploadFlags.target, 'sandbox', uploadFlags.dryRun])).toEqual({ ok: true, options: { target: 'sandbox', dryRun: true, verifyOnly: false } });
    expect(parseUploadArgs([uploadFlags.verifyOnly, uploadFlags.target, 'sandbox'])).toEqual({ ok: true, options: { target: 'sandbox', dryRun: false, verifyOnly: true } });
  });

  it('refuses production, which is not a target', () => {
    expect(refusalOf([uploadFlags.target, 'production'])).toContain(usageLine);
  });

  it('refuses a missing, repeated or unknown target value', () => {
    expect(refusalOf([uploadFlags.target])).toContain(`${uploadFlags.target} needs a value`);
    expect(refusalOf([uploadFlags.target, 'local', uploadFlags.target, 'sandbox'])).toContain('given twice');
    expect(refusalOf([uploadFlags.target, 'elsewhere'])).toContain(usageLine);
    // The value of the flag is not taken as another flag.
    expect(refusalOf([uploadFlags.target, uploadFlags.dryRun])).toContain(usageLine);
  });

  it('refuses --dry-run together with --verify-only', () => {
    expect(refusalOf([uploadFlags.dryRun, uploadFlags.verifyOnly])).toContain('cannot be combined');
    expect(refusalOf([uploadFlags.verifyOnly, uploadFlags.dryRun])).toContain('cannot be combined');
  });

  it('refuses any other argument without repeating it', () => {
    const secretLike = 'hunter2-not-a-flag';
    for (const args of [[secretLike], [uploadFlags.dryRun, secretLike], ['--target=sandbox'], ['-n']]) {
      const message = refusalOf(args);
      expect(message).toContain(usageLine);
      expect(message).not.toContain(secretLike);
    }
  });
});
