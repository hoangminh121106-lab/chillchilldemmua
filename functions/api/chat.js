// Khách AI của quán (Cloudflare Pages Function): nhận câu hỏi từ trang web, gọi Gemini bằng khóa giấu trên máy chủ.
// Khóa đặt trong Cloudflare: Workers & Pages → chillchilldemmua → Settings → Variables and Secrets → GEMINI_API_KEY
// Kiểm tra nhanh: mở https://chillchilldemmua.pages.dev/api/chat trên trình duyệt.
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

const hits = new Map(); // giới hạn lượt theo IP
const PER_MINUTE = 12;

export async function onRequestPost({ request, env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return Response.json({ error: "Chưa đặt GEMINI_API_KEY trên Cloudflare" }, { status: 500 });
  const ip = request.headers.get("CF-Connecting-IP") || "anon";
  const now = Date.now();
  const recent = (hits.get(ip) || []).filter(t => now - t < 60000);
  if (recent.length >= PER_MINUTE) return Response.json({ error: "Chậm lại xíu" }, { status: 429 });
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  let body;
  try { body = await request.json(); } catch { return Response.json({ error: "Sai định dạng" }, { status: 400 }); }
  const prompt = typeof body?.prompt === "string" ? body.prompt.slice(0, 8000) : "";
  if (!prompt) return Response.json({ error: "Thiếu nội dung" }, { status: 400 });
  const tried = [];
  for (const model of await availableModels(key, env.GEMINI_MODEL)) {
    let res;
    try { res = await gemini(key, model, { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { temperature: 1.15, topP: 0.95, maxOutputTokens: 1024 } }); }
    catch { tried.push({ model, status: 0 }); continue; }
    if (res.text) return Response.json({ text: res.text, model });
    tried.push({ model, status: res.status, err: res.err, finish: res.finish });
    if (res.status === 429) return Response.json({ error: "Hết lượt miễn phí, thử lại sau", tried }, { status: 429 });
    if (/API key/i.test(res.err)) break;
  }
  return Response.json({ error: "Không gọi được Gemini", tried }, { status: 502 });
}

// Mở /api/chat trên trình duyệt để kiểm tra khóa và model
export async function onRequestGet({ env }) {
  const key = env.GEMINI_API_KEY;
  if (!key) return Response.json({ ok: false, error: "Chưa có GEMINI_API_KEY (hoặc chưa Retry deployment sau khi thêm)" });
  const models = await availableModels(key, env.GEMINI_MODEL);
  const res = await gemini(key, models[0], { contents: [{ role: "user", parts: [{ text: "Trả lời đúng một chữ: ok" }] }], generationConfig: { maxOutputTokens: 256 } });
  return Response.json({ ok: !!res.text, model: models[0], models, status: res.status, error: res.err || undefined, reply: res.text || undefined });
}
