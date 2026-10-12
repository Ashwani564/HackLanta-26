// Tiny key-value store for bot state (chat history, day logs, message dedupe).
// DynamoDB when STATE_TABLE is set (Lambda); in memory, saved to a local file, otherwise (streaming bot, no AWS).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { ConditionalCheckFailedException, DeleteItemCommand, DynamoDBClient, GetItemCommand, PutItemCommand } from "@aws-sdk/client-dynamodb";

const TABLE = process.env.STATE_TABLE;
const ddb = TABLE ? new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-2" }) : undefined;
// Without DynamoDB, state lives in memory and is saved to a JSON file (STATE_FILE) so a restart keeps chats, meals
// and plans. Writes are batched a moment after the last change.
const STATE_FILE = process.env.STATE_FILE ?? ".snacxx-state.json";
type Entry = { value: unknown; expires?: number };
class SavedMap extends Map<string, Entry> {
  private timer: NodeJS.Timeout | undefined;
  private persist() {
    if (ddb || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const live = [...this.entries()].filter(([, e]) => !e.expires || e.expires > now());
      writeFileSync(`${STATE_FILE}.tmp`, JSON.stringify(live));
      renameSync(`${STATE_FILE}.tmp`, STATE_FILE);
    }, 500);
    this.timer.unref?.();
  }
  override set(key: string, value: Entry) {
    super.set(key, value);
    this.persist();
    return this;
  }
  override delete(key: string) {
    const had = super.delete(key);
    this.persist();
    return had;
  }
}
const memory = new SavedMap();
if (!ddb && existsSync(STATE_FILE)) {
  try {
    for (const [k, e] of JSON.parse(readFileSync(STATE_FILE, "utf8")) as [string, Entry][]) Map.prototype.set.call(memory, k, e);
  } catch (err) {
    console.warn(`  couldn't read ${STATE_FILE}, starting fresh: ${(err as Error).message}`);
  }
}

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
