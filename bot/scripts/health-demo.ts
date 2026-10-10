// Usage: tsx scripts/health-demo.ts
// Starts the local web server with two sample meals logged for a made-up person, and prints the
// curl commands for the Apple Health sync routes. Nothing leaves this machine; state is in memory.
import { logMeal } from "../src/day.js";
import { syncTokenFor } from "../src/health.js";
import { startWeb } from "../src/web.js";

const user = "+15550001234";
await logMeal(user, { name: "Greek yogurt bowl", calories: 380, protein: 28, price: 6 });
await new Promise((r) => setTimeout(r, 5));
await logMeal(user, { name: "Chicken over rice", calories: 750, protein: 45, price: 11 });

const base = `http://localhost:${process.env.PORT ?? 8787}/health/${await syncTokenFor(user)}`;
startWeb();
console.log(`
sync link: ${base}

curl ${base}/pending
curl -X POST ${base}/ack -H "content-type: application/json" -d '{"ids":["<id from pending>"]}'
curl -X POST ${base}/metrics -H "content-type: application/json" -d '{"active_kcal":412,"steps":8042,"weight_lb":165}'
`);
