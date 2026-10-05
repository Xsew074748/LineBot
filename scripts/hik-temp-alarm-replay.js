'use strict';
// เล่นซ้ำเหตุการณ์ Temperature Alarm จริง (17 ก.ย. 2026 กล้อง 1088) เสมือนเกิดใหม่ แล้วพิมพ์ข้อความที่บอทจะส่ง
// ไม่ต่อเครือข่าย ไม่เรียก HikCentral/LINE ไม่เขียนไฟล์ — ใช้ตรวจหน้าตาข้อความและตรรกะ (กันซ้ำ/cooldown/รวมข้อความ) ก่อนเปิดฟีเจอร์จริง
//   node scripts/hik-temp-alarm-replay.js            # เหตุการณ์ 1 รายการ
//   node scripts/hik-temp-alarm-replay.js --burst    # เพิ่มเหตุการณ์ใกล้กันหลายรายการ ดูการรวมข้อความ/cooldown
// record ด้านล่างคือ record ดิบจริงจาก HikCentral (eventIndexCode จริง) — ช่องรูปใส่ค่า "(ตัด)" ไว้ ไม่มี URL รูป
const { normalizeEventRecord } = require('../services/hikcentral');
const { loadConfig, evaluate, renderMessage, freshState } = require('../services/hik-temp-alarm');

const REAL_RECORD = {
  eventIndexCode: 'B8EA03BCA93F4CEC8A6DF48A7773347E',
  eventType: '192517',
  srcType: 'camera',
  srcIndex: '1088',
  description: '',
  startTime: '2026-09-17T09:10:37+07:00',
  stopTime: '2026-09-17T09:10:52+07:00',
  eventPicUri: '(ตัด)',
  eventPicList: '(ตัด)',
  linkCameraIndexCode: '1088',
};
const NAMES = { 1086: 'บ่อขยะ.กล้องความร้อน1-Color', 1087: 'บ่อขยะ.กล้องความร้อน2-Color', 1088: 'บ่อขยะ.กล้องความร้อน1-BW', 1089: 'บ่อขยะ.กล้องความร้อน2-BW' };

const burst = process.argv.includes('--burst');
const cfg = loadConfig({ HIKCENTRAL_TEMP_ALARM_ENABLED: 'true', HIKCENTRAL_TEMP_ALARM_CAMERAS: '1086,1087,1088,1089' });

const raw = [REAL_RECORD];
if (burst) {
  const t0 = Date.parse(REAL_RECORD.startTime);
  const iso = (ms) => new Date(ms + 7 * 3600e3).toISOString().replace(/\.\d+Z$/, '+07:00');
  const add = (suffix, cam, offsetMin) => raw.push({ ...REAL_RECORD, eventIndexCode: `REPLAY-${suffix}`, srcIndex: cam, linkCameraIndexCode: cam, startTime: iso(t0 + offsetMin * 60_000), stopTime: iso(t0 + offsetMin * 60_000 + 15_000) });
  add('A', '1088', 3);            // กล้องเดิมใน cooldown → ไม่แจ้งซ้ำ แต่นับรวม
  add('B', '1089', 4);
  add('C', '1086', 5);
  add('D', '1087', 6);
  add('E', '1089', 20);           // พ้น cooldown 10 นาที → แจ้งได้
  add('F', '1088', 25);
  add('G', '1086', 30);
}
const events = raw.map(normalizeEventRecord).filter(Boolean);
const startMs = Math.min(...events.map((e) => e.startMs));
const nowMs = Math.max(...events.map((e) => e.startMs)) + 60_000; // ตรวจเจอหลังเหตุการณ์ล่าสุด 1 นาที

// state เริ่มทำงานก่อนเหตุการณ์ 1 ชม. (เหตุการณ์เหล่านี้ "เกิดหลังเริ่มทำงาน" จึงนับเป็นของใหม่)
const state0 = freshState(startMs - 3600_000);
const r1 = evaluate(state0, events, cfg, nowMs);
console.log(`ใหม่ ${r1.fresh} รายการ → actions: ${r1.actions.map((a) => a.type).join(', ') || '(ไม่มี)'}\n`);
for (const a of r1.actions) if (a.type === 'alert') console.log(renderMessage(a, { names: NAMES, nowMs, cooldownMin: cfg.cooldownMin }) + '\n');

// รอบถัดไปได้ record เดิม (ช่วงค้นเหลื่อมเวลา) → ต้องไม่แจ้งซ้ำ
const r2 = evaluate(r1.state, events, cfg, nowMs + 60_000);
console.log(`รอบถัดไป (record เดิมมาอีก): ใหม่ ${r2.fresh} รายการ, actions: ${r2.actions.map((a) => a.type).join(', ') || '(ไม่มี — ไม่แจ้งซ้ำ ✔)'}`);
console.log(`ผู้รับ: severity ${cfg.severity} → ADMIN/IT_STAFF เท่านั้น (ผ่าน pushToUsers เดิม) | โหมดนี้ไม่ส่งจริง`);
