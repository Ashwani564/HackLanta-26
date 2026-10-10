// Tiny key-value store for bot state (chat history, day logs, message dedupe).
// DynamoDB when STATE_TABLE is set (Lambda); in-memory otherwise (local streaming bot).
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const TABLE = process.env.STATE_TABLE;
const ddb = TABLE ? new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-2" }) : undefined;
const memory = new Map<string, { value: unknown; expires?: number }>();

const now = () => Math.floor(Date.now() / 1000);

export async function getState<T>(key: string): Promise<T | undefined> {
  if (!ddb) {
    const hit = memory.get(key);
    return hit && (!hit.expires || hit.expires > now()) ? (hit.value as T) : undefined;
  }
  const res = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: key } }, ConsistentRead: true }));
  const item = res.Item;
  if (!item?.data?.S) return undefined;
  if (item.ttl?.N && Number(item.ttl.N) <= now()) return undefined;
  return JSON.parse(item.data.S) as T;
}

export async function putState(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
  const expires = ttlSeconds ? now() + ttlSeconds : undefined;
  if (!ddb) {
    memory.set(key, { value, ...(expires && { expires }) });
    return;
  }
  await ddb.send(
    new PutItemCommand({
      TableName: TABLE,
      Item: { pk: { S: key }, data: { S: JSON.stringify(value) }, ...(expires && { ttl: { N: String(expires) } }) },
    }),
  );
}

/** True the first time a key is claimed; false if it was already claimed (dedupe for at-least-once delivery). */
export async function claimOnce(key: string, ttlSeconds = 86400): Promise<boolean> {
  if (!ddb) {
    if (memory.has(key)) return false;
    memory.set(key, { value: 1, expires: now() + ttlSeconds });
    return true;
  }
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: { pk: { S: key }, data: { S: "1" }, ttl: { N: String(now() + ttlSeconds) } },
        ConditionExpression: "attribute_not_exists(pk)",
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

/**
 * A short lease (a lock that frees itself): true if you got it. Unlike claimOnce, a lease whose time has run out
 * can be taken again, since DynamoDB's TTL cleanup can lag by hours. Release it with releaseLease when done.
 */
export async function leaseOnce(key: string, seconds: number): Promise<boolean> {
  if (!ddb) {
    const hit = memory.get(key);
    if (hit && (!hit.expires || hit.expires > now())) return false;
    memory.set(key, { value: 1, expires: now() + seconds });
    return true;
  }
  try {
    await ddb.send(
      new PutItemCommand({
        TableName: TABLE,
        Item: { pk: { S: key }, data: { S: "1" }, ttl: { N: String(now() + seconds) } },
        ConditionExpression: "attribute_not_exists(pk) OR #t < :now",
        ExpressionAttributeNames: { "#t": "ttl" },
        ExpressionAttributeValues: { ":now": { N: String(now()) } },
      }),
    );
    return true;
  } catch (err) {
    if (err instanceof ConditionalCheckFailedException) return false;
    throw err;
  }
}

export async function releaseLease(key: string): Promise<void> {
  if (!ddb) {
    memory.delete(key);
    return;
  }
  await ddb.send(new DeleteItemCommand({ TableName: TABLE, Key: { pk: { S: key } } }));
}
