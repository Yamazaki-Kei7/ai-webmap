import { ConditionalCheckFailedException, type PutItemCommandInput } from '@aws-sdk/client-dynamodb';
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { createUser, notExistsCondition, type SendPut } from './create-user-command.js';
import { decodeItemRecord } from './test-support.js';
import { buildUserItem, keyAttribute } from './user-record.js';

const now = new Date('2026-01-02T03:04:05.678Z');
const tableName = 'table-name-under-test';
const username = 'someone';
const password = 'correct-horse-9';

/** A stub for the AWS call: remembers what it was given. No AWS client exists in these tests. */
function recordingSend(): { send: SendPut; sent: PutItemCommandInput[] } {
  const sent: PutItemCommandInput[] = [];
  return {
    sent,
    send: async (input) => {
      sent.push(input);
    },
  };
}

describe('createUser', () => {
  it('sends one put to the given table, refused when the key exists', async () => {
    const { send, sent } = recordingSend();
    expect(await createUser({ tableName, username, password, now, send })).toEqual({ status: 'created' });
    expect(sent).toHaveLength(1);
    const [input] = sent;
    expect(input.TableName).toBe(tableName);
    expect(input.ConditionExpression).toBe(notExistsCondition);
    expect(input.ConditionExpression).toBe('attribute_not_exists(#key)');
    expect(input.ExpressionAttributeNames).toEqual({ '#key': keyAttribute });
  });

  it('sends the item the record builder produces', async () => {
    const { send, sent } = recordingSend();
    await createUser({ tableName, username, password, now, send });
    const built = await buildUserItem({ username, password, now });
    if (!built.ok) throw new Error('expected a record');
    const item = sent[0].Item;
    expect(item?.[keyAttribute]).toEqual(built.item[keyAttribute]);
    // The salt differs between two hashes, so compare the decoded record, not the bytes.
    const sentRecord = decodeItemRecord({ pk: { S: username }, value: { S: item?.value?.S ?? '' } });
    expect(sentRecord.createdAt).toBe(built.record.createdAt);
    expect(await bcrypt.compare(password, sentRecord.hash)).toBe(true);
  });

  it('reports an existing user when the condition fails', async () => {
    const send: SendPut = async () => {
      throw new ConditionalCheckFailedException({ message: 'The conditional request failed', $metadata: {} });
    };
    expect(await createUser({ tableName, username, password, now, send })).toEqual({ status: 'exists' });
  });

  it('rethrows any other error untouched', async () => {
    const failure = new Error('network down');
    const send: SendPut = async () => {
      throw failure;
    };
    await expect(createUser({ tableName, username, password, now, send })).rejects.toBe(failure);
  });

  it('sends nothing for a refused password or name, and the message never contains the password', async () => {
    const { send, sent } = recordingSend();
    const weak = 'abc1234';
    const result = await createUser({ tableName, username, password: weak, now, send });
    expect(result.status).toBe('invalid');
    expect(JSON.stringify(result)).not.toContain(weak);
    expect((await createUser({ tableName, username: '', password, now, send })).status).toBe('invalid');
    expect(sent).toHaveLength(0);
  });
});
