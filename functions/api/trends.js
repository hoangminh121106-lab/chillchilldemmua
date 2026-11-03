// Chủ đề hot & từ lóng: Gemini tra Google (6 tiếng tra lại một lần); không được thì hỏi Claude / ChatGPT.
// ================= AI: Gemini → Claude → ChatGPT (tự chuyển khi bên trước lỗi / hết lượt / chưa có khóa) =================
// Khóa (đặt ở biến môi trường, không bỏ vào code):
//   GEMINI_API_KEY    (+ GEMINI_MODEL nếu muốn ép model, vd: gemini-3.8-flash)
//   ANTHROPIC_API_KEY (+ ANTHROPIC_MODEL, mặc định claude-haiku-5-5)
//   OPENAI_API_KEY    (+ OPENAI_MODEL,    mặc định thử gpt-5-mini → gpt-4.1-mini → gpt-4o-mini)

const GBASE = "https://generativelanguage.googleapis.com/v1beta";
let gModels = null; // { at, list }
async function geminiModels(key, preferred) {
  if (!gModels || Date.now() - gModels.at > 6 * 3600 * 1000) {
    let list = [];
    try {
      const r = await fetch(`${GBASE}/models?pageSize=200`, { headers: { "x-goog-api-key": key } });
      if (r.ok) {
        const j = await r.json();
        list = (j.models || [])
          .filter(m => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes("generateContent"))
          .map(m => String(m.name || "").replace(/^models\//, ""))
          .filter(n => /^gemini/.test(n) && /flash/.test(n) && !/(image|tts|live|audio|embed|vision|exp-|thinking)/.test(n));
        const ver = n => { const m = n.match(/gemini-(\d+(?:\.\d+)?)/); return m ? parseFloat(m[1]) : 0; };
        list.sort((a, b) => ver(b) - ver(a) || (a.includes("lite") ? 1 : 0) - (b.includes("lite") ? 1 : 0) || a.length - b.length);
      }
    } catch {}
    if (!list.length) list = ["gemini-3.8-flash", "gemini-flash-latest", "gemini-3.6-flash", "gemini-3.5-flash-lite"];
    gModels = { at: Date.now(), list: list.slice(0, 4) };
  }
  return preferred ? [preferred, ...gModels.list.filter(m => m !== preferred)] : gModels.list;
}
async function gemini1(key, model, body) {
  const r = await fetch(`${GBASE}/models/${model}:generateContent`, { method: "POST", headers: { "content-type": "application/json", "x-goog-api-key": key }, body: JSON.stringify(body) });
  let j = null; try { j = await r.json(); } catch {}
  return { status: r.status, model, text: (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("\n").trim(), err: j?.error?.message ? String(j.error.message).slice(0, 200) : "" };
}
async function gemini2(key, model, body) {
  const first = await gemini1(key, model, { ...body, generationConfig: { ...(body.generationConfig || {}), thinkingConfig: { thinkingBudget: 0 } } });
  return first.status === 400 && /thinking/i.test(first.err) ? gemini1(key, model, body) : first;
}
async function tryGemini(env, prompt, o, tried) {
  const key = env.GEMINI_API_KEY; if (!key) { tried.push({ provider: "gemini", err: "chưa có GEMINI_API_KEY" }); return null; }
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens } };
  if (o.search) body.tools = [{ google_search: {} }];
  for (const model of await geminiModels(key, env.GEMINI_MODEL)) {
    let res = await gemini2(key, model, body);
    const hint = res.status === 404 && (res.err.match(/use\s+(?:models\/)?(gemini-[\w.-]+)/i) || [])[1];
    if (hint && hint !== model) { res = await gemini2(key, hint, body); if (res.status === 200) gModels.list = [hint, ...gModels.list.filter(m => m !== hint)]; }
    tried.push({ provider: "gemini", model: res.model, status: res.status, err: res.err || undefined });
    if (res.text) return { text: res.text, provider: "gemini", model: res.model };
    if (res.status === 429 || /API key/i.test(res.err)) break;  // hết lượt hoặc sai khóa: sang bên khác luôn
  }
  return null;
}
async function tryClaude(env, prompt, o, tried) {
  const key = env.ANTHROPIC_API_KEY; if (!key) { tried.push({ provider: "claude", err: "chưa có ANTHROPIC_API_KEY" }); return null; }
  const model = env.ANTHROPIC_MODEL || "claude-haiku-5-5";
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST", headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model, max_tokens: o.maxTokens, temperature: Math.min(1, o.temperature), messages: [{ role: "user", content: prompt }] }),
    });
    let j = null; try { j = await r.json(); } catch {}
    const text = (j?.content || []).filter(c => c.type === "text").map(c => c.text).join("\n").trim();
    tried.push({ provider: "claude", model, status: r.status, err: j?.error?.message ? String(j.error.message).slice(0, 200) : undefined });
    if (text) return { text, provider: "claude", model };
  } catch (e) { tried.push({ provider: "claude", model, status: 0 }); }
  return null;
}
async function tryOpenAI(env, prompt, o, tried) {
  const key = env.OPENAI_API_KEY; if (!key) { tried.push({ provider: "chatgpt", err: "chưa có OPENAI_API_KEY" }); return null; }
  const models = env.OPENAI_MODEL ? [env.OPENAI_MODEL] : ["gpt-5-mini", "gpt-4.1-mini", "gpt-4o-mini"];
  for (const model of models) {
    const call = async (extra) => {
      const r = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], max_completion_tokens: o.maxTokens + 800, ...extra }),
      });
      let j = null; try { j = await r.json(); } catch {}
      return { status: r.status, text: String(j?.choices?.[0]?.message?.content || "").trim(), err: j?.error?.message ? String(j.error.message).slice(0, 200) : "" };
    };
    try {
      let res = await call({ reasoning_effort: "minimal" });
      if (res.status === 400 && /reasoning/i.test(res.err)) res = await call({ temperature: Math.min(1.2, o.temperature) });
      if (res.status === 400 && /temperature/i.test(res.err)) res = await call({});
      tried.push({ provider: "chatgpt", model, status: res.status, err: res.err || undefined });
      if (res.text) return { text: res.text, provider: "chatgpt", model };
      if (res.status === 401 || res.status === 429) break;
    } catch { tried.push({ provider: "chatgpt", model, status: 0 }); }
  }
  return null;
}
// o: { temperature, maxTokens, search }  — search chỉ Gemini làm được (tra Google)
async function askAI(env, prompt, o) {
  const tried = [];
  const out = (await tryGemini(env, prompt, o, tried)) || (await tryClaude(env, prompt, o, tried)) || (await tryOpenAI(env, prompt, o, tried));
  return { ...(out || {}), tried };
}

