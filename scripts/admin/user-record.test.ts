import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { decodeItemRecord } from './test-support.js';
import { bcryptCost, buildUserItem, emptyUsernameMessage, keyAttribute, passwordViolations, valueAttribute } from './user-record.js';

const now = new Date('2026-01-02T03:04:05.678Z');
const password = 'correct-horse-9';

async function build(username: string, pw = password) {
  const built = await buildUserItem({ username, password: pw, now });
  if (!built.ok) throw new Error(`expected a record, got: ${built.message}`);
  return built;
}

describe('buildUserItem', () => {
  it('stores a bcrypt hash of the password at the block cost, and the given time', async () => {
    const { item, record } = await build('someone');
    const decoded = decodeItemRecord(item);
    expect(decoded).toEqual(record);
    expect(bcrypt.getRounds(decoded.hash)).toBe(bcryptCost);
    expect(await bcrypt.compare(password, decoded.hash)).toBe(true);
    expect(await bcrypt.compare(`${password}x`, decoded.hash)).toBe(false);
    expect(decoded.createdAt).toBe(now.toISOString());
  });

  it('has exactly the key and value attributes, both strings, and no plain password anywhere', async () => {
    const { item } = await build('someone');
    expect(Object.keys(item).sort()).toEqual([keyAttribute, valueAttribute].sort());
    expect(item[keyAttribute]).toEqual({ S: 'someone' });
    expect(JSON.stringify(item)).not.toContain(password);
  });

  it('encodes the value twice: a JSON string literal that holds the record JSON', async () => {
    const { item } = await build('someone');
    const once = JSON.parse(item[valueAttribute].S);
    expect(typeof once).toBe('string');
    expect(once.startsWith('{')).toBe(true);
  });

  it('keeps the name exactly as given: no trimming, no case folding', async () => {
    const keys = await Promise.all([' a ', 'A', 'a'].map(async (name) => (await build(name)).item[keyAttribute].S));
    expect(keys).toEqual([' a ', 'A', 'a']);
    expect(new Set(keys).size).toBe(3);
  });

  it('refuses an empty name', async () => {
    expect(await buildUserItem({ username: '', password, now })).toEqual({ ok: false, message: emptyUsernameMessage });
  });

  it('refuses a password that fails the policy, naming the rule and never echoing the password', async () => {
    const tooShort = 'abc1234';
    const result = await buildUserItem({ username: 'someone', password: tooShort, now });
    expect(result).toEqual({ ok: false, message: 'Password must contain at least 8 characters' });
    expect(JSON.stringify(result)).not.toContain(tooShort);
  });

  it('accepts a password of exactly the minimum length', async () => {
    expect((await buildUserItem({ username: 'someone', password: 'abcd1234', now })).ok).toBe(true);
  });
});

describe('passwordViolations', () => {
  it('lists every unmet rule of a policy, as the block does', () => {
    expect(
      passwordViolations('abc', { minLength: 4, requireUppercase: true, requireLowercase: true, requireDigits: true, requireSpecialChars: true }),
    ).toEqual(['at least 4 characters', 'an uppercase letter', 'a digit', 'a special character']);
  });

  it('applies the default minimum when the policy sets none', () => {
    expect(passwordViolations('1234567', {})).toEqual(['at least 8 characters']);
    expect(passwordViolations('12345678', {})).toEqual([]);
  });
});
