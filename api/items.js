// Vercel Serverless Function: persists checklist progress in Vercel KV (Redis).
// - GET    /api/items?list=<name>                 -> { list, items: { [id]: boolean } }
// - PUT    /api/items?list=<name>  { id, done }   -> 204
// - POST   /api/items?list=<name>  { items: {...} } -> 204 (bulk set)
// - DELETE /api/items?list=<name>                 -> 204 (clear)

const { Redis } = require("@upstash/redis");

function getRedis(){
  // When Upstash is connected via Vercel Storage, these env vars are auto-injected:
  // - UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (some setups)
  // - KV_REST_API_URL / KV_REST_API_TOKEN (Vercel/Upstash integration)
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  return new Redis({ url, token });
}

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
  // Prevent edge/browser caching (otherwise other users may not see updates quickly).
  res.setHeader("Cache-Control", "no-store, max-age=0");

  if (req.method === "OPTIONS") return res.status(204).end();

  const list = getList(req);
  const key = `checklist:${list}`;
  const redis = getRedis();
  if (!redis) {
    return res.status(500).json({
      error: "Redis not configured",
      detail: "Missing Redis REST env vars. Expected KV_REST_API_URL + KV_REST_API_TOKEN (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Connect your Upstash for Redis to this Vercel project (Preview + Production), then redeploy.",
      env_present: {
        KV_REST_API_URL: !!process.env.KV_REST_API_URL,
        KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
        UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
        UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN
      }
    });
  }

  try {
    if (req.method === "GET") {
      const hash = await redis.hgetall(key);
      return res.status(200).json({ list, items: normalizeToBoolMap(hash) });
    }

    if (req.method === "DELETE") {
      await redis.del(key);
      return res.status(204).end();
    }

    if (req.method === "PUT") {
      const body = await readJson(req);
      if (!body || typeof body.id !== "string" || !body.id) {
        return res.status(400).json({ error: "Missing id" });
      }
      const done = !!body.done;
      await redis.hset(key, { [body.id]: done ? 1 : 0 });
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
      if (Object.keys(toSet).length) await redis.hset(key, toSet);
      return res.status(204).end();
    }

    return res.status(405).json({ error: "Method not allowed" });
  } catch (err) {
    return res.status(500).json({ error: "Redis error", detail: String(err && err.message ? err.message : err) });
  }
};
