import { describe, expect, it, vi } from 'vitest';
import { datasetFileName, datasetIds } from '../../../shared/datasets';
import { createViewRegistry } from './registry';

const [first, second] = datasetIds;
const target = 'worker-1';

function setup() {
  const registeredBuffers: Uint8Array[] = [];
  const loadBytes = vi.fn(async (id: string) => new Uint8Array([...id].map((char) => char.charCodeAt(0))));
  const registerBuffer = vi.fn(async (_target: string, _fileName: string, bytes: Uint8Array) => {
    registeredBuffers.push(bytes);
  });
  const createView = vi.fn(async (_target: string, _id: string, _fileName: string) => undefined);
  // `target` undefined: every worker is the current one.
  const current: { target: string | undefined } = { target: undefined };
  const registry = createViewRegistry<string>({ loadBytes, registerBuffer, createView, isCurrent: (candidate) => current.target === undefined || candidate === current.target });
  return { registry, current, loadBytes, registerBuffer, createView, registeredBuffers };
}

describe('lazy view registration', () => {
  it('fetches, registers and creates the view of a dataset on first use', async () => {
    const { registry, loadBytes, registerBuffer, createView } = setup();
    await registry.ensure(target, [first]);
    expect(loadBytes).toHaveBeenCalledWith(first);
    expect(registerBuffer).toHaveBeenCalledWith(target, datasetFileName(first), expect.any(Uint8Array));
    expect(createView).toHaveBeenCalledWith(target, first, datasetFileName(first));
  });

  it('does nothing before a view is asked for', () => {
    const { loadBytes } = setup();
    expect(loadBytes).not.toHaveBeenCalled();
  });

  it('registers a dataset once, however often it is asked for', async () => {
    const { registry, loadBytes, registerBuffer, createView } = setup();
    await registry.ensure(target, [first]);
    await registry.ensure(target, [first, first]);
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(registerBuffer).toHaveBeenCalledTimes(1);
    expect(createView).toHaveBeenCalledTimes(1);
  });

  it('shares one in-flight promise between concurrent requests', async () => {
    const { registry, loadBytes } = setup();
    await Promise.all([registry.ensure(target, [first]), registry.ensure(target, [first, second]), registry.ensure(target, [second])]);
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it('rejects an unknown id before fetching anything', async () => {
    const { registry, loadBytes } = setup();
    await expect(registry.ensure(target, [first, 'nowhere'])).rejects.toThrow('Unknown dataset: nowhere');
    expect(loadBytes).not.toHaveBeenCalled();
  });

  it('keeps a copy: the buffer given to DuckDB is another one, and the copy survives its detaching', async () => {
    const { registry, registeredBuffers } = setup();
    await registry.ensure(target, [first]);
    const copy = registry.copyOf(first);
    expect(copy).toBeDefined();
    expect(registeredBuffers[0]).not.toBe(copy);
    registeredBuffers[0].fill(0);
    expect(copy).toEqual(new Uint8Array([...first].map((char) => char.charCodeAt(0))));
  });

  it('registers again from the kept copy after the views were reset, without fetching again', async () => {
    const { registry, loadBytes, registerBuffer, createView } = setup();
    await registry.ensure(target, [first]);
    registry.resetViews();
    await registry.ensure(target, [first]);
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(registerBuffer).toHaveBeenCalledTimes(2);
    expect(createView).toHaveBeenCalledTimes(2);
    expect(registerBuffer.mock.calls[1][2]).not.toBe(registerBuffer.mock.calls[0][2]);
  });

  it('forgets the copies on clear', async () => {
    const { registry, loadBytes } = setup();
    await registry.ensure(target, [first]);
    registry.clear();
    expect(registry.copyOf(first)).toBeUndefined();
    await registry.ensure(target, [first]);
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it('lets a failed fetch be tried again', async () => {
    const { registry, loadBytes } = setup();
    loadBytes.mockRejectedValueOnce(new Error('network'));
    await expect(registry.ensure(target, [first])).rejects.toThrow('network');
    await registry.ensure(target, [first]);
    expect(loadBytes).toHaveBeenCalledTimes(2);
  });

  it('does not fetch a file twice or create a view twice when a worker is replaced during a registration', async () => {
    const { registry, loadBytes, createView, registerBuffer } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadBytes.mockImplementationOnce(async () => {
      await gate;
      return new Uint8Array([1]);
    });
    const old = registry.ensure('old-worker', [first]);
    const rejected = expect(old).rejects.toThrow('restarted');
    registry.resetViews();
    const fresh = registry.ensure('new-worker', [first]);
    release();
    await Promise.all([rejected, fresh]);
    expect(loadBytes).toHaveBeenCalledTimes(1);
    expect(createView).toHaveBeenCalledTimes(1);
    expect(createView).toHaveBeenCalledWith('new-worker', first, datasetFileName(first));
    expect(registerBuffer).toHaveBeenCalledTimes(1);
  });

  it('does not keep a file that arrives after clear', async () => {
    const { registry, loadBytes } = setup();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    loadBytes.mockImplementationOnce(async () => {
      await gate;
      return new Uint8Array([1]);
    });
    const pending = registry.ensure(target, [first]);
    const rejected = expect(pending).rejects.toThrow('restarted');
    registry.clear();
    release();
    await rejected;
    expect(registry.copyOf(first)).toBeUndefined();
  });

  it('does not register for a worker that is no longer the current one, and does not record the view', async () => {
    const { registry, current, createView, registerBuffer } = setup();
    current.target = 'new-worker';
    await expect(registry.ensure('old-worker', [first])).rejects.toThrow('restarted');
    expect(registerBuffer).not.toHaveBeenCalled();
    expect(createView).not.toHaveBeenCalled();
    await registry.ensure('new-worker', [first]);
    expect(createView).toHaveBeenCalledTimes(1);
  });

  it('does not record a view when the worker was replaced during its CREATE VIEW', async () => {
    const { registry, current, createView } = setup();
    createView.mockImplementationOnce(async () => {
      current.target = 'new-worker';
    });
    await registry.ensure(target, [first]);
    current.target = target;
    await registry.ensure(target, [first]);
    expect(createView).toHaveBeenCalledTimes(2);
  });
});
