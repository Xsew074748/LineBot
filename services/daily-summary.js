'use strict';
// สรุปปัญหาประจำวัน — ส่งอัตโนมัติ 08:00 และ 17:00 เวลาไทย ให้ผู้ใช้ที่ approve แล้วทุกคน (ไม่ใช้ AI)
//
// แหล่งข้อมูล:
//   Zabbix     — ประวัติจริงของวันนี้จาก event.get (r_eventid ≠ 0 = แก้แล้ว) + ปัญหาที่ยัง active ตั้งแต่เมื่อวาน
//   Omada/Hik  — ได้แค่สถานะปัจจุบัน → แสดงเฉพาะที่ดับ ณ ตอนรันสรุป (ไม่มี "แก้แล้ว" ตลอดทั้งวัน)
// แหล่งไหนดึงไม่ได้ต้องบอกในข้อความ — ห้ามสรุปว่า "ปกติ" ทั้งที่ข้อมูลไม่ครบ
const cron = require('node-cron');

const TZ = 'Asia/Bangkok';
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000; // ไทย UTC+7 ไม่มี DST
// 08:00 และ 17:00 เวลาไทย — ระบุ timezone ให้ node-cron ตรงๆ จึงถูกต้องแม้ host/container เป็น UTC
const SCHEDULE_EXPR = '0 8,17 * * *';
const APPROVED_ROLES = ['ADMIN', 'IT_STAFF', 'VIEWER']; // ทุก role ที่ไม่ใช่ PENDING
const MAX_PER_SECTION = 8;

// 00:00 ของวันนี้ตามเวลาไทย (ms) — คำนวณจาก offset ตรงๆ ไม่พึ่ง TZ ของ process
function startOfBangkokDay(nowMs) {
  const d = new Date(nowMs + BKK_OFFSET_MS);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - BKK_OFFSET_MS;
}

const pad = (n) => String(n).padStart(2, '0');

