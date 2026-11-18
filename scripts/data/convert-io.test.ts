import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { partialPath, publishChecked } from './convert-io.js';
import { openMemoryDatabase } from './sql-test-support.js';

// The one test that writes files: in a directory of its own under the OS temp directory (never inside the repository).
describe('publishChecked', () => {
  let root = '';
  let tempDir = '';
  let distDir = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'publish-checked-'));
    tempDir = join(root, 'work');
    distDir = join(root, 'dist');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  async function publish(check: (written: string) => Promise<string>): Promise<string> {
    const connection = await openMemoryDatabase();
    await connection.run('CREATE TABLE t AS SELECT 1 AS a');
    mkdirSync(tempDir);
    mkdirSync(distDir);
    return publishChecked(connection, { query: 'SELECT * FROM t', file: join(distDir, 'out.parquet'), tempDir, check });
  }

  it('moves the file into the output folder when the check passes, and leaves no temporary file', async () => {
    const seen: string[] = [];
    const result = await publish(async (written) => {
      seen.push(written);
      expect(existsSync(written)).toBe(true);
      expect(existsSync(join(distDir, 'out.parquet'))).toBe(false);
      return 'ok';
    });
    expect(result).toBe('ok');
    expect(seen).toEqual([partialPath(tempDir, join(distDir, 'out.parquet'))]);
    expect(existsSync(join(distDir, 'out.parquet'))).toBe(true);
    expect(readdirSync(tempDir)).toEqual([]);
  });

  it('leaves nothing at the destination and no temporary file when the check fails, and passes the error on', async () => {
    await expect(
      publish(async () => {
        throw new Error('check failed');
      })
    ).rejects.toThrow('check failed');
    expect(readdirSync(distDir)).toEqual([]);
    expect(readdirSync(tempDir)).toEqual([]);
  });
});
