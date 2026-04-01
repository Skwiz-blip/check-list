// Vercel Serverless Function: persists checklist progress in Vercel KV (Redis).
// - GET    /api/items?list=<name>                 -> { list, items: { [id]: boolean } }
// - PUT    /api/items?list=<name>  { id, done }   -> 204
// - POST   /api/items?list=<name>  { items: {...} } -> 204 (bulk set)
// - DELETE /api/items?list=<name>                 -> 204 (clear)

const { kv } = require("@vercel/kv");

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  await new Promise((resolve, reject) => {
    req.on("data", (c) => chunks.push(c));
    req.on("end", resolve);
    req.on("error", reject);
  });

  if (!chunks.length) return {};
  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function getList(req) {
  if (req.query && typeof req.query.list === "string" && req.query.list) return req.query.list;
  try {
    const u = new URL(req.url, "http://localhost");
    const list = u.searchParams.get("list");
    return list || "default";
  } catch {
    return "default";
  }
}

function normalizeToBoolMap(hash) {
  const out = {};
  if (!hash || typeof hash !== "object") return out;
  for (const [k, v] of Object.entries(hash)) out[k] = v === true || v === 1 || v === "1" || v === "true";
  return out;
}

module.exports = async (req, res) => {
  // Allow local testing / cross-origin embeds if needed.
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,PUT,POST,DELETE,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") return res.status(204).end();

  const list = getList(req);
  const key = `checklist:${list}`;

  try {
    if (req.method === "GET") {
      const hash = await kv.hgetall(key);
      return res.status(200).json({ list, items: normalizeToBoolMap(hash) });
    }

    if (req.method === "DELETE") {
      await kv.del(key);
      return res.status(204).end();
    }

    if (req.method === "PUT") {
      const body = await readJson(req);
      if (!body || typeof body.id !== "string" || !body.id) {
        return res.status(400).json({ error: "Missing id" });
      }
      const done = !!body.done;
      await kv.hset(key, { [body.id]: done ? 1 : 0 });
      return res.status(204).end();
    }

    if (req.method === "POST") {
      const body = await readJson(req);
      if (!body || !body.items || typeof body.items !== "object") {
        return res.status(400).json({ error: "Missing items" });
      }

      const toSet = {};
      for (const [id, done] of Object.entries(body.items)) {
        if (!id) continue;
        toSet[id] = done ? 1 : 0;
      }
      if (Object.keys(toSet).length) await kv.hset(key, toSet);
      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: "KV error", detail: String(err && err.message ? err.message : err) });
  }
};