function clockTH(ms) {
  const d = new Date(ms + BKK_OFFSET_MS);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

function dateTH(ms) {
  const d = new Date(ms + BKK_OFFSET_MS);
  return `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear() + 543}`;
}

async function settle(name, fn) {
  try { return { name, ok: true, value: await fn() }; }
  catch (err) { return { name, ok: false, error: err.message || String(err) }; }
}

// ดึงข้อมูลจากทุกระบบที่เปิดใช้ — ตัวที่ล้มเหลวไม่ทำให้ตัวอื่นพัง
async function collect({ zabbix, omada, hikcentral }, nowMs) {
  const startSec = Math.floor(startOfBangkokDay(nowMs) / 1000);
  const [z, o, h] = await Promise.all([
    zabbix ? settle('Zabbix', async () => {
      const [events, active] = await Promise.all([zabbix.getEventsSince(startSec), zabbix.getProblems(200)]);
      return { events, active };
    }) : null,
    omada ? settle('Omada', async () => (await omada.getAPs()).all.filter((d) => d.status === 'down')) : null,
    hikcentral ? settle('HikCentral', async () => (await hikcentral.getCameras(1, 1000)).filter((c) => !c.online)) : null,
  ]);
  return { startSec, zabbix: z, omada: o, hikcentral: h };
}

// รวมผลเป็นตัวเลข/รายการ (ฟังก์ชันล้วน — ทดสอบง่าย)
function summarize(data) {
  const resolved = [];
  const ongoing = [];
  const carry = []; // ค้างมาตั้งแต่ก่อน 00:00 (ไม่นับใน total ของวันนี้)
  const warnings = [];
  const seen = new Set(); // ชื่ออุปกรณ์ที่ Zabbix รายงานแล้ว — กันนับกล้องซ้ำกับ HikCentral/Omada
  const key = (n) => String(n || '').trim().toLowerCase();

  if (data.zabbix) {
    if (!data.zabbix.ok) warnings.push(`Zabbix: ${data.zabbix.error}`);
    else {
      const { events, active } = data.zabbix.value;
      for (const e of events) {
        seen.add(key(e.host));
        if (e.resolved) resolved.push({ source: 'Zabbix', name: e.host, detail: e.name, at: e.rClock });
        else ongoing.push({ source: 'Zabbix', name: e.host, detail: e.name });
      }
      for (const p of active) {
        if (p.lastchangeTs && p.lastchangeTs >= data.startSec) continue; // ของวันนี้ อยู่ใน events แล้ว
        seen.add(key(p.host));
        carry.push({ source: 'Zabbix', name: p.host, detail: p.description });
      }
    }
  }
  for (const [src, label] of [['omada', 'Omada'], ['hikcentral', 'HikCentral']]) {
    const r = data[src];
    if (!r) continue;
    if (!r.ok) { warnings.push(`${label}: ${r.error}`); continue; }
    for (const d of r.value) {
      if (seen.has(key(d.name))) continue;
      seen.add(key(d.name));
      ongoing.push({ source: label, name: d.name, detail: src === 'omada' ? `${d.type || 'อุปกรณ์'} ออฟไลน์` : 'กล้องออฟไลน์', snapshot: true });
    }
  }
  return { total: resolved.length + ongoing.length, resolved, ongoing, carry, warnings };
}

// ── Flex message ──────────────────────────────────────────────────────────────
const t = (text, size = 'sm', color = '#333333', extra = {}) =>
  ({ type: 'text', text: String(text || '-').slice(0, 120) || '-', size, color, wrap: true, ...extra });

function section(title, color, items, fmtLine) {
  if (!items.length) return [];
  const shown = items.slice(0, MAX_PER_SECTION);
  const out = [t(title, 'sm', color, { weight: 'bold', margin: 'md' }), ...shown.map((i) => t(fmtLine(i), 'xs', '#333333', { margin: 'xs' }))];
  if (items.length > shown.length) out.push(t(`…และอีก ${items.length - shown.length} รายการ`, 'xs', '#888888', { margin: 'xs' }));
  return out;
}

function buildFlex(s, nowMs, label) {
  const hasProblem = s.total > 0 || s.carry.length > 0;
  const color = s.warnings.length ? '#E07B00' : hasProblem ? '#DC3545' : '#28A745';
  const header = {
    type: 'box', layout: 'vertical', backgroundColor: color, paddingAll: '14px',
    contents: [
      t(`📋 สรุปปัญหาประจำวัน${label ? ' ' + label : ''}`, 'md', '#FFFFFF', { weight: 'bold' }),
      t(`${dateTH(nowMs)} 00:00–${clockTH(nowMs)} น.`, 'xs', '#FFFFFF'),
    ],
  };
  const body = [];
  if (!hasProblem && !s.warnings.length) {
    body.push(t('✅ วันนี้ระบบปกติ ไม่มีปัญหา', 'md', '#28A745', { weight: 'bold' }));
    body.push(t('ระบบ monitoring ทำงานอยู่ตามปกติ', 'xs', '#888888', { margin: 'sm' }));
  } else {
    body.push(t(`ปัญหาวันนี้ ${s.total} รายการ`, 'md', '#333333', { weight: 'bold' }));
    body.push(t(`✅ แก้ไขแล้ว ${s.resolved.length}   🔴 ยังค้างอยู่ ${s.ongoing.length}`, 'sm'));
    if (s.carry.length) body.push(t(`🕓 ค้างมาจากก่อนวันนี้ ${s.carry.length} รายการ`, 'sm', '#E07B00'));
    body.push(...section('🔴 ยังค้างอยู่', '#DC3545', s.ongoing, (i) => `• ${i.name} — ${i.detail}${i.snapshot ? ' *' : ''}`));
    body.push(...section('🕓 ค้างมาจากก่อนวันนี้', '#E07B00', s.carry, (i) => `• ${i.name} — ${i.detail}`));
    body.push(...section('✅ แก้ไขแล้ว', '#28A745', s.resolved, (i) => `• ${i.name} — ${i.detail}${i.at ? ` (แก้ ${clockTH(i.at * 1000)})` : ''}`));
    if (!hasProblem) body.push(t('ไม่พบปัญหาจากระบบที่ดึงข้อมูลได้', 'sm', '#28A745', { margin: 'md' }));
  }
  if (s.warnings.length) {
    body.push(t('⚠️ ข้อมูลไม่ครบ — ดึงข้อมูลไม่ได้:', 'xs', '#E07B00', { weight: 'bold', margin: 'md' }));
    for (const w of s.warnings) body.push(t(`• ${w}`, 'xs', '#E07B00'));
  }
  body.push(t('ℹ️ Zabbix นับตลอดวัน ส่วน Omada/HikCentral (*) นับเฉพาะที่ดับ ณ เวลาสรุปนี้ ไม่ใช่ตลอดทั้งวัน', 'xxs', '#888888', { margin: 'md' }));
  return {
    type: 'bubble', size: 'mega', header,
    body: { type: 'box', layout: 'vertical', backgroundColor: '#FFFFFF', paddingAll: '14px', contents: body },
  };
}

// รันสรุป 1 รอบ: ดึงข้อมูล → สร้างข้อความ → ส่งให้ผู้รับ (ถ้าส่งให้ใครไม่ได้ log แล้วไปต่อ)
//   deps: { zabbix, omada, hikcentral, listUsers, send(userId, flex), logger, now? }
//   opts: { label, noSend } — noSend = ดึง+สร้างข้อความอย่างเดียว ไม่ push (คำสั่งแอดมิน reply ข้อความเอง)
async function run(deps, opts = {}) {
  const { logger } = deps;
  const nowMs = (deps.now || Date.now)();
  const data = await collect(deps, nowMs);
  const summary = summarize(data);
  const flex = buildFlex(summary, nowMs, opts.label);

  const recipients = opts.noSend
    ? []
    : deps.listUsers().filter((u) => APPROVED_ROLES.includes(u.role)).map((u) => u.id);

  let sent = 0;
  const failed = [];
  for (const id of recipients) {
    try {
      await deps.send(id, flex);
      sent++;
    } catch (err) {
      failed.push(id);
      logger.error(`daily-summary: ส่งให้ ${id} ไม่สำเร็จ — ข้ามไปคนถัดไป (${err.message})`);
    }
  }
  logger.info(`daily-summary: เสร็จ total=${summary.total} resolved=${summary.resolved.length} ongoing=${summary.ongoing.length} carry=${summary.carry.length} warnings=${summary.warnings.length} sent=${sent}/${recipients.length}`);
  return { summary, flex, sent, failed, recipients: recipients.length };
}

// ตั้งเวลา 08:00 และ 17:00 เวลาไทยทุกวัน — runFn โยน error ได้ (จับแล้ว log กันทำ process ล้ม)
function startSchedule(runFn, logger) {
  return cron.schedule(SCHEDULE_EXPR, async () => {
    const label = clockTH(Date.now()).startsWith('08') ? '08:00' : '17:00';
    try { await runFn(label); }
    catch (err) { logger.error('daily-summary: รันตามเวลาล้มเหลว', err); }
  }, { timezone: TZ });
}

module.exports = { run, collect, summarize, buildFlex, startSchedule, startOfBangkokDay, clockTH, SCHEDULE_EXPR, TZ, APPROVED_ROLES };
