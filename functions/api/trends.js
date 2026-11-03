// Chủ đề hot & từ lóng đang trend: Gemini tự tra Google Search, lưu lại 6 tiếng rồi mới tra lại.
// Dùng chung khóa GEMINI_API_KEY với khách AI.

// ---- chọn model Gemini: hỏi Google danh sách model mà khóa này dùng được, ưu tiên bản "flash" mới nhất ----
const BASE = "https://generativelanguage.googleapis.com/v1beta";
let modelMemo = null; // { at, list }
async function availableModels(key, preferred) {
  if (modelMemo && Date.now() - modelMemo.at < 6 * 3600 * 1000) return withPreferred(modelMemo.list, preferred);
  let list = [];
  try {
    const r = await fetch(`${BASE}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
    if (r.ok) {
      const j = await r.json();
      list = (j.models || [])
        .filter(m => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map(m => String(m.name || "").replace(/^models\//, ""))
        .filter(n => /^gemini/.test(n) && /flash/.test(n) && !/(image|tts|live|audio|embed|vision|exp-|thinking|preview-tts)/.test(n));
      const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
      list.sort((a, b) => ver(b) - ver(a) || (a.includes("lite") ? 1 : 0) - (b.includes("lite") ? 1 : 0) || a.length - b.length);
    }
  } catch {}
  if (!list.length) list = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-flash-latest"];
  modelMemo = { at: Date.now(), list: list.slice(0, 5) };
  return withPreferred(modelMemo.list, preferred);
}
function withPreferred(list, preferred) { return preferred ? [preferred, ...list.filter(m => m !== preferred)] : list; }
async function gemini(key, model, body) {
  const first = await gemini1(key, model, { ...body, generationConfig: { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: 0 } } });
  if (first.status === 400 && /thinking/i.test(first.err)) return gemini1(key, model, body);
  return first;
}
async function gemini1(key, model, body) {
  const r = await fetch(`${BASE}/models/${model}:generateContent`, {
    method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body),
  });
  let j = null; try { j = await r.json(); } catch {}
  const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim();
  const err = j?.error?.message ? String(j.error.message).slice(0, 160) : "";
  return { status: r.status, text, err, finish: j?.candidates?.[0]?.finishReason || "" };
}

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

async function ask(key, model, withSearch, today, tried) {
  const body = { contents: [{ role: "user", parts: [{ text: PROMPT(today) }] }], generationConfig: { temperature: 0.7, maxOutputTokens: 2048 } };
  if (withSearch) body.tools = [{ google_search: {} }];
  const res = await gemini(key, model, body);
  const out = parse(res.text);
  tried.push({ model, search: withSearch, status: res.status, err: res.err || undefined, got: out.topics.length });
  return out.topics.length >= 3 ? out : null;
}

export async function onRequestGet({ request, env, waitUntil }) {
  const now = Date.now();
  const debug = new URL(request.url).searchParams.has("debug");
  if (!debug && memo && now - memo.at < TTL) return Response.json(memo, { headers: { "cache-control": "public, max-age=1800" } });
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/trends?v=1", request.url).toString());
  if (cache && !debug) { try { const hit = await cache.match(cacheKey); if (hit) return hit; } catch {} }

  const key = env.GEMINI_API_KEY;
  if (!key) return Response.json({ topics: [], slang: [], error: "no key" });
  const today = new Date(now + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const models = (await availableModels(key, env.GEMINI_MODEL)).slice(0, 3);
  const tried = [];
  let out = null;
  for (const m of models) { try { out = await ask(key, m, true, today, tried); } catch {} if (out) break; }      // có tra Google
  if (!out) for (const m of models) { try { out = await ask(key, m, false, today, tried); } catch {} if (out) break; } // không tra được thì dùng hiểu biết sẵn
  if (!out) return Response.json({ topics: [], slang: [], ...(debug ? { models, tried } : {}) }, { headers: { "cache-control": "no-store" } });
  if (debug) return Response.json({ ...out, models, tried }, { headers: { "cache-control": "no-store" } });

  memo = { ...out, at: now };
  const res = Response.json(memo, { headers: { "cache-control": "public, max-age=21600" } });
  if (cache) { try { waitUntil(cache.put(cacheKey, res.clone())); } catch {} }
  return res;
}