const TTL = 6 * 3600 * 1000;
let memo = null;
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


async function getTrends(env, debug) {
  const today = new Date(Date.now() + 7 * 3600 * 1000).toISOString().slice(0, 10);
  const tried = [];
  let out = null, via = "";
  const g = await tryGemini(env, PROMPT(today), { temperature: 0.7, maxTokens: 2048, search: true }, tried);   // Gemini có tra Google
  if (g) { const p = parse(g.text); if (p.topics.length >= 3) { out = p; via = g.provider + " + google"; } }
  if (!out) { const r = await askAI(env, PROMPT(today), { temperature: 0.7, maxTokens: 1500 }); tried.push(...r.tried);   // không tra được: hỏi bằng hiểu biết sẵn
    if (r.text) { const p = parse(r.text); if (p.topics.length >= 3) { out = p; via = r.provider; } } }
  return { out, via, tried };
}

export async function onRequestGet({ request, env, waitUntil }) {
  const debug = new URL(request.url).searchParams.has("debug");
  if (!debug && memo && Date.now() - memo.at < TTL) return Response.json(memo, { headers: { "cache-control": "public, max-age=1800" } });
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const cacheKey = new Request(new URL("/api/trends?v=2", request.url).toString());
  if (cache && !debug) { try { const hit = await cache.match(cacheKey); if (hit) return hit; } catch {} }
  const { out, via, tried } = await getTrends(env, debug);
  if (!out) return Response.json({ topics: [], slang: [], ...(debug ? { tried } : {}) }, { headers: { "cache-control": "no-store" } });
  if (debug) return Response.json({ ...out, via, tried }, { headers: { "cache-control": "no-store" } });
  memo = { ...out, via, at: Date.now() };
  const res = Response.json(memo, { headers: { "cache-control": "public, max-age=21600" } });
  if (cache) { try { waitUntil(cache.put(cacheKey, res.clone())); } catch {} }
  return res;
}
