import { describe, expect, it } from 'vitest';
import { datasetFileName, datasetIds, duckdbWasmFileName, uploadableFiles, uploadContentType } from '../../shared/datasets.js';
import { exitCodes, runDataUpload, type DatasetSources, type FlowDeps, type GetResult, type PutResult } from './upload-flow.js';
import { sha256Hex, type PlanItem } from './upload-plan.js';

const secretUrlPart = 'X-Amz-Signature=do-not-print';
const urlOf = (name: string): string => `https://bucket.invalid/${name}?${secretUrlPart}`;
const uploadUrlOf = (name: string): string => `https://bucket.invalid/upload/${name}?${secretUrlPart}`;

function contentTypeOf(name: string): string {
  const type = uploadContentType(name);
  if (type === undefined) throw new Error(`no content type for ${name}`);
  return type;
}

/** One planned object per uploadable name, each with different bytes. */
function makeItems(): PlanItem[] {
  return uploadableFiles.map((name, index) => {
    const bytes = new Uint8Array([index, index + 1, index + 2, 99]);
    return { name, sourcePath: `source/${name}`, contentType: contentTypeOf(name), bytes, sha256: sha256Hex(bytes) };
  });
}

type Calls = { order: string[]; puts: { name: string; contentType: string; size: number }[]; lines: string[]; errors: string[] };

/** A fake service that stores what is put and serves it back; `override` changes single behaviours. */
function makeDeps(items: PlanItem[], override: Partial<FlowDeps> = {}): { deps: FlowDeps; calls: Calls } {
  const calls: Calls = { order: [], puts: [], lines: [], errors: [] };
  const stored = new Map<string, { bytes: Uint8Array; contentType: string }>();
  const sources: DatasetSources = {
    sources: datasetIds.map((id) => ({ id, url: urlOf(datasetFileName(id)) })),
    wasmUrl: urlOf(duckdbWasmFileName),
  };
  const deps: FlowDeps = {
    signIn: async () => {
      calls.order.push('signIn');
      return true;
    },
    signOut: async () => {
      calls.order.push('signOut');
    },
    createUpload: async (name) => {
      calls.order.push(`createUpload:${name}`);
      return { url: uploadUrlOf(name) };
    },
    put: async (url, contentType, bytes): Promise<PutResult> => {
      const name = items.find((item) => url === uploadUrlOf(item.name))?.name ?? 'unknown';
      calls.order.push(`put:${name}`);
      calls.puts.push({ name, contentType, size: bytes.byteLength });
      stored.set(name, { bytes, contentType });
      return { status: 200, body: '' };
    },
    getSources: async () => {
      calls.order.push('getSources');
      return sources;
    },
    get: async (url): Promise<GetResult> => {
      const name = items.find((item) => url === urlOf(item.name))?.name ?? 'unknown';
      calls.order.push(`get:${name}`);
      const found = stored.get(name);
      return found === undefined ? { status: 404, contentType: undefined, bytes: new Uint8Array() } : { status: 200, ...found };
    },
    log: (line) => calls.lines.push(line),
    logError: (line) => calls.errors.push(line),
    ...override,
  };
  return { deps, calls };
}

const allOutput = (calls: Calls): string => [...calls.lines, ...calls.errors].join('\n');

