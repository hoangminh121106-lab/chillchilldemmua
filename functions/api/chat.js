// Khách AI của quán (Cloudflare Pages Function). Biến môi trường đặt ở Cloudflare → Settings → Variables and Secrets.
// ================= AI miễn phí: Gemini → Groq → Cloudflare Workers AI =================
// Bên trước lỗi / hết lượt / chưa có khóa thì tự chuyển sang bên sau. Bên nào vừa báo hết lượt thì nghỉ 1 phút cho đỡ chờ.
// Khóa (đặt ở biến môi trường, không bỏ vào code):
//   GEMINI_API_KEY (+ GEMINI_MODEL nếu muốn ép model)      — aistudio.google.com
//   GROQ_API_KEY   (+ GROQ_MODEL nếu muốn ép model)        — console.groq.com
//   Cloudflare AI: không cần khóa, chỉ cần thêm Binding tên AI (Settings → Bindings → Workers AI)

const cool = new Map(); // tên → hết hạn nghỉ
const resting = (k) => (cool.get(k) || 0) > Date.now();
const rest = (k, ms = 60000) => cool.set(k, Date.now() + ms);

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
  return first.status === 400 ? gemini1(key, model, body) : first;   // model không nhận tùy chọn tắt "suy nghĩ": gửi lại bản thường
}
async function tryGemini(env, prompt, o, tried) {
  const key = env.GEMINI_API_KEY; if (!key) { tried.push({ provider: "gemini", err: "chưa có GEMINI_API_KEY" }); return null; }
  const body = { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: o.temperature, maxOutputTokens: o.maxTokens } };
  if (o.search) body.tools = [{ google_search: {} }];
  for (const model of await geminiModels(key, env.GEMINI_MODEL)) {
    if (resting("g:" + model)) { tried.push({ provider: "gemini", model, err: "đang nghỉ (vừa hết lượt)" }); continue; }
    let res = await gemini2(key, model, body);
    const hint = res.status === 404 && (res.err.match(/use\s+(?:models\/)?(gemini-[\w.-]+)/i) || [])[1];
    if (hint && hint !== model) { res = await gemini2(key, hint, body); if (res.status === 200) gModels.list = [hint, ...gModels.list.filter(m => m !== hint)]; }
    tried.push({ provider: "gemini", model: res.model, status: res.status, err: res.err || undefined });
    if (res.text) return { text: res.text, provider: "gemini", model: res.model };
    if (res.status === 429) rest("g:" + res.model);
    if (/API key/i.test(res.err)) break;
  }
  return null;
}

// Model mã nguồn mở viết tiếng Việt dễ sai chính tả / bịa từ: nhắc kỹ + giảm độ "bay"
const VI_SYS = "Bạn viết tiếng Việt chuẩn chính tả, có dấu đầy đủ, câu tự nhiên đúng kiểu người Sài Gòn nói ngoài đời. Không viết sai chính tả cho vui (cấm 'rùi', 'hok', 'ghê' thay 'đi'), không bịa từ, không ghép chữ vô nghĩa. Mỗi câu phải có nghĩa rõ ràng, đáp đúng ý câu trước. Làm đúng yêu cầu định dạng trong tin nhắn.";
const viMsgs = (prompt) => [{ role: "system", content: VI_SYS }, { role: "user", content: prompt }];
const clean = (t) => String(t || "").replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/^[\s\S]*?<\/think>/i, "").trim();
async function tryGroq(env, prompt, o, tried) {
  const key = env.GROQ_API_KEY; if (!key) { tried.push({ provider: "groq", err: "chưa có GROQ_API_KEY" }); return null; }
  const models = env.GROQ_MODEL ? [env.GROQ_MODEL] : ["qwen/qwen3.8-27b", "llama-3.3-70b-versatile", "openai/gpt-oss-120b"];   // Qwen, Llama nói tiếng Việt tự nhiên hơn gpt-oss
  for (const model of models) {
    if (resting("q:" + model)) { tried.push({ provider: "groq", model, err: "đang nghỉ (vừa hết lượt)" }); continue; }
    try {
      const extra = /gpt-oss/.test(model) ? { reasoning_effort: "low", max_completion_tokens: o.maxTokens + 600 }
        : /qwen/.test(model) ? { reasoning_effort: "none", max_completion_tokens: o.maxTokens + 300 } : { max_completion_tokens: o.maxTokens };
      const send = (ex) => fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ model, messages: viMsgs(prompt), temperature: Math.min(.75, o.temperature), top_p: .9, ...ex }),
      });
      let r = await send(extra);
      if (r.status === 400 && extra.reasoning_effort) { const { reasoning_effort, ...rest } = extra; r = await send(rest); }   // model không nhận tùy chọn suy nghĩ
      let j = null; try { j = await r.json(); } catch {}
      const text = clean(j?.choices?.[0]?.message?.content);
      tried.push({ provider: "groq", model, status: r.status, err: j?.error?.message ? String(j.error.message).slice(0, 200) : undefined });
      if (text) return { text, provider: "groq", model };
      if (r.status === 429) rest("q:" + model);
      if (r.status === 401) break;   // 404 (model không có) thì thử model kế
    } catch { tried.push({ provider: "groq", model, status: 0 }); }
  }
  return null;
}

async function tryCfAI(env, prompt, o, tried) {
  if (!env.AI || typeof env.AI.run !== "function") { tried.push({ provider: "cloudflare", err: "chưa thêm Binding AI" }); return null; }
  const models = env.CF_AI_MODEL ? [env.CF_AI_MODEL] : ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fp8-fast"];
  for (const model of models) {
    if (resting("c:" + model)) { tried.push({ provider: "cloudflare", model, err: "đang nghỉ (vừa hết lượt)" }); continue; }
    try {
      const r = await env.AI.run(model, { messages: viMsgs(prompt), max_tokens: o.maxTokens, temperature: Math.min(.7, o.temperature) });
      const text = clean(typeof r === "string" ? r : (r?.response ?? r?.choices?.[0]?.message?.content ?? ""));
      tried.push({ provider: "cloudflare", model, status: text ? 200 : 0 });
      if (text) return { text, provider: "cloudflare", model };
    } catch (e) {
      const msg = String(e?.message || e).slice(0, 200);
      tried.push({ provider: "cloudflare", model, status: 0, err: msg });
      if (/limit|quota|neuron|429/i.test(msg)) rest("c:" + model, 10 * 60000);
    }
  }
  return null;
}

// o: { temperature, maxTokens, search }  — search chỉ Gemini làm được (tra Google)
async function askAI(env, prompt, o) {
  const tried = [];
  const out = (await tryGemini(env, prompt, o, tried)) || (await tryGroq(env, prompt, o, tried)) || (await tryCfAI(env, prompt, o, tried));
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
