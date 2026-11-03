// Khách AI của quán (Cloudflare Pages Function). Biến môi trường đặt ở Cloudflare → Settings → Variables and Secrets.
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

const hits = new Map(); // giới hạn lượt theo IP
const PER_MINUTE = 12;
function limited(ip) {
  const now = Date.now(), recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= PER_MINUTE) return true;
  recent.push(now); hits.set(ip, recent); if (hits.size > 5000) hits.clear(); return false;
}
async function handlePost(request, env, ip) {
  if (limited(ip)) return Response.json({ error: "Chậm lại xíu" }, { status: 429 });
  let body; try { body = await request.json(); } catch { return Response.json({ error: "Sai định dạng" }, { status: 400 }); }
  const prompt = typeof body?.prompt === "string" ? body.prompt.slice(0, 8000) : "";
  if (!prompt) return Response.json({ error: "Thiếu nội dung" }, { status: 400 });
  const r = await askAI(env, prompt, { temperature: 1.15, maxTokens: 400 });
  if (r.text) return Response.json({ text: r.text, provider: r.provider, model: r.model });
  const quota = r.tried.some(t => t.status === 429);
  return Response.json({ error: "Không gọi được AI nào", tried: r.tried }, { status: quota ? 429 : 502 });
}
// Mở /api/chat trên trình duyệt để kiểm tra: thấy "ok": true là khách AI đang chạy
async function handleGet(env) {
  const r = await askAI(env, "Trả lời đúng một chữ: ok", { temperature: 0.2, maxTokens: 50 });
  return Response.json({ ok: !!r.text, provider: r.provider, model: r.model, reply: r.text, tried: r.tried }, { headers: { "cache-control": "no-store" } });
}

export async function onRequestPost({ request, env }) { return handlePost(request, env, request.headers.get("CF-Connecting-IP") || "anon"); }
export async function onRequestGet({ env }) { return handleGet(env); }
