'use strict';
// แจ้งเหตุปฏิบัติการ (เช่น บอทล้ม) ถึง ADMIN เท่านั้น — best-effort ไม่ทำให้ผู้เรียกค้างหรือพัง
//
//   const n = createAdminNotifier({ listUsers, send, logger });
//   await n.notify('crash', 'ข้อความ', { cooldownMs: 30 * 60_000 }) → { sent, recipients, skipped?, timedOut? }
//
// - send(to, message) มาจากผู้เรียก (index.js) — โมดูลนี้ไม่แตะ LINE client เอง
// - cooldown ต่อ key เก็บใน data/ops-alert.json (atomic: เขียน .tmp แล้ว rename; รอด restart/recreate เพราะ data/ เป็น volume)
//   เขียน timestamp "ก่อน" ส่ง → crash ซ้ำหลัง restart ก็ไม่ส่งซ้ำ; เขียนไฟล์ไม่ได้ = ข้ามการแจ้ง (กันส่งรัวโดยไม่มีที่จำ) แล้ว log
// - ไม่ log/คืน LINE userId (รายงานแค่จำนวน)
const fs = require('fs');
const path = require('path');

const DEFAULT_FILE = path.join(__dirname, '..', 'data', 'ops-alert.json');
const DEFAULT_TIMEOUT_MS = 3000;

function readState(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'));
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch { return {}; } // ไม่มี/พัง → เหมือนไม่เคยแจ้ง
}

// คืน true เมื่อบันทึกสำเร็จ
function writeStateAtomic(file, state) {
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* ไม่มี tmp */ }
    return false;
  }
}

// deps: { listUsers, send(to, message), logger, now?, file?, timeoutMs? }
function createAdminNotifier({ listUsers, send, logger = console, now = Date.now, file = DEFAULT_FILE, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  async function notify(key, text, { cooldownMs = 0 } = {}) {
    let admins;
    try {
      admins = (listUsers() || []).filter((u) => u && u.role === 'ADMIN' && typeof u.id === 'string' && u.id);
    } catch (err) {
      logger.warn(`ops-alert[${key}]: อ่านรายชื่อผู้ใช้ไม่ได้ (${err && err.message}) — ข้ามการแจ้ง`);
      return { sent: 0, recipients: 0, skipped: 'list-users-failed' };
    }
    if (!admins.length) {
      logger.warn(`ops-alert[${key}]: ไม่มีผู้ใช้ role ADMIN — ข้ามการแจ้ง`);
      return { sent: 0, recipients: 0, skipped: 'no-admin' };
    }

    const state = readState(file);
    const last = Number(state[key]);
    if (cooldownMs > 0 && Number.isFinite(last) && now() - last < cooldownMs) {
      logger.info(`ops-alert[${key}]: อยู่ใน cooldown — ไม่ส่งซ้ำ`);
      return { sent: 0, recipients: admins.length, skipped: 'cooldown' };
    }

    state[key] = now();
    if (!writeStateAtomic(file, state)) {
      logger.warn(`ops-alert[${key}]: เขียน ${path.basename(file)} ไม่ได้ — ข้ามการแจ้ง (กันส่งซ้ำรัวโดยไม่มี cooldown)`);
      return { sent: 0, recipients: admins.length, skipped: 'state-unwritable' };
    }

    let sent = 0;
    let timer;
    const sendAll = Promise.allSettled(admins.map((a) =>
      Promise.resolve().then(() => send(a.id, { type: 'text', text })).then(() => { sent += 1; }),
    ));
    const timedOut = await Promise.race([
      sendAll.then(() => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(true), timeoutMs); }),
    ]);
    clearTimeout(timer);
    if (timedOut) logger.warn(`ops-alert[${key}]: ส่งไม่ทันใน ${timeoutMs} มิลลิวินาที — ไปต่อ`);
    else if (sent < admins.length) logger.warn(`ops-alert[${key}]: ส่งสำเร็จ ${sent}/${admins.length}`);
    return { sent, recipients: admins.length, ...(timedOut ? { timedOut: true } : {}) };
  }

  return { notify };
}

module.exports = { createAdminNotifier, DEFAULT_FILE, DEFAULT_TIMEOUT_MS };
