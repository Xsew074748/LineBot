'use strict';
// สถานะ host ของ Zabbix
//
// (1) สถานะ "ดิบ" 3 แบบ ตาม available ของ main interface (ดู computeAvailable ใน services/zabbix.js):
//     1 = ปกติ · 2 = ผิดปกติจริง (Zabbix ตรวจแล้วไม่ตอบ) · 0/อื่นๆ = ไม่ทราบสถานะ (Zabbix ยังไม่ยืนยัน)
//     "ไม่ทราบ" ≠ "ดับ": host ที่ตรวจด้วย ICMP อย่างเดียว ไม่มี agent เลยค้างที่ 0 ถาวร
//
// (2) สถานะ "ที่แท้จริง" (effective) — เฟส 2:
//     - available 1/2 (เคยคุยกับ agent) → ใช้ค่านั้น (แหล่ง = agent) และ agent ชนะ icmpping เสมอเมื่อขัดกัน
//     - available 0 → ใช้ item key_ = "icmpping" (ตรงตัว) ที่สด (lastclock <= 10 นาที): 1 = up, 0 = down (แหล่ง = icmp)
//     - ไม่มี item / ปิด / not supported / เก่า / ค่าแปลก → unknown (ไม่ใช่ down) แหล่ง = none
//     ไม่เปลี่ยนความหมายของ available และของ hosts.up/total/down ใน /stats
//
// จุดนี้เป็นนิยามกลางของ /stats, การ์ด LINE และข้อความบริบท AI — อย่านับ available !== 1 เป็นออฟไลน์เองที่อื่น

const EFFECTIVE_FRESH_SEC = 600;     // item ที่เก่ากว่านี้ไม่ใช่สัญญาณที่เชื่อถือได้
const FUTURE_TOLERANCE_SEC = 60;     // นาฬิกาเหลื่อมไม่เกินนี้รับได้; ล้ำอนาคตกว่านี้ = ข้อมูลผิดปกติ → ไม่ใช้

function classifyHost(h) {
  const a = h ? h.available : undefined;
  if (a === 1) return 'up';
  if (a === 2) return 'unavailable';
  return 'unknown';
}

function countHostStatus(hosts) {
  const c = { total: 0, up: 0, unavailable: 0, unknown: 0 };
  if (!Array.isArray(hosts)) return c;
  for (const h of hosts) {
    c.total += 1;
    c[classifyHost(h)] += 1;
  }
  return c;
}

// ── effective ────────────────────────────────────────────────────────────────

// คืน 1 / 0 จาก item icmpping ที่ใช้ได้และสดที่สุด หรือ null ถ้าไม่มีสัญญาณที่เชื่อถือได้
// หลาย item: ใช้ตัวที่ lastclock ใหม่สุด; เวลาเท่ากันแต่ขัดกัน → 0 (ไม่ตอบ) ชนะ
function pickPing(items, nowSec) {
  if (!Array.isArray(items)) return null;
  let best = null;
  for (const it of items) {
    if (!it) continue;
    if (it.status !== undefined && String(it.status) !== '0') continue;   // item ถูกปิด
    if (it.state !== undefined && String(it.state) !== '0') continue;     // not supported
    const clock = Number(it.lastclock);
    if (!Number.isFinite(clock) || clock <= 0) continue;
    const age = nowSec - clock;
    if (age < -FUTURE_TOLERANCE_SEC || age > EFFECTIVE_FRESH_SEC) continue;
    const v = String(it.lastvalue ?? '').trim();
    if (v !== '1' && v !== '0') continue;
    const value = v === '1' ? 1 : 0;
    if (!best || clock > best.clock) best = { clock, value };
    else if (clock === best.clock && value === 0) best.value = 0;
  }
  return best ? best.value : null;
}

