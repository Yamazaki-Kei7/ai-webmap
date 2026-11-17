import { ApiError, DistributedTableErrors } from '@aws-blocks/blocks';
import { describe, expect, it } from 'vitest';
import { mapsConfig } from '../shared/config';
import { mapsErrors, mapsStatus } from '../shared/maps';
import type { PersistedMapState } from '../shared/persistedMap';
import { deleteMapRecord, getMapRecord, listMapRecords, saveMapRecord, unwrapMapInput, type MapRecord, type MapsTable } from './maps-access';
import { checkSaveMap, type CheckedSaveMap } from './maps-input';

const state: PersistedMapState = {
  version: 1,
  view: { center: [139.7, 35.7], zoom: 9 },
  layers: [{ id: 'L1', name: 'Schools', sql: 'SELECT 1', style: { type: 'single', color: '#1f78b4' }, label: null, visible: true }],
  nextLayerSeq: 2
};

function checked(extra: Partial<CheckedSaveMap> = {}): CheckedSaveMap {
  const result = checkSaveMap({ title: 'My map', state });
  if (!result.ok) throw new Error(result.message);
  return { ...result.value, ...extra };
}

/** A fake table: the records by `userId` and `mapId`. Its reads and writes keep to the keys they are given, as the real one does. */
function fakeTable(records: MapRecord[] = []) {
  const rows = new Map(records.map((record) => [`${record.userId}/${record.mapId}`, record]));
  const calls: string[] = [];
  // Runs once, right after the next `get` has answered: another request getting in between the read and the write.
  const hooks: { afterGet?: () => void } = {};
  const conditionFailure = (): Error => {
    const error = new Error('condition failed');
    error.name = DistributedTableErrors.ConditionalCheckFailed;
    return error;
  };
  const table: MapsTable = {
    async get({ userId, mapId }) {
      calls.push(`get ${userId}`);
      const found = rows.get(`${userId}/${mapId}`) ?? null;
      const hook = hooks.afterGet;
      hooks.afterGet = undefined;
      hook?.();
      return found;
    },
    async put(item, options) {
      calls.push(`put ${item.userId}`);
      const key = `${item.userId}/${item.mapId}`;
      if (options && 'ifNotExists' in options && rows.has(key)) throw conditionFailure();
      if (options && 'ifFieldEquals' in options && rows.get(key)?.updatedAt !== options.ifFieldEquals.updatedAt) throw conditionFailure();
      rows.set(key, item);
    },
    async delete({ userId, mapId }, options) {
      calls.push(`delete ${userId}`);
      if (options?.ifExists && !rows.has(`${userId}/${mapId}`)) throw conditionFailure();
      rows.delete(`${userId}/${mapId}`);
    },
    async *query({ where }) {
      calls.push(`query ${where.userId.equals}`);
      for (const record of rows.values()) if (record.userId === where.userId.equals) yield record;
    }
  };
  return { table, rows, calls, hooks };
}

const record = (userId: string, mapId: string, updatedAt: number, extra: Partial<MapRecord> = {}): MapRecord => ({
  userId,
  mapId,
  title: `Map ${mapId}`,
  state: JSON.stringify(state),
  createdAt: 1,
  updatedAt,
  ...extra
});

async function rejection<T>(promise: Promise<T>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected a rejection');
}

describe('unwrapMapInput', () => {
  it('returns the value of a passed check', () => {
    expect(unwrapMapInput({ ok: true, value: 5 })).toBe(5);
  });

  it('turns a failed check into a 400 with the saved-maps error name and the message', () => {
    try {
      unwrapMapInput({ ok: false, message: 'Invalid map id' });
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ status: mapsStatus.badRequest, name: mapsErrors.InvalidRequest, message: 'Invalid map id' });
      return;
    }
    throw new Error('expected a throw');
  });
});

const deps = { now: () => 1_000, newMapId: () => 'new-id' };

