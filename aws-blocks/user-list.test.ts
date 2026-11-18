import { describe, expect, it } from 'vitest';
import { emptyUserList, listsHolding, parseUserList, planMerge } from './user-list';

describe('parseUserList', () => {
  it('reads an array of strings', () => {
    expect(parseUserList(['a', 'b'])).toEqual({ users: new Set(['a', 'b']), malformed: false });
  });

  it('reads the same array written as a JSON string', () => {
    expect(parseUserList('["a","b"]')).toEqual({ users: new Set(['a', 'b']), malformed: false });
  });

  it('treats the default and an unset value as empty, not malformed', () => {
    expect(parseUserList(emptyUserList)).toEqual({ users: new Set(), malformed: false });
    expect(parseUserList(undefined)).toEqual({ users: new Set(), malformed: false });
    expect(parseUserList('')).toEqual({ users: new Set(), malformed: false });
  });

  it('fails closed for anything that is not a JSON array of strings', () => {
    const bad = ['not json', '{"a":1}', 'null', '"a"', '["a", 1]', '[["a"]]', { a: 'b' }, null, 1, true, ['a', null]];
    for (const value of bad) {
      expect(parseUserList(value)).toEqual({ users: new Set(), malformed: true });
    }
  });

  it('keeps names exactly as stored: no trimming, no case folding', () => {
    const { users } = parseUserList([' a ', 'A', 'a']);
    expect([...users]).toEqual([' a ', 'A', 'a']);
  });
});

describe('planMerge', () => {
  it('adds only the missing names, keeping existing entries and their order', () => {
    expect(planMerge(['x', 'a'], ['a', 'b'])).toEqual({ next: ['x', 'a', 'b'], malformed: false });
  });

  it('plans nothing when every name is already there (idempotent)', () => {
    expect(planMerge(['a', 'b'], ['a', 'b'])).toEqual({ next: null, malformed: false });
  });

  it('starts from an unset list', () => {
    expect(planMerge(undefined, ['a'])).toEqual({ next: ['a'], malformed: false });
  });

  it('treats a malformed list as empty and replaces it with the seeded names', () => {
    expect(planMerge('not json', ['a'])).toEqual({ next: ['a'], malformed: true });
    expect(planMerge(['a', 1], ['a'])).toEqual({ next: ['a'], malformed: true });
  });

  it('never removes an entry', () => {
    const plan = planMerge(['keep-1', 'keep-2'], ['a']);
    expect(plan.next).toEqual(['keep-1', 'keep-2', 'a']);
  });
});

describe('listsHolding', () => {
  const lists = { allowed: new Set(['a', 'b']), admin: new Set(['a']) };

  it('names every list that holds the name', () => {
    expect(listsHolding('a', lists)).toEqual(['allowed', 'admin']);
    expect(listsHolding('b', lists)).toEqual(['allowed']);
  });

  it('is empty for a name on no list', () => {
    expect(listsHolding('d', lists)).toEqual([]);
  });
});