describe('runDataUpload', () => {
  it('signs in, uploads each object in plan order one at a time, verifies all, and signs out', async () => {
    const items = makeItems();
    const { deps, calls } = makeDeps(items);
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.ok);
    const uploads = uploadableFiles.flatMap((name) => [`createUpload:${name}`, `put:${name}`]);
    const downloads = uploadableFiles.map((name) => `get:${name}`);
    expect(calls.order).toEqual(['signIn', ...uploads, 'getSources', ...downloads, 'signOut']);
    expect(calls.lines.at(-1)).toBe(`Verified ${items.length} of ${items.length} objects.`);
    expect(calls.errors).toEqual([]);
  });

  it('sends the content type of the name and the planned bytes with every put', async () => {
    const items = makeItems();
    const { deps, calls } = makeDeps(items);
    await runDataUpload({ items, verifyOnly: false, deps });
    expect(calls.puts).toEqual(items.map((item) => ({ name: item.name, contentType: uploadContentType(item.name), size: item.bytes.byteLength })));
    expect(calls.puts.find((put) => put.name === duckdbWasmFileName)?.contentType).not.toBe(calls.puts[0].contentType);
  });

  it('stops at the first failed put, names what was uploaded, and still signs out', async () => {
    const items = makeItems();
    const failing = items[2].name;
    const { deps, calls } = makeDeps(items, {
      put: async (url) => {
        calls.order.push(`put:${url.includes(failing) ? failing : 'other'}`);
        return url.includes(failing) ? { status: 403, body: '<Error><Code>SignatureDoesNotMatch</Code><AWSAccessKeyId>AKIASECRET</AWSAccessKeyId></Error>' } : { status: 200, body: '' };
      },
    });
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(calls.order.filter((entry) => entry.startsWith('createUpload'))).toEqual(items.slice(0, 3).map((item) => `createUpload:${item.name}`));
    expect(calls.order).not.toContain('getSources');
    expect(calls.order.at(-1)).toBe('signOut');
    const [message] = calls.errors;
    expect(message).toContain(failing);
    expect(message).toContain('HTTP 403');
    expect(message).toContain('SignatureDoesNotMatch');
    expect(message).toContain(`${items[0].name}, ${items[1].name}`);
    expect(message).not.toContain('AKIASECRET');
  });

  it('says that nothing was uploaded when the first put fails', async () => {
    const items = makeItems();
    const { deps, calls } = makeDeps(items, { put: async () => ({ status: 500, body: '' }) });
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(calls.errors[0]).toContain('Already uploaded: none');
  });

  it('signs out after a thrown error and reports only its name', async () => {
    const items = makeItems();
    const failure = Object.assign(new Error(`connect refused ${urlOf('x')}`), { name: 'FetchFailure' });
    const { deps, calls } = makeDeps(items, {
      put: async () => {
        throw failure;
      },
    });
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(calls.order.at(-1)).toBe('signOut');
    expect(calls.errors[0]).toContain('FetchFailure');
    expect(allOutput(calls)).not.toContain('connect refused');
    expect(allOutput(calls)).not.toContain(secretUrlPart);
  });

  it('signs out when the sign-in fails or throws, and uploads nothing', async () => {
    for (const signIn of [async () => false, async () => { throw new Error('boom'); }]) {
      const items = makeItems();
      const { deps, calls } = makeDeps(items, { signIn });
      expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
      expect(calls.order.filter((entry) => entry.startsWith('createUpload'))).toEqual([]);
      expect(calls.order.at(-1)).toBe('signOut');
      expect(calls.errors[0]).toContain('Sign-in failed');
    }
  });

  it('reports a failing sign-out without hiding the result', async () => {
    const items = makeItems();
    const { deps, calls } = makeDeps(items, {
      signOut: async () => {
        throw new Error('nope');
      },
    });
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.ok);
    expect(calls.errors.some((line) => line.includes('Sign-out failed'))).toBe(true);
  });

  it('prints no signed URL in any line of a full run', async () => {
    const items = makeItems();
    const { deps, calls } = makeDeps(items);
    await runDataUpload({ items, verifyOnly: false, deps });
    expect(allOutput(calls)).not.toContain(secretUrlPart);
    expect(allOutput(calls)).not.toContain('bucket.invalid');
  });
});

