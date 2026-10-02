'use strict';
// ตัวระบุกล้องและ dedup กล้องจากหลายระบบ (Zabbix + HikCentral)
//
// ข้อเท็จจริงจากข้อมูลจริง (ตรวจแล้ว): index code ของ HikCentral มีครบและไม่ซ้ำ แต่ Zabbix ไม่มีรหัสนี้เก็บไว้ที่ใดเลย
// → จับคู่ "ข้ามระบบ" ด้วยรหัสล้วนไม่ได้ จึงใช้:
//   1) ภายในระบบเดียวกัน: ใช้ id ของระบบนั้น (HikCentral = index code, Zabbix = hostid) เป็นตัวหลัก — ชื่อซ้ำแต่รหัสต่างไม่รวมกัน
//   2) ข้ามระบบ: ถ้ากล้อง Zabbix มี hikIndexCode (ผูกไว้) ใช้รหัสก่อน; ที่เหลือใช้ "ชื่อ" แบบ normalize เป็น fallback (พฤติกรรมเดิมของ daily summary)
//      จับคู่แบบ 1 ต่อ 1: กล้อง Zabbix หนึ่งตัวตัดกล้อง HikCentral ที่ชื่อตรงกันได้แค่หนึ่งตัว (ถ้ามีสองตัวชื่อเดียวกันรหัสต่างกัน อีกตัวคือกล้องคนละตัว)
// key ต้องมี prefix ระบบเสมอ: hostid ของ Zabbix (เลขล้วน) กับ index code ของ HikCentral (เลข 3–4 หลัก) เป็นสตริงตัวเลขเหมือนกัน เทียบกันตรงๆ ไม่ได้
// ชื่อที่ผู้ใช้เห็นยังเป็นชื่อเดิมของแต่ละกล้อง (ไม่แก้ object) — เมื่อรวมสองระบบเก็บฝั่ง Zabbix ไว้ก่อน (เหมือนเดิม)

const UNNAMED = new Set(['', 'n/a', 'na', 'unknown']);

// ชื่อสำหรับเทียบ: ตัดช่องว่างหัวท้าย + ตัวพิมพ์เล็ก (เหมือน key เดิมใน daily-summary); ชื่อว่าง/N/A ไม่ใช้เทียบ (null)
function normalizeName(name) {
  const n = String(name === null || name === undefined ? '' : name).trim().toLowerCase();
  return UNNAMED.has(n) ? null : n;
}

const clean = (v) => (v === null || v === undefined ? '' : String(v).trim());

// key ตามระบบ: 'hik:<index code>' | 'zbx:<hostid>' | null (ไม่มี id)
function idKey(cam, system) {
  const id = clean(cam && cam.id);
  if (!id) return null;
  if (system === 'hikcentral') return `hik:${id}`;
  if (system === 'zabbix') return `zbx:${id}`;
  return null;
}

// dedup ภายในระบบเดียว (คงลำดับ, เก็บตัวแรก): มี id → ซ้ำเมื่อ id เดียวกัน (ชื่อซ้ำแต่ id ต่าง = คนละตัว);
// ไม่มี id → ซ้ำเมื่อชื่อ normalize เหมือนกัน (ไม่มีทางแยกอย่างอื่น); ไม่มีทั้ง id และชื่อ → เก็บไว้ทุกตัว (ระบุไม่ได้ ห้ามรวมมั่ว)
function dedupeSameSystem(list, system) {
  const seenIds = new Set();
  const seenNames = new Set();
  const out = [];
  for (const cam of Array.isArray(list) ? list : []) {
    if (!cam) continue;
    const key = idKey(cam, system);
    if (key) {
      if (seenIds.has(key)) continue;
      seenIds.add(key);
    } else {
      const nk = normalizeName(cam.name);
      if (nk !== null) {
        if (seenNames.has(nk)) continue;
        seenNames.add(nk);
      }
    }
    out.push(cam);
  }
  return out;
}

// รวมกล้องจากหลายระบบเป็นรายการเดียวโดยไม่นับซ้ำ — คืน array ลำดับ: Zabbix ทั้งหมดก่อน แล้ว HikCentral ที่ไม่ซ้ำ
// zabbix[i].hikIndexCode (optional) = ตัวผูกกับกล้อง HikCentral ถ้ามี (ตอนนี้ไม่มีใครตั้ง — ดู CLAUDE.md)
function mergeSystems({ zabbix = [], hikcentral = [] } = {}) {
  const z = dedupeSameSystem(zabbix, 'zabbix');
  const h = dedupeSameSystem(hikcentral, 'hikcentral');
  if (z.length === 0 || h.length === 0) return [...z, ...h];

  // 1) ตัวผูกแบบรหัส: กล้อง Zabbix ที่ระบุ hikIndexCode → ตัดกล้อง Hik รหัสนั้น (ไม่สนชื่อ)
  const linkedCodes = new Set(z.map((c) => clean(c.hikIndexCode)).filter(Boolean).map((c) => `hik:${c}`));
  const afterLinks = h.filter((cam) => !linkedCodes.has(idKey(cam, 'hikcentral')));

  // 2) fallback ชื่อ 1:1 — เฉพาะกล้อง Zabbix ที่ "ยังไม่ได้ผูกด้วยรหัส"
  const available = new Map(); // ชื่อ → จำนวนกล้อง Zabbix ที่ยังตัดกล้อง Hik ได้
  for (const cam of z) {
    if (clean(cam.hikIndexCode)) continue;
    const nk = normalizeName(cam.name);
    if (nk !== null) available.set(nk, (available.get(nk) || 0) + 1);
  }
  const kept = [];
  for (const cam of afterLinks) {
    const nk = normalizeName(cam.name);
    const left = nk !== null ? available.get(nk) || 0 : 0;
    if (left > 0) { available.set(nk, left - 1); continue; }
    kept.push(cam);
  }
  return [...z, ...kept];
}

module.exports = { normalizeName, idKey, dedupeSameSystem, mergeSystems };
