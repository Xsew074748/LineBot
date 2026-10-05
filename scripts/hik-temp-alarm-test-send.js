'use strict';
// ส่งข้อความทดสอบ "[ทดสอบ]" 1 ข้อความถึง ADMIN เท่านั้น ผ่านเส้นทางส่งจริงเดียวกับฟีเจอร์ Temperature Alarm
// (createAlertPusher ใน services/push-targets.js + lineClient.pushMessage — แค่ส่ง listUsers ที่กรองเฉพาะ role ADMIN เข้าไป ไม่แก้โครงสร้างผู้รับ)
//
//   node scripts/hik-temp-alarm-test-send.js                 # แสดงข้อความ + จำนวนผู้รับ — ไม่ส่ง ไม่สร้าง LINE client
//   node scripts/hik-temp-alarm-test-send.js --confirm-send  # ส่งจริงถึง ADMIN (ต้องใส่ธงนี้เท่านั้น)
//
// รันในคอนเทนเนอร์ของบอท (มี data/users.json และ LINE_CHANNEL_ACCESS_TOKEN): docker exec netguard-itmonitor node scripts/hik-temp-alarm-test-send.js
// ไม่พิมพ์ LINE userId (แสดงเฉพาะจำนวน) และไม่ใช่เหตุการณ์จริง — ไม่แตะ state ของฟีเจอร์
const { normalizeEventRecord } = require('../services/hikcentral');
const { renderMessage } = require('../services/hik-temp-alarm');
const { createAlertPusher } = require('../services/push-targets');

const SAMPLE_RECORD = { // record ดิบจริงของเหตุการณ์ 17 ก.ย. 2026 (ไม่มีช่องรูป)
  eventIndexCode: 'B8EA03BCA93F4CEC8A6DF48A7773347E', eventType: '192517', srcType: 'camera', srcIndex: '1088',
  startTime: '2026-09-17T09:10:37+07:00', stopTime: '2026-09-17T09:10:52+07:00',
};
const SAMPLE_NAMES = { 1088: 'บ่อขยะ.กล้องความร้อน1-BW' };
const TEST_SEVERITY = 3;

function buildTestMessage() {
  const ev = normalizeEventRecord(SAMPLE_RECORD);
  const sample = renderMessage({ type: 'alert', shown: [ev], extra: 0, suppressed: 0, total: 1 }, { names: SAMPLE_NAMES, nowMs: ev.startMs + 60_000 });
  return [
    '[ทดสอบ] ข้อความทดสอบระบบแจ้งเตือน Temperature Alarm — ไม่ใช่เหตุการณ์จริง ไม่ต้องดำเนินการ',
    '(ส่งถึง ADMIN เท่านั้น ผ่านเส้นทางเดียวกับการแจ้งเตือนจริง; ด้านล่างคือตัวอย่างหน้าตาข้อความจริง)',
    '',
    sample,
  ].join('\n');
}

// deps: { argv, listUsers, createSend() → send(to, message), log(text), logger }
// คืน { exitCode, sent, recipients }
async function run({ argv = [], listUsers, createSend, log = console.log, logger = console } = {}) {
  const confirm = argv.includes('--confirm-send');
  const admins = (listUsers() || []).filter((u) => u && u.role === 'ADMIN' && typeof u.id === 'string' && u.id);
  const text = buildTestMessage();

  log('--- ข้อความที่จะส่ง ---');
  log(text);
  log('------------------------');
  log(`ผู้รับ: ADMIN ${admins.length} คน (ไม่แสดง userId) · severity ${TEST_SEVERITY} · เส้นทาง: createAlertPusher + lineClient.pushMessage`);

  if (!admins.length) { log('ไม่พบ ADMIN ใน users.json — ยกเลิก'); return { exitCode: 1, sent: 0, recipients: 0 }; }
  if (!confirm) { log('โหมดดูตัวอย่าง: ไม่ได้ส่ง (ใส่ --confirm-send เพื่อส่งจริง)'); return { exitCode: 0, sent: 0, recipients: admins.length }; }

  let send;
  try { send = createSend(); } catch (err) { log(`ส่งไม่ได้: ${err.message}`); return { exitCode: 1, sent: 0, recipients: admins.length }; }
  const pusher = createAlertPusher({ listUsers: () => admins, send, logger });
  const r = await pusher(text, TEST_SEVERITY);
  log(`ผลการส่ง: ผู้รับ ${r.recipients} · สำเร็จ ${r.sent} · ล้มเหลว ${r.failed}`);
  return { exitCode: r.sent > 0 ? 0 : 1, sent: r.sent, recipients: r.recipients };
}

module.exports = { run, buildTestMessage, TEST_SEVERITY };

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
  }).then((r) => process.exit(r.exitCode)).catch((err) => { console.error('ผิดพลาด:', err.message); process.exit(1); });
}
