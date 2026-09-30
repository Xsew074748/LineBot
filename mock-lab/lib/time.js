'use strict';
// แปลงค่าเวลาในไฟล์สถานการณ์เป็น epoch วินาที
//   "-15m" "-2h30m" "-4d3h" → ย้อนหลังจาก now   ·   "2026-10-15T09:12:03+07:00" → ISO   ·   1760000000 → epoch วินาที
function parseTime(value, nowSec = Math.floor(Date.now() / 1000)) {
  if (typeof value === 'number') return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
  if (value instanceof Date) return Math.floor(value.getTime() / 1000);
  const s = String(value).trim();
  const rel = s.match(/^-((?:\d+[dhms])+)$/i);
  if (rel) {
    const unit = { d: 86400, h: 3600, m: 60, s: 1 };
    let total = 0;
    for (const [, n, u] of rel[1].matchAll(/(\d+)([dhms])/gi)) total += Number(n) * unit[u.toLowerCase()];
    return nowSec - total;
  }
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`รูปแบบเวลาไม่ถูกต้อง: "${s}" (ใช้ -15m / -4d3h / ISO / epoch)`);
  return Math.floor(t / 1000);
}

module.exports = { parseTime };