describe('saveMapRecord', () => {
  it('creates a map owned by the caller, with the id and the time it was given', async () => {
    const { table, rows } = fakeTable();
    await expect(saveMapRecord(table, 'alice', checked({ conversationId: 'c1' }), deps)).resolves.toEqual({ mapId: 'new-id', updatedAt: 1_000 });
    expect(rows.get('alice/new-id')).toEqual({
      userId: 'alice',
      mapId: 'new-id',
      title: 'My map',
      state: JSON.stringify(state),
      conversationId: 'c1',
      createdAt: 1_000,
      updatedAt: 1_000
    });
  });

  it('stores no conversation id when none is given', async () => {
    const { table, rows } = fakeTable();
    await saveMapRecord(table, 'alice', checked(), deps);
    expect(rows.get('alice/new-id')).not.toHaveProperty('conversationId');
  });

  it('refuses a new map at the per-user limit with a 409 and a name, and writes nothing', async () => {
    const full = Array.from({ length: mapsConfig.maxMapsPerUser }, (_, n) => record('alice', `m${n}`, n));
    const { table, rows } = fakeTable([...full, record('bob', 'b1', 1)]);
    const error = await rejection(saveMapRecord(table, 'alice', checked(), deps));
    expect([error.status, error.name]).toEqual([mapsStatus.conflict, mapsErrors.LimitReached]);
    expect(rows.size).toBe(mapsConfig.maxMapsPerUser + 1);
  });

  it('counts only the caller\'s maps, so a full user does not block another', async () => {
    const full = Array.from({ length: mapsConfig.maxMapsPerUser }, (_, n) => record('alice', `m${n}`, n));
    const { table } = fakeTable(full);
    await expect(saveMapRecord(table, 'bob', checked(), deps)).resolves.toMatchObject({ mapId: 'new-id' });
  });

  it('accepts a new map just under the limit', async () => {
    const almost = Array.from({ length: mapsConfig.maxMapsPerUser - 1 }, (_, n) => record('alice', `m${n}`, n));
    const { table } = fakeTable(almost);
    await expect(saveMapRecord(table, 'alice', checked(), deps)).resolves.toMatchObject({ mapId: 'new-id' });
  });

  it('updates the caller\'s map: new title, state and time, the creation time kept; an update is not counted against the limit', async () => {
    const full = Array.from({ length: mapsConfig.maxMapsPerUser }, (_, n) => record('alice', `m${n}`, n, { createdAt: 5 }));
    const { table, rows } = fakeTable(full);
    const result = await saveMapRecord(table, 'alice', checked({ mapId: 'm3', title: 'Renamed' }), deps);
    expect(result).toEqual({ mapId: 'm3', updatedAt: 1_000 });
    expect(rows.get('alice/m3')).toMatchObject({ title: 'Renamed', createdAt: 5, updatedAt: 1_000 });
    expect(rows.size).toBe(mapsConfig.maxMapsPerUser);
  });

  it('answers 404 to an update of another user\'s map or of one that does not exist, and writes nothing', async () => {
    const { table, rows, calls } = fakeTable([record('bob', 'b1', 1)]);
    for (const mapId of ['b1', 'nothing']) {
      const error = await rejection(saveMapRecord(table, 'alice', checked({ mapId }), deps));
      expect([error.status, error.name]).toEqual([mapsStatus.notFound, mapsErrors.NotFound]);
    }
    expect(rows.get('bob/b1')).toEqual(record('bob', 'b1', 1));
    expect(calls.filter((call) => call.startsWith('put'))).toEqual([]);
  });
});

describe('saveMapRecord: an update that races another request', () => {
  it('is a 409 with a name, and does not bring back a map deleted between its read and its write', async () => {
    const { table, rows, hooks } = fakeTable([record('alice', 'm1', 5)]);
    hooks.afterGet = () => rows.delete('alice/m1');
    const error = await rejection(saveMapRecord(table, 'alice', checked({ mapId: 'm1' }), deps));
    expect([error.status, error.name]).toEqual([mapsStatus.conflict, mapsErrors.Conflict]);
    expect(rows.size).toBe(0);
  });

  it('is a 409 and keeps the newer save when another save got in between', async () => {
    const { table, rows, hooks } = fakeTable([record('alice', 'm1', 5)]);
    hooks.afterGet = () => rows.set('alice/m1', record('alice', 'm1', 9, { title: 'Newer' }));
    const error = await rejection(saveMapRecord(table, 'alice', checked({ mapId: 'm1' }), deps));
    expect([error.status, error.name]).toEqual([mapsStatus.conflict, mapsErrors.Conflict]);
    expect(rows.get('alice/m1')).toMatchObject({ title: 'Newer', updatedAt: 9 });
  });

  it('lets a failure that is not a failed condition through unchanged, and keeps the record', async () => {
    const { table, rows } = fakeTable([record('alice', 'm1', 5)]);
    const failing: MapsTable = { ...table, put: async () => { throw new TypeError('network'); } };
    await expect(saveMapRecord(failing, 'alice', checked({ mapId: 'm1' }), deps)).rejects.toBeInstanceOf(TypeError);
    expect(rows.get('alice/m1')?.updatedAt).toBe(5);
  });
});

