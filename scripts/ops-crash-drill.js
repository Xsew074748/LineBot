'use strict';
// ซ้อมการแจ้งเตือน "บอทล้ม" — ไม่ทำให้โปรเซสใดล้มและไม่เรียก process.exit
//
//   node scripts/ops-crash-drill.js                 # แสดงข้อความตัวอย่าง + จำนวนผู้รับ + สถานะการตั้งค่า — ไม่ส่งอะไร
//   node scripts/ops-crash-drill.js --confirm-send  # ส่งข้อความ "[ทดสอบ]" 1 ข้อความถึง ADMIN เท่านั้น (ต้องใส่ธงนี้เท่านั้น)
//
// รันในคอนเทนเนอร์ของบอท (มี data/users.json และ LINE_CHANNEL_ACCESS_TOKEN):
//   docker exec <container> node scripts/ops-crash-drill.js [--confirm-send]
// ใช้ createAdminNotifier ตัวเดียวกับของจริง (ADMIN เท่านั้น, timeout 3 วินาที) แต่ใช้ key "drill" ของตัวเอง
// → ไม่แตะ cooldown ของ key "crash"; ไม่พิมพ์ LINE userId (แสดงเฉพาะจำนวน); ข้อความตัวอย่างสร้างจาก error สมมติที่มี "ความลับปลอม"
// เพื่อให้เห็นว่า redact ตัดจริง (ค่าปลอมทั้งหมด ไม่ใช่ค่าจาก .env)
const redact = require('../services/redact');
const { buildCrashMessage, loadConfig } = require('../services/crash-guard');
const { createAdminNotifier } = require('../services/ops-alert');

// error สมมติ — ค่าทั้งหมดปลอม
const FAKE_ERROR = new Error('ตัวอย่าง: ต่อ HikCentral ไม่ได้ appKey : FAKEAPPKEY1234 token=FAKETOKEN9876 userId=Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');

function buildDrillMessage() {
  return [
    '[ทดสอบ] ข้อความซ้อมการแจ้งเตือนบอทหยุดทำงาน — ไม่ใช่เหตุขัดข้องจริง',
    '(ส่งถึง ADMIN เท่านั้น ผ่านเส้นทางเดียวกับการแจ้งเตือนจริง; ตัวอย่างข้างล่างคือหน้าตาข้อความเมื่อบอทล้ม)',
    '',
    buildCrashMessage('uncaughtException', FAKE_ERROR, redact),
  ].join('\n');
}

// deps: { argv, env, listUsers, createSend() → send(to, message), log(text), logger, file?, timeoutMs? }
// คืน { exitCode, sent, recipients } — ไม่เรียก process.exit
async function run({ argv = [], env = process.env, listUsers, createSend, log = console.log, logger = console, file, timeoutMs } = {}) {
  const confirm = argv.includes('--confirm-send');
  const cfg = loadConfig(env);
  const admins = (listUsers() || []).filter((u) => u && u.role === 'ADMIN' && typeof u.id === 'string' && u.id);
  const text = buildDrillMessage();

  log('--- ข้อความที่จะส่ง ---');
  log(text);
  log('------------------------');
  log(`ผู้รับ: ADMIN ${admins.length} คน (ไม่แสดง userId) · เส้นทาง: createAdminNotifier (ADMIN เท่านั้น, timeout 3 วินาที)`);
  log(`การตั้งค่าตอนนี้: OPS_CRASH_NOTIFY=${cfg.notify ? 'true (เปิด)' : 'ไม่เปิด (บอทล้มจริงจะ log อย่างเดียว ไม่ส่ง LINE)'} · cooldown ${cfg.cooldownMin} นาที`);
  cfg.warnings.forEach((w) => log(`คำเตือน: ${w}`));

  if (!admins.length) { log('ไม่พบ ADMIN ใน users.json — ยกเลิก'); return { exitCode: 1, sent: 0, recipients: 0 }; }
  if (!confirm) { log('โหมดดูตัวอย่าง: ไม่ได้ส่ง (ใส่ --confirm-send เพื่อส่งจริง)'); return { exitCode: 0, sent: 0, recipients: admins.length }; }

  let send;
  try { send = createSend(); } catch (err) { log(`ส่งไม่ได้: ${err.message}`); return { exitCode: 1, sent: 0, recipients: admins.length }; }
  const notifier = createAdminNotifier({ listUsers: () => admins, send, logger, ...(file ? { file } : {}), ...(timeoutMs ? { timeoutMs } : {}) });
  const r = await notifier.notify('drill', text, { cooldownMs: 0 });
  log(`ผลการส่ง: ผู้รับ ${r.recipients} · สำเร็จ ${r.sent}${r.skipped ? ` · ข้าม (${r.skipped})` : ''}${r.timedOut ? ' · หมดเวลา' : ''}`);
  return { exitCode: r.sent > 0 ? 0 : 1, sent: r.sent, recipients: r.recipients };
}

module.exports = { run, buildDrillMessage, FAKE_ERROR };

if (require.main === module) {
  require('dotenv').config();
  const auth = require('../services/auth');
  const logger = require('../services/logger');
  run({
    argv: process.argv.slice(2),
    listUsers: auth.listUsers,
    createSend: () => {
      if (!process.env.LINE_CHANNEL_ACCESS_TOKEN) throw new Error('ไม่มี LINE_CHANNEL_ACCESS_TOKEN');
      const line = require('@line/bot-sdk');
      const client = new line.messagingApi.MessagingApiClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN });
      return (to, message) => client.pushMessage({ to, messages: [message] });
    },
    logger,
  }).then((r) => { process.exitCode = r.exitCode; }).catch((err) => { console.error('ผิดพลาด:', err.message); process.exitCode = 1; });
}
