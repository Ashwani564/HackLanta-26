import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizePhone } from "../../bot/src/users.js";
import { mergeRestrictions } from "../../bot/src/dining.js";

test("phone numbers match however they arrive, and non-numbers never match", () => {
  for (const id of ["+17739986828", "7739986828", "773-998-6828", "(773) 998-6828", "17739986828"]) assert.equal(normalizePhone(id), "+17739986828", id);
  assert.equal(normalizePhone("+16624978806"), "+16624978806");
  for (const id of ["someone@icloud.com", "unknown", "any;+;chat123", ""]) assert.equal(normalizePhone(id), undefined, id);
});

test("a saved profile is applied on every call and survives a chat reset", async () => {
  const profile = { allergies: ["fish"], diets: ["halal"] };
  const first = await mergeRestrictions("t-space-1", { allergies: ["peanut"] }, profile);
  assert.deepEqual(first, { allergies: ["fish", "peanut"], diets: ["halal"] });
  // nothing from the profile was written into the chat's own state
  const bare = await mergeRestrictions("t-space-1", {});
  assert.deepEqual(bare, { allergies: ["peanut"], diets: [] });
});