// host: { available }, items: รายการ icmpping ของ host นั้น, nowSec: เวลาปัจจุบัน (วินาที)
// คืน { effective: 'up'|'down'|'unknown', source: 'agent'|'icmp'|'none', conflict: boolean }
function classifyEffective(host, items, nowSec) {
  const a = host ? host.available : undefined;
  const ping = pickPing(items, nowSec);
  if (a === 1 || a === 2) {
    const conflict = ping !== null && ((a === 1 && ping === 0) || (a === 2 && ping === 1));
    return { effective: a === 1 ? 'up' : 'down', source: 'agent', conflict };
  }
  if (ping === 1) return { effective: 'up', source: 'icmp', conflict: false };
  if (ping === 0) return { effective: 'down', source: 'icmp', conflict: false };
  return { effective: 'unknown', source: 'none', conflict: false };
}

function countEffective(hosts) {
  const c = { effectiveUp: 0, effectiveDown: 0, effectiveUnknown: 0, effectiveSources: { agent: 0, icmp: 0, none: 0 } };
  if (!Array.isArray(hosts)) return c;
  for (const h of hosts) {
    const e = h && h.effective;
    if (e === 'up') c.effectiveUp += 1;
    else if (e === 'down') c.effectiveDown += 1;
    else c.effectiveUnknown += 1;
    const s = h && h.effectiveSource;
    c.effectiveSources[s === 'agent' || s === 'icmp' ? s : 'none'] += 1;
  }
  return c;
}

// สถานะที่ "แสดงให้ผู้ใช้เห็น": ใช้ effective เมื่อมี ไม่งั้นถอยกลับไปใช้ available เดิม (unavailable → down)
function viewStatus(h) {
  const e = h && h.effective;
  if (e === 'up' || e === 'down' || e === 'unknown') return e;
  const raw = classifyHost(h);
  return raw === 'unavailable' ? 'down' : raw;
}

function countView(hosts) {
  const c = { total: 0, up: 0, down: 0, unknown: 0 };
  if (!Array.isArray(hosts)) return c;
  for (const h of hosts) {
    c.total += 1;
    c[viewStatus(h)] += 1;
  }
  return c;
}

// กล้อง "ออนไลน์" ไหม — ใช้จุดเดียวทุกที่: effective (กล้อง Zabbix ที่รวมผล ping) → available (Zabbix) → online (HikCentral)
// effective = unknown ถือว่าไม่ออนไลน์ (ไม่มีสัญญาณที่เชื่อถือได้) แต่ไม่ถูกนับเป็น "ดับ" ในคำสั่ง กล้องดับ
function isCameraUp(c) {
  if (!c) return false;
  if (c.effective === 'up') return true;
  if (c.effective === 'down' || c.effective === 'unknown') return false;
  return c.available !== undefined ? c.available === 1 : c.online === true;
}

const MAX_OFFLINE_NAMES = 10;

// ข้อความบริบทที่ส่งให้ AI วิเคราะห์ (คำสั่ง "host"): ออฟไลน์ = เฉพาะที่ยืนยันว่าดับ (available=2 หรือ ping ไม่ตอบ)
// ส่วนไม่ทราบสถานะบอกแยกและห้ามตีความว่าดับ
function buildHostContextText(hosts) {
  const list = Array.isArray(hosts) ? hosts : [];
  const c = countView(list);
  let text = `Host ทั้งหมด ${c.total} เครื่อง ออนไลน์ ${c.up} ออฟไลน์ ${c.down}`;
  if (c.down > 0) {
    const names = list.filter((h) => viewStatus(h) === 'down').slice(0, MAX_OFFLINE_NAMES).map((h) => h.name);
    text += `: ${names.join(', ')}`;
  }
  if (c.unknown > 0) {
    text += ` · ไม่ทราบสถานะ ${c.unknown} เครื่อง (Zabbix ยังไม่ยืนยันสถานะ ไม่ได้แปลว่าดับ)`;
  }
  const viaPing = list.filter((h) => h && h.effectiveSource === 'icmp').length;
  if (viaPing > 0) {
    text += ` · สถานะ ${viaPing} เครื่องตัดสินจากการ ping (ICMP)`;
  }
  return text;
}

module.exports = {
  EFFECTIVE_FRESH_SEC, classifyHost, countHostStatus,
  classifyEffective, countEffective, viewStatus, countView, isCameraUp, buildHostContextText,
};
