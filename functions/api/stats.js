// Số liệu cho trang /thongke — chỉ ai có mật khẩu ADMIN_KEY (biến môi trường, Type = Secret) mới xem được.
import { initDb } from "./stat.js";
const VN = 7 * 3600000, DAY = 86400000;
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
const J = (o, s = 200) => Response.json(o, { status: s, headers: { "cache-control": "no-store" } });

export async function onRequestGet({ request, env }) {
  if (!env.ADMIN_KEY) return J({ error: "Chưa đặt mật khẩu ADMIN_KEY trên Cloudflare" }, 503);
  const key = request.headers.get("x-admin-key") || "";
  if (!same(key, String(env.ADMIN_KEY))) { await new Promise(r => setTimeout(r, 600)); return J({ error: "Sai mật khẩu" }, 401); }
  if (!env.DB) return J({ error: "Chưa nối cơ sở dữ liệu (Binding D1 tên DB)" }, 503);
  const db = env.DB; await initDb(db);
  const days = Math.max(1, Math.min(90, parseInt(new URL(request.url).searchParams.get("days") || "7", 10) || 7));
  const now = Date.now(), today = Math.floor((now + VN) / DAY), from = (today - days + 1) * DAY - VN;
  const one = async (q, ...p) => (await db.prepare(q).bind(...p).first()) || {};
  const all = async (q, ...p) => (await db.prepare(q).bind(...p).all()).results || [];
  const tot = await one("SELECT COUNT(*) visits, COUNT(DISTINCT vid) users, AVG(open) avg, SUM(open) total, AVG(active) avgActive FROM sessions WHERE start >= ?", from);
  const med = tot.visits ? await one("SELECT open FROM sessions WHERE start >= ? ORDER BY open LIMIT 1 OFFSET ?", from, Math.floor((tot.visits - 1) / 2)) : {};
  const online = await one("SELECT COUNT(*) n FROM sessions WHERE last > ?", now - 150000);   // chạy nền ping thưa hơn
  const daily = await all("SELECT CAST((start + ?) / ? AS INTEGER) d, COUNT(*) visits, COUNT(DISTINCT vid) users, AVG(open) avg FROM sessions WHERE start >= ? GROUP BY d ORDER BY d", VN, DAY, from);
  const hours = await all("SELECT CAST(((start + ?) % ?) / 3600000 AS INTEGER) h, COUNT(*) visits FROM sessions WHERE start >= ? GROUP BY h", VN, DAY, from);
  const buckets = await one(`SELECT SUM(open < 10) b0, SUM(open >= 10 AND open < 60) b1, SUM(open >= 60 AND open < 300) b2,
    SUM(open >= 300 AND open < 900) b3, SUM(open >= 900 AND open < 1800) b4, SUM(open >= 1800) b5 FROM sessions WHERE start >= ?`, from);
  const back = await one("SELECT COUNT(*) n FROM (SELECT vid FROM sessions WHERE start >= ? GROUP BY vid HAVING COUNT(*) > 1)", from);
  const refs = await all("SELECT ref k, COUNT(*) n FROM sessions WHERE start >= ? GROUP BY ref ORDER BY n DESC LIMIT 8", from);
  const countries = await all("SELECT country k, COUNT(*) n FROM sessions WHERE start >= ? GROUP BY country ORDER BY n DESC LIMIT 8", from);
  const devs = await all("SELECT dev k, COUNT(*) n FROM sessions WHERE start >= ? GROUP BY dev ORDER BY n DESC", from);
  const recent = await all("SELECT start, last, active, open, dev, country, ref FROM sessions ORDER BY start DESC LIMIT 25");
  return J({ days, today, now, online: online.n || 0, visits: tot.visits || 0, users: tot.users || 0, returning: back.n || 0,
    avg: Math.round(tot.avg || 0), avgActive: Math.round(tot.avgActive || 0), median: med.open || 0, total: tot.total || 0, daily, hours, buckets, refs, countries, devs, recent });
}
