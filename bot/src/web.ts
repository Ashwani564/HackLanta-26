// Tiny web server for the page that opens when someone taps the day card.
import { createServer } from "node:http";
import { ringsJpeg } from "./card.js";
import { getDayByKey, totals } from "./day.js";

const PORT = Number(process.env.PORT ?? 8787);

export function startWeb() {
  createServer(async (req, res) => {
    const m = req.url?.match(/^\/day\/([0-9a-f]{12})(\/rings\.jpg)?(?:\?.*)?$/);
    const day = m ? getDayByKey(m[1]!) : undefined;
    if (!day) {
      res.writeHead(404, { "content-type": "text/plain" }).end("Nothing logged yet today.");
      return;
    }
    if (m![2]) {
      res.writeHead(200, { "content-type": "image/jpeg", "cache-control": "no-store" }).end(await ringsJpeg(day));
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(page(day));
  }).listen(PORT, () => console.log(`day dashboard on http://localhost:${PORT}`));
}

function page(day: NonNullable<ReturnType<typeof getDayByKey>>) {
  const t = totals(day);
  const rows = day.meals
    .map(
      (m) => `<li><span>${esc(m.name)}<small>${m.at.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })}</small></span>
        <b>${Math.round(m.calories)} cal · ${Math.round(m.protein)}g${m.price ? ` · $${m.price.toFixed(2)}` : ""}</b></li>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Your day</title><style>
body{margin:0;background:#000;color:#fff;font:16px -apple-system,system-ui,sans-serif;padding:16px}
img{width:100%;border-radius:16px}h1{font-size:28px;margin:8px 0 4px}p{color:#aaa;margin:0 0 16px}
ul{list-style:none;padding:0;margin:0}li{display:flex;justify-content:space-between;gap:12px;padding:14px 0;border-bottom:1px solid #222}
small{display:block;color:#888;font-size:13px}b{white-space:nowrap;font-weight:600}
</style></head><body>
<h1>Your day</h1><p>${Math.round(t.calories)} of ${day.goals.calories} cal · ${Math.round(t.protein)}g of ${day.goals.protein}g protein · $${t.spent.toFixed(2)} of $${day.goals.budget}</p>
<img src="/day/${day.key}/rings.jpg" alt="Calorie, protein and budget rings">
<ul>${rows || "<li>No meals logged yet. Text a food photo!</li>"}</ul>
</body></html>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