describe('runDataUpload, verification', () => {
  /** A fake whose stored copy of one object is changed after the upload. */
  function withDownload(items: PlanItem[], name: string, change: (result: GetResult) => GetResult) {
    const base = makeDeps(items);
    const get = base.deps.get;
    const deps: FlowDeps = { ...base.deps, get: async (url) => (url === urlOf(name) ? change(await get(url)) : get(url)) };
    return { deps, calls: base.calls };
  }

  it('--verify-only makes no upload and checks every object', async () => {
    const items = makeItems();
    const seeded = makeDeps(items);
    await runDataUpload({ items, verifyOnly: false, deps: seeded.deps });
    const calls: string[] = [];
    const deps: FlowDeps = {
      ...seeded.deps,
      createUpload: async () => {
        calls.push('createUpload');
        return { url: '' };
      },
      put: async () => {
        calls.push('put');
        return { status: 200, body: '' };
      },
      log: () => undefined,
      logError: () => undefined,
    };
    expect(await runDataUpload({ items, verifyOnly: true, deps })).toBe(exitCodes.ok);
    expect(calls).toEqual([]);
  });

  it('reports a difference in size', async () => {
    const items = makeItems();
    const { deps, calls } = withDownload(items, items[1].name, (result) => ({ ...result, bytes: result.bytes.slice(1) }));
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(calls.errors.join('\n')).toMatch(new RegExp(`${items[1].name}.*DIFFERS: size 3 != 4`));
  });

  it('reports a difference in hash when the size is the same', async () => {
    const items = makeItems();
    const { deps, calls } = withDownload(items, items[1].name, (result) => ({ ...result, bytes: result.bytes.map((byte) => byte ^ 1) }));
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    const line = calls.errors.join('\n');
    expect(line).toContain('sha256');
    expect(line).not.toContain('size');
  });

  it('reports a difference in content type, and compares only the media type', async () => {
    const items = makeItems();
    const wrong = withDownload(items, items[0].name, (result) => ({ ...result, contentType: 'application/octet-stream' }));
    expect(await runDataUpload({ items, verifyOnly: false, deps: wrong.deps })).toBe(exitCodes.failed);
    expect(wrong.calls.errors.join('\n')).toContain('content-type application/octet-stream');
    const absent = withDownload(items, items[0].name, (result) => ({ ...result, contentType: undefined }));
    expect(await runDataUpload({ items, verifyOnly: false, deps: absent.deps })).toBe(exitCodes.failed);
    const withParameter = withDownload(items, items[0].name, (result) => ({ ...result, contentType: `${items[0].contentType.toUpperCase()}; charset=x` }));
    expect(await runDataUpload({ items, verifyOnly: false, deps: withParameter.deps })).toBe(exitCodes.ok);
  });

  it('reports a download that is not OK and one that throws', async () => {
    const items = makeItems();
    const notOk = withDownload(items, items[3].name, (result) => ({ ...result, status: 403 }));
    expect(await runDataUpload({ items, verifyOnly: false, deps: notOk.deps })).toBe(exitCodes.failed);
    expect(notOk.calls.errors.join('\n')).toContain('download failed: HTTP 403');
    const base = makeDeps(items);
    const get = base.deps.get;
    const throwing: FlowDeps = {
      ...base.deps,
      get: async (url) => {
        if (url === urlOf(items[3].name)) throw new Error(`reset ${url}`);
        return get(url);
      },
    };
    expect(await runDataUpload({ items, verifyOnly: false, deps: throwing })).toBe(exitCodes.failed);
    expect(allOutput(base.calls)).not.toContain(secretUrlPart);
  });

  it('checks all objects even when the first one differs, and counts the good ones', async () => {
    const items = makeItems();
    const { deps, calls } = withDownload(items, items[0].name, (result) => ({ ...result, bytes: new Uint8Array() }));
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(calls.order.filter((entry) => entry.startsWith('get:'))).toEqual(items.map((item) => `get:${item.name}`));
    expect(calls.lines.at(-1)).toBe(`Verified ${items.length - 1} of ${items.length} objects.`);
    expect(calls.errors).toHaveLength(1);
  });

  it('fails an object that has no download URL', async () => {
    const items = makeItems();
    const base = makeDeps(items);
    const deps: FlowDeps = { ...base.deps, getSources: async () => ({ sources: [], wasmUrl: urlOf(duckdbWasmFileName) }) };
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(base.calls.errors.filter((line) => line.includes('no download URL'))).toHaveLength(items.length - 1);
  });

  it('fails when the download addresses cannot be had', async () => {
    const items = makeItems();
    const base = makeDeps(items);
    const deps: FlowDeps = {
      ...base.deps,
      getSources: async () => {
        throw new Error('denied');
      },
    };
    expect(await runDataUpload({ items, verifyOnly: false, deps })).toBe(exitCodes.failed);
    expect(base.calls.order.at(-1)).toBe('signOut');
  });
});
