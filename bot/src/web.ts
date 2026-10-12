// Tiny web server for the page that opens when someone taps the day card, and the Apple Health sync routes.
import { createServer, type IncomingMessage } from "node:http";
import { dayJpeg } from "./day-art.js";
import { TIME_ZONE, getDayByKey, totals, type Day } from "./day.js";
import { handleHealthRequest, healthReply, isHealthPath } from "./health.js";

const PORT = Number(process.env.PORT ?? 8787);

export function startWeb() {
  createServer(async (req, res) => {
    // For the host's health check and the uptime pinger that keeps a free instance awake.
    if (req.url === "/healthz") {
      res.writeHead(200, { "content-type": "text/plain" }).end("ok");
      return;
    }
    if (isHealthPath(req.url ?? "")) {
      const ctx = { accept: req.headers.accept, userAgent: req.headers["user-agent"] };
      const out = healthReply(await handleHealthRequest(req.method ?? "GET", req.url!, await readBody(req), ctx));
      res.writeHead(out.status, out.headers).end(out.text);
      return;
    }
    const m = req.url?.match(/^\/day\/([0-9a-f]{12})(\/pie\.jpg)?(?:\?.*)?$/);
    const day = m ? await getDayByKey(m[1]!) : undefined;
    if (!day) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Nothing logged yet today.");
      return;
    }
    if (m![2]) {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(await dayJpeg(day));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(day));
  }).listen(PORT, () => console.log(`day dashboard on http://localhost:${PORT}`));
}

/** Request body as text. Sync bodies are tiny; anything oversized is treated as empty (and rejected as bad JSON). */
async function readBody(req: IncomingMessage, limit = 64 * 1024): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return "";
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function page(day: Day) {
  const t = totals(day);
  const rows = day.meals
    .map(
      (m) => `<li><span>${esc(m.name)}<small>${new Date(m.at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: TIME_ZONE })}</small></span>
        <b>${Math.round(m.calories)} cal · ${Math.round(m.protein)}g${m.price ? ` · $${m.price.toFixed(2)}` : ""}</b></li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Today's pie</title><style>
body{margin:0;background:#FFF6E5;color:#2B1B17;font:16px -apple-system,system-ui,sans-serif;padding:16px}
img{width:100%;border-radius:16px;box-shadow:0 6px 18px rgba(0,0,0,.18)}
h1{font:28px Phosphate,Futura,"Arial Black",sans-serif;letter-spacing:2px;color:#C0392B;margin:8px 0 4px}
p{color:#7A4E2D;margin:0 0 16px;font-family:"American Typewriter",ui-monospace,monospace;font-size:14px}
ul{list-style:none;padding:0;margin:16px 0 0}li{display:flex;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:2px dashed #E4CBA8}
small{display:block;color:#7A4E2D;font-size:13px}b{white-space:nowrap;font-weight:700}
</style></head><body>
<h1>TODAY'S PIE</h1><p>${Math.round(t.calories)} of ${day.goals.calories} cal · ${Math.round(t.protein)}g of ${day.goals.protein}g protein · $${t.monthSpent.toFixed(2)} of $${day.goals.budget} spent this month</p>
<img src="/day/${day.key}/pie.jpg" alt="Today's pie: calories, protein and budget left">
<ul>${rows || "<li>No meals logged yet. Text a food photo!</li>"}</ul>
</body></html>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
