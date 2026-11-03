// Khách AI của quán (Cloudflare Pages Function): nhận câu hỏi từ trang web, gọi Gemini bằng khóa giấu trên máy chủ.
// Khóa đặt trong Cloudflare: Workers & Pages → chillchilldemmua → Settings → Variables and Secrets → GEMINI_API_KEY

const hits = new Map(); // giới hạn lượt theo IP (mỗi máy chủ nhớ riêng, đủ để chặn phá)
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
  const prompt = typeof body?.prompt === "string" ? body.prompt.slice(0, 6000) : "";
  if (!prompt) return Response.json({ error: "Thiếu nội dung" }, { status: 400 });

  // Thử lần lượt: model bạn tự đặt (GEMINI_MODEL), rồi các model flash miễn phí
  const models = [env.GEMINI_MODEL, "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-3.1-flash-lite", "gemini-2.5-flash"].filter(Boolean);
  for (const model of models) {
    let r;
    try {
      r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          contents: [{ role: "user", parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1, maxOutputTokens: 400 },
        }),
      });
    } catch { continue; }
    if (r.status === 429) return Response.json({ error: "Hết lượt miễn phí, thử lại sau" }, { status: 429 });
    if (!r.ok) continue; // model không tồn tại hoặc lỗi tạm: thử model kế
    const j = await r.json();
    const text = (j?.candidates?.[0]?.content?.parts || []).map(p => p.text || "").join("").trim();
    if (text) return Response.json({ text, model });
  }
  return Response.json({ error: "Không gọi được Gemini" }, { status: 502 });
}
