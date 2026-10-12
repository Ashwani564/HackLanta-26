import assert from "node:assert/strict";
import test from "node:test";
import { converse, fromOpenAiChoice, toOpenAiMessages } from "../../src/llm/converse.js";
import { catalog, restaurantsLocal, searchLocal } from "../../src/rag/local.js";
import type { Constraints } from "../../src/types.js";
import { planArgs } from "../../bot/src/llm.js";

const none: Constraints = { allergens: [], unmappedAllergyTerms: [], diets: [], excludeTerms: [] };

test("plan requests are read in code: people, meal, day and time", () => {
  assert.deepEqual(planArgs("schedule dinner today with ashwani and princy"), { people: ["ashwani", "princy"], meal: "dinner", day: "today" });
  assert.deepEqual(planArgs("wanna grab lunch tomorrow with ash, princy & dev at 1pm?"), { people: ["ash", "princy", "dev"], meal: "lunch", day: "tomorrow", time: "1pm" });
  assert.deepEqual(planArgs("i'm gonna grab dinner with princy can you figure out the time and place"), { people: ["princy"], meal: "dinner", day: "today" });
});

test("Converse history becomes OpenAI messages, tool results included, and the answer comes back as Converse", () => {
  const msgs = toOpenAiMessages({
    system: [{ text: "be nice" }],
    messages: [
      { role: "user", content: [{ text: "i'm hungry" }] },
      { role: "assistant", content: [{ toolUse: { toolUseId: "t1", name: "get_location", input: {} } }] },
      { role: "user", content: [{ toolResult: { toolUseId: "t1", content: [{ json: { result: { place: "campus" } } }] } }] },
    ],
  });
  assert.deepEqual(msgs.map((m) => m.role), ["system", "user", "assistant", "tool"]);
  assert.equal((msgs[3] as { tool_call_id: string }).tool_call_id, "t1");

  const out = fromOpenAiChoice({ message: { content: null, tool_calls: [{ id: "c1", function: { name: "log_meal", arguments: '{"name":"burrito","calories":800}' } }] } });
  assert.equal(out.stopReason, "tool_use");
  assert.deepEqual(out.output?.message?.content?.[0]?.toolUse?.input, { name: "burrito", calories: 800 });
  assert.equal(fromOpenAiChoice({ message: { content: "yo" }, finish_reason: "stop" }).stopReason, "end_turn");
});

test("the free model is retried when it's rate-limited", async () => {
  process.env.FREE_LLM_MIN_GAP_MS = "1";
  let calls = 0;
  const fake = (async () => {
    calls++;
    if (calls === 1) return new Response("slow down", { status: 402 });
    return Response.json({ choices: [{ message: { content: "hey" }, finish_reason: "stop" }] });
  }) as typeof fetch;
  const saved = process.env.BEDROCK_MODEL_ID;
  delete process.env.BEDROCK_MODEL_ID;
  const res = await converse(undefined, { modelId: "free", messages: [{ role: "user", content: [{ text: "hi" }] }] }, fake);
  if (saved) process.env.BEDROCK_MODEL_ID = saved;
  assert.equal(calls, 2);
  assert.equal(res.output?.message?.content?.[0]?.text, "hey");
});

test("menus without a database: the local catalog keeps the hard allergy filter", () => {
  assert.ok(catalog().length > 100);
  const peanut: Constraints = { ...none, allergens: ["peanuts"] };
  const hits = searchLocal("chicken", peanut, 40);
  assert.ok(hits.length > 0);
  for (const d of hits) assert.ok(d.allergensKnown && !d.allergens.includes("peanuts"), `${d.dishName} must not reach a peanut allergy`);
  assert.ok(hits[0]!.similarity >= hits[hits.length - 1]!.similarity);
  const spots = restaurantsLocal(none, ["meal"]);
  assert.ok(spots.length >= 5 && spots.every((r) => r.dishCount > 0));
});
