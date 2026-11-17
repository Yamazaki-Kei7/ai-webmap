/**
 * The arguments of `npm run data:upload`. Anything that is not understood is refused with the usage line;
 * the message never repeats the argument (the command takes no secret, but npm prints what it is given anyway).
 */

/** Where the command may upload to. Production is not one of them: it is done with the AWS CLI (README). */
export const uploadTargets = ['local', 'sandbox'] as const;
export type UploadTarget = (typeof uploadTargets)[number];
function isUploadTarget(value: string): value is UploadTarget {
  return uploadTargets.some((target) => target === value);
}

export const defaultTarget: UploadTarget = 'local';

export const uploadFlags = { target: '--target', dryRun: '--dry-run', verifyOnly: '--verify-only' } as const;

export const usageLine = `Usage: npm run data:upload -- [${uploadFlags.target} <${uploadTargets.join('|')}>] [${uploadFlags.dryRun} | ${uploadFlags.verifyOnly}]`;

export type UploadOptions = { target: UploadTarget; dryRun: boolean; verifyOnly: boolean };
export type ParsedArgs = { ok: true; options: UploadOptions } | { ok: false; message: string };

function refuse(reason: string): ParsedArgs {
  return { ok: false, message: `${reason}\n${usageLine}` };
}

export function parseUploadArgs(args: string[]): ParsedArgs {
  let target: UploadTarget = defaultTarget;
  let targetSeen = false;
  let dryRun = false;
  let verifyOnly = false;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === uploadFlags.dryRun) {
      dryRun = true;
    } else if (arg === uploadFlags.verifyOnly) {
      verifyOnly = true;
    } else if (arg === uploadFlags.target) {
      const value = args[++index];
      if (targetSeen) return refuse(`${uploadFlags.target} is given twice.`);
      if (value === undefined) return refuse(`${uploadFlags.target} needs a value.`);
      if (!isUploadTarget(value)) return refuse('The target is not one this command uploads to.');
      target = value;
      targetSeen = true;
    } else {
      return refuse('An argument is not understood.');
    }
  }
  if (dryRun && verifyOnly) return refuse(`${uploadFlags.dryRun} and ${uploadFlags.verifyOnly} cannot be combined.`);
  return { ok: true, options: { target, dryRun, verifyOnly } };
}
