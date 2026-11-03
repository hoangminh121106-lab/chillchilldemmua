// Nhận tín hiệu "đang ở quán" từ trang, ghi vào cơ sở dữ liệu D1 (Binding tên DB). Không lưu IP.
const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, vid TEXT, start INTEGER, last INTEGER, active INTEGER, ref TEXT, dev TEXT, country TEXT, open INTEGER DEFAULT 0)",
  "CREATE INDEX IF NOT EXISTS s_start ON sessions(start)",
  "CREATE INDEX IF NOT EXISTS s_last ON sessions(last)",
];
let ready = false;
export async function initDb(db) {
  if (ready) return; for (const q of SCHEMA) await db.prepare(q).run();
  try { await db.prepare("ALTER TABLE sessions ADD COLUMN open INTEGER DEFAULT 0").run(); } catch {}   // bảng cũ chưa có cột "open"
  ready = true;
}

export async function onRequestPost({ request, env }) {
  if (!env.DB) return new Response(null, { status: 204 });
  let b; try { b = await request.json(); } catch { return new Response(null, { status: 400 }); }
  const id = String(b?.s || ""), vid = String(b?.v || "").slice(0, 40);
  if (!/^[a-z0-9]{8,40}$/.test(id) || !/^[a-z0-9]{4,40}$/.test(vid)) return new Response(null, { status: 400 });
  const a = Math.max(0, Math.min(86400, Math.floor(Number(b.a) || 0)));
  const o = Math.max(a, Math.min(86400, Math.floor(Number(b.o) || 0)));   // thời gian mở trang, tính cả chạy nền
  const now = Date.now(), db = env.DB;
  try {
    await initDb(db);
    if (b.t === "start") {
      let ref = "trực tiếp";
      try { const h = new URL(String(b.r || "")).hostname.replace(/^www\./, ""); const self = new URL(request.url).hostname; if (h && h !== self) ref = h.slice(0, 60); } catch {}
      const w = Number(b.w) || 0, dev = w && w < 700 ? "điện thoại" : w && w < 1100 ? "máy tính bảng" : "máy tính";
      const country = String(request.cf?.country || "").slice(0, 2);
      await db.prepare("INSERT OR IGNORE INTO sessions (id, vid, start, last, active, ref, dev, country) VALUES (?,?,?,?,0,?,?,?)").bind(id, vid, now, now, ref, dev, country).run();
      if (Math.random() < .01) await db.prepare("DELETE FROM sessions WHERE start < ?").bind(now - 180 * 86400000).run();   // giữ 6 tháng
    } else {
      await db.prepare("UPDATE sessions SET last = ?, active = MAX(active, ?), open = MIN(MAX(open, ?), (? - start) / 1000 + 5) WHERE id = ? AND ? - start < 86400000").bind(now, a, o, now, id, now).run();
    }
  } catch (e) { return new Response(null, { status: 500 }); }
  return new Response(null, { status: 204 });
}
