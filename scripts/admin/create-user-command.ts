/**
 * The part of `admin:create-user` that decides what is written and how the outcome is read.
 * The AWS call is injected (`send`), so it runs against a stub in tests and makes no call by itself.
 */
import { ConditionalCheckFailedException, type PutItemCommandInput } from '@aws-sdk/client-dynamodb';
import { buildUserItem, keyAttribute, type UserItem } from './user-record.js';

/** Sends one put. Any failure is thrown as it came. */
export type SendPut = (input: PutItemCommandInput) => Promise<void>;

export type CreateUserInput = { tableName: string; username: string; password: string; now: Date; send: SendPut };

export type CreateUserResult = { status: 'created' } | { status: 'exists' } | { status: 'invalid'; message: string };

const keyNamePlaceholder = '#key';

/** The write is refused when the key exists, so an existing user is never overwritten. */
export const notExistsCondition = `attribute_not_exists(${keyNamePlaceholder})`;

export function buildPutInput(tableName: string, item: UserItem): PutItemCommandInput {
  return {
    TableName: tableName,
    Item: item,
    ConditionExpression: notExistsCondition,
    ExpressionAttributeNames: { [keyNamePlaceholder]: keyAttribute },
  };
}

export async function createUser({ tableName, username, password, now, send }: CreateUserInput): Promise<CreateUserResult> {
  const built = await buildUserItem({ username, password, now });
  if (!built.ok) return { status: 'invalid', message: built.message };
  try {
    await send(buildPutInput(tableName, built.item));
  } catch (error) {
    if (error instanceof ConditionalCheckFailedException) return { status: 'exists' };
    throw error;
  }
  return { status: 'created' };
}