describe('listMapRecords', () => {
  it('lists the caller\'s maps newest first, without the state, and none of another user\'s', async () => {
    const { table } = fakeTable([record('alice', 'old', 1), record('bob', 'b1', 9), record('alice', 'new', 3), record('alice', 'mid', 2)]);
    const { maps } = await listMapRecords(table, 'alice');
    expect(maps.map(({ mapId }) => mapId)).toEqual(['new', 'mid', 'old']);
    for (const map of maps) expect(Object.keys(map).sort()).toEqual(['mapId', 'title', 'updatedAt']);
  });

  it('lists nothing for a user without maps', async () => {
    expect(await listMapRecords(fakeTable().table, 'alice')).toEqual({ maps: [] });
  });
});

describe('getMapRecord', () => {
  it('returns the caller\'s map with its state parsed, and the conversation id when there is one', async () => {
    const mapId = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
    const conversationId = '9a7c1d2e-8b3f-4c6a-a1e5-0d4b7f2c9e18';
    const { table } = fakeTable([record('alice', mapId, 7, { conversationId })]);
    await expect(getMapRecord(table, 'alice', mapId)).resolves.toEqual({ mapId, title: `Map ${mapId}`, state, conversationId, updatedAt: 7 });
    const without = fakeTable([record('alice', mapId, 7)]).table;
    expect(await getMapRecord(without, 'alice', mapId)).not.toHaveProperty('conversationId');
  });

  it('answers 404 for another user\'s map and for a missing one alike', async () => {
    const { table } = fakeTable([record('bob', 'b1', 1)]);
    for (const mapId of ['b1', 'nothing']) {
      const error = await rejection(getMapRecord(table, 'alice', mapId));
      expect([error.status, error.name]).toEqual([mapsStatus.notFound, mapsErrors.NotFound]);
    }
  });

  it('answers a named 500 for a record whose state is not JSON, or not a valid state, or whose title is invalid', async () => {
    const mapId = '3f2b8c1e-5d4a-4b7e-9c1d-2a6f8e0b1c3d';
    const bad = [
      record('alice', mapId, 1, { state: '{not json' }),
      record('alice', mapId, 1, { state: JSON.stringify({ ...state, version: 9 }) }),
      record('alice', mapId, 1, { state: JSON.stringify({ ...state, features: [] }) }),
      record('alice', mapId, 1, { title: '' })
    ];
    for (const stored of bad) {
      const error = await rejection(getMapRecord(fakeTable([stored]).table, 'alice', mapId));
      expect([error.status, error.name]).toEqual([mapsStatus.serverError, mapsErrors.Corrupt]);
    }
  });
});

describe('deleteMapRecord', () => {
  it('deletes the caller\'s map', async () => {
    const { table, rows } = fakeTable([record('alice', 'm1', 1)]);
    await expect(deleteMapRecord(table, 'alice', 'm1')).resolves.toEqual({ success: true });
    expect(rows.size).toBe(0);
  });

  it('answers 404 for another user\'s map and a missing one, and deletes nothing', async () => {
    const { table, rows } = fakeTable([record('bob', 'b1', 1)]);
    for (const mapId of ['b1', 'nothing']) {
      const error = await rejection(deleteMapRecord(table, 'alice', mapId));
      expect([error.status, error.name]).toEqual([mapsStatus.notFound, mapsErrors.NotFound]);
    }
    expect(rows.size).toBe(1);
  });

  it('is one conditional delete, with no read first', async () => {
    const { table, calls } = fakeTable([record('alice', 'm1', 1)]);
    await deleteMapRecord(table, 'alice', 'm1');
    expect(calls).toEqual(['delete alice']);
  });

  it('lets a failure that is not a failed condition through unchanged', async () => {
    const failing: MapsTable = { ...fakeTable().table, delete: async () => { throw new TypeError('network'); } };
    await expect(deleteMapRecord(failing, 'alice', 'm1')).rejects.toBeInstanceOf(TypeError);
  });
});
