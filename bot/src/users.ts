// Saved profiles for known people (one item per phone number in USERS_TABLE). Read-only here.
// Used in one-on-one chats only: a profile must never be read into a group chat's context.
import { existsSync, readFileSync } from "node:fs";
import { DynamoDBClient, GetItemCommand, ScanCommand, type AttributeValue } from "@aws-sdk/client-dynamodb";

const TABLE = process.env.USERS_TABLE;
const ddb = TABLE ? new DynamoDBClient({ region: process.env.AWS_REGION ?? "us-east-2" }) : undefined;

// Without USERS_TABLE, profiles come from USERS_JSON or a local JSON file (USERS_FILE): [{ phone, name, allergies, diets, goal?, budgetMaxUsd? }].
const USERS_FILE = process.env.USERS_FILE ?? "users.local.json";
function localUsers(): UserProfile[] {
  // USERS_JSON (the same list, as a setting) is for hosts where files don't survive a restart, like Render.
  const raw = process.env.USERS_JSON ?? (existsSync(USERS_FILE) ? readFileSync(USERS_FILE, "utf8") : undefined);
  if (!raw) return [];
  try {
    return (JSON.parse(raw) as UserProfile[]).map((u) => ({ ...u, allergies: u.allergies ?? [], diets: u.diets ?? [] }));
  } catch (err) {
    console.warn(`  couldn't read ${USERS_FILE}: ${(err as Error).message}`);
    return [];
  }
}

export interface UserProfile {
  phone: string;
  name: string;
  allergies: string[];
  diets: string[];
  goal?: string;
  budgetMaxUsd?: number;
}

/** "7739986828", "(773) 998-6828" and "+17739986828" are the same person. US numbers only for now. */
export function normalizePhone(id: string): string | undefined {
  const digits = id.replace(/\D/g, "");
  if (!/^[\d\s().+-]+$/.test(id.trim())) return undefined; // an Apple ID email, a group id, "unknown", ""
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  return digits.length >= 8 ? `+${digits}` : undefined;
}

/** A DynamoDB list or string set of strings, in whichever shape it was written. */
function strings(v: AttributeValue | undefined): string[] {
  const raw = v?.SS ?? v?.L?.map((x) => x.S ?? "") ?? [];
  return raw.map((s) => s.trim().toLowerCase()).filter(Boolean);
}

/** The saved profile for whoever is texting, or undefined (not in the table, no table, or a lookup error). */
export async function getUser(senderId: string | undefined): Promise<UserProfile | undefined> {
  const phone = senderId ? normalizePhone(senderId) : undefined;
  if (!phone) return undefined;
  if (!ddb) return localUsers().find((u) => normalizePhone(u.phone) === phone);
  try {
    const { Item } = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { phone: { S: phone } } }));
    if (!Item?.name?.S) return undefined;
    const budget = Item.budget_max_usd?.N ? Number(Item.budget_max_usd.N) : undefined;
    return {
      phone,
      name: Item.name.S,
      allergies: strings(Item.allergies),
      diets: strings(Item.diet),
      ...(Item.goal?.S && { goal: Item.goal.S }),
      ...(budget && budget > 0 && { budgetMaxUsd: budget }),
    };
  } catch (err) {
    // A failed lookup must not stop the reply; the bot just doesn't know who this is.
    console.warn(`  profile lookup failed: ${(err as Error).message}`);
    return undefined;
  }
}

/** Everyone with a saved profile (a handful of people, so a scan is fine). Names and phones only: nobody's health details leave this file. */
export async function listProfiles(): Promise<{ name: string; phone: string }[]> {
  if (!ddb) return localUsers().map(({ name, phone }) => ({ name, phone }));
  const { Items } = await ddb.send(new ScanCommand({ TableName: TABLE, ProjectionExpression: "phone, #n", ExpressionAttributeNames: { "#n": "name" } }));
  return (Items ?? []).flatMap((i) => (i.phone?.S && i.name?.S ? [{ name: i.name.S, phone: i.phone.S }] : []));
}
