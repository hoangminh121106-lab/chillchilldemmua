// Chủ đề hot & từ lóng đang trend: Gemini tự tra Google Search, lưu lại 6 tiếng rồi mới tra lại.
// Dùng chung khóa GEMINI_API_KEY với khách AI.

const TTL = 6 * 3600 * 1000;
let memo = null; // bộ nhớ tạm trong máy chủ

const PROMPT = (today) => `Hôm nay là ${today}. Hãy tra cứu tin tức và mạng xã hội Việt Nam (TikTok, Facebook, báo mạng) trong 1-3 ngày gần đây.
Liệt kê:
- 10 chủ đề đang được giới trẻ Việt Nam, nhất là ở Sài Gòn, bàn tán nhiều: đời sống, giải trí, showbiz, phim, nhạc, thể thao, bóng đá, công nghệ, game, thời tiết, giá cả, ăn uống, trend mạng xã hội.
  Mỗi chủ đề là một cụm ngắn kiểu nói chuyện quán cóc, tối đa 12 chữ, không cần nguồn.
  TRÁNH: chính trị, quan chức, tôn giáo, tai nạn chết người, án mạng, tin đau thương, tin đồn bôi nhọ cá nhân.
- 8 từ lóng hoặc câu nói đang hot của giới trẻ Việt dạo này (nguyên văn, ngắn).
Trả lời ĐÚNG định dạng, mỗi dòng một mục, không thêm gì khác:
CHUDE: ...
TULONG: ...`;

function parse(text) {
  const topics = [], slang = [];
  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/^[\s*\-•\d.)]+/, "").trim();
    const m = line.match(/^(CHUDE|CHỦ ĐỀ|TULONG|TỪ LÓNG)\s*[:：]\s*(.+)$/i);
    if (!m) continue;
    const val = m[2].replace(/^["“”']+|["“”'.]+$/g, "").trim().slice(0, 90);
    if (!val) continue;
    (/^(CHUDE|CHỦ ĐỀ)$/i.test(m[1]) ? topics : slang).push(val);
  }
  return { topics: topics.slice(0, 12), slang: slang.slice(0, 10) };
}

async function ask(key, model, withSearch, today) {
  const body = { contents: [{ role: "user", parts: [{ text: PROMPT(today) }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 1200 } };
  if (withSearch) body.tools = [{ google_search: {} }];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body),
  });
  if (!r.ok) return null;
  const j = await r.json();
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n");
  const out = parse(text);
  return out.topics.length >= 3 ? out : null;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const now = Date.now();
  if (memo && now - memo.at < TTL) return Response.json(memo, { headers: { "cache-control": "public, max-age=1800" } });
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/trends?v=1", request.url).toString());
  if (cache) { try { const hit = await cache.match(cacheKey); if (hit) return hit; } catch {} }

  const key = env.GEMINI_API_KEY;
  if (!key) return Response.json({ topics: [], slang: [], error: "no key" });
  const today = new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const models = [env.GEMINI_MODEL, "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash"].filter(Boolean);
  let out = null;
  for (const m of models) { try { out = await ask(key, m, true, today); } catch {} if (out) break; }      // có tra Google
  if (!out) for (const m of models) { try { out = await ask(key, m, false, today); } catch {} if (out) break; } // không tra được thì dùng hiểu biết sẵn
  if (!out) return Response.json({ topics: [], slang: [] }, { headers: { "cache-control": "public, max-age=600" } });

  memo = { ...out, at: now };
  const res = Response.json(memo, { headers: { "cache-control": "public, max-age=21600" } });
  if (cache) { try { waitUntil(cache.put(cacheKey, res.clone())); } catch {} }
  return res;
}
