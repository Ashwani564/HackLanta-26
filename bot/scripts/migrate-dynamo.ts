// Copy the bot's DynamoDB data from one AWS account to another. The source is only ever scanned (read-only). Nothing
// already in the target is overwritten, and only counts are printed: never keys or contents (they hold phone numbers).
//
//   tsx scripts/migrate-dynamo.ts --from-profile default --from-account 446205069613 \
//     --to-profile snacxx-new --to-account 575782835235 \
//     --state <source state table>:<target state table> --users <source users table>:<target users table> [--apply]
//
// Without --apply it only reports what it would copy. Afterwards it re-reads the target and checks every copied record
// is byte-for-byte what the source holds.
import { createHash } from "node:crypto";
import { ConditionalCheckFailedException, DescribeTableCommand, DynamoDBClient, GetItemCommand, PutItemCommand, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";

type Item = Record<string, AttributeValue>;

const args = new Map<string, string>();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) if (argv[i]!.startsWith("--")) args.set(argv[i]!.slice(2), argv[i + 1]?.startsWith("--") === false ? argv[++i]! : "true");
const need = (k: string) => args.get(k) ?? (console.error(`missing --${k}`), process.exit(1));

const REGION = process.env.AWS_REGION ?? "us-east-2";
const APPLY = args.get("apply") === "true";
const from = { profile: need("from-profile"), account: need("from-account") };
const to = { profile: need("to-profile"), account: need("to-account") };
const [stateFrom, stateTo] = need("state").split(":");
const [usersFrom, usersTo] = need("users").split(":");

/**
 * State records that are not copied:
 * - health*: Apple Health sync links and their records. The sync links name the old Function URL, so everyone reconnects instead.
 * - baseurl: the old Function URL itself; the new deployment learns its own on its first request.
 * - planlock#, msg#, voted#: short-lived locks and dedupe markers.
 */
const SKIP = /^(health|baseurl$|planlock#|msg#|voted#)/;
const kind = (pk: string) => pk.split("#")[0]!;

/** The account a table lives in, read from its ARN (arn:aws:dynamodb:<region>:<account>:table/<name>). */
async function accountOf(ddb: DynamoDBClient, table: string) {
  const { Table } = await ddb.send(new DescribeTableCommand({ TableName: table }));
  return Table?.TableArn?.split(":")[4];
}

async function scanAll(ddb: DynamoDBClient, table: string): Promise<Item[]> {
  const items: Item[] = [];
  let start: Item | undefined;
  do {
    const res = await ddb.send(new ScanCommand({ TableName: table, ConsistentRead: true, ExclusiveStartKey: start }));
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items;
}

/** The same record always gives the same digest, whatever order its attributes came back in. */
const digest = (item: Item) =>
  createHash("sha256").update(JSON.stringify(item, (_k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v).sort()) : v))).digest("hex");

const tally = (rows: string[]) => Object.entries(rows.reduce<Record<string, number>>((m, k) => ((m[k] = (m[k] ?? 0) + 1), m), {})).sort();

async function copyTable(label: string, src: DynamoDBClient, dst: DynamoDBClient, fromTable: string, toTable: string, key: string, keep: (item: Item) => boolean) {
  const now = Math.floor(Date.now() / 1000);
  const all = await scanAll(src, fromTable);
  const live = all.filter((i) => !i.ttl?.N || Number(i.ttl.N) > now);
  const chosen = live.filter(keep);
  console.log(`\n${label}: ${all.length} in source, ${all.length - live.length} already expired, ${live.length - chosen.length} skipped on purpose, ${chosen.length} to copy`);
  for (const [k, n] of tally(chosen.map((i) => kind(i[key]!.S!)))) console.log(`  ${k.padEnd(12)} ${n}`);
  if (!APPLY) return { chosen, conflicts: 0 };

  let copied = 0, same = 0, conflicts = 0;
  for (const item of chosen) {
    try {
      await dst.send(new PutItemCommand({ TableName: toTable, Item: item, ConditionExpression: "attribute_not_exists(#k)", ExpressionAttributeNames: { "#k": key } }));
      copied++;
    } catch (err) {
      if (!(err instanceof ConditionalCheckFailedException)) throw err;
      // Already there: fine if it's the same record, reported (and left alone) if it differs.
      const { Item: there } = await dst.send(new GetItemCommand({ TableName: toTable, Key: { [key]: item[key]! }, ConsistentRead: true }));
      if (there && digest(there) === digest(item)) same++;
      else conflicts++;
    }
  }
  console.log(`  written ${copied}, already identical ${same}, different record already in target (left alone) ${conflicts}`);
  return { chosen, conflicts };
}

async function verify(label: string, dst: DynamoDBClient, toTable: string, key: string, chosen: Item[]) {
  const there = new Map((await scanAll(dst, toTable)).map((i) => [i[key]!.S!, digest(i)]));
  const missing = chosen.filter((i) => !there.has(i[key]!.S!)).length;
  const differ = chosen.filter((i) => there.has(i[key]!.S!) && there.get(i[key]!.S!) !== digest(i)).length;
  console.log(`  verify ${label}: ${chosen.length - missing - differ} of ${chosen.length} match the source exactly, ${missing} missing, ${differ} different (target holds ${there.size})`);
  return missing === 0 && differ === 0;
}

const src = new DynamoDBClient({ region: REGION, profile: from.profile });
const dst = new DynamoDBClient({ region: REGION, profile: to.profile });
const accounts = await Promise.all([accountOf(src, stateFrom!), accountOf(src, usersFrom!), accountOf(dst, stateTo!), accountOf(dst, usersTo!)]);
if (accounts[0] !== from.account || accounts[1] !== from.account || accounts[2] !== to.account || accounts[3] !== to.account || from.account === to.account) {
  console.error(`account check failed: source tables are in ${accounts[0]}/${accounts[1]} (expected ${from.account}), target tables in ${accounts[2]}/${accounts[3]} (expected ${to.account})`);
  process.exit(1);
}
console.log(`source ${from.account} (read-only) -> target ${to.account}, region ${REGION}${APPLY ? "" : "  [dry run: nothing is written]"}`);
const users = await copyTable("users", src, dst, usersFrom!, usersTo!, "phone", () => true);
const state = await copyTable("state", src, dst, stateFrom!, stateTo!, "pk", (i) => !SKIP.test(i.pk!.S!));
if (APPLY) {
  const ok = (await verify("users", dst, usersTo!, "phone", users.chosen)) && (await verify("state", dst, stateTo!, "pk", state.chosen));
  console.log(ok ? "\nmigration verified" : "\nmigration NOT verified: see above");
  if (!ok) process.exitCode = 1;
}
