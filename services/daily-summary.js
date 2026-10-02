'use strict';
// สรุปปัญหาประจำวัน — ส่งอัตโนมัติ 08:00 และ 17:00 เวลาไทย ให้ผู้ใช้ที่ approve แล้วทุกคน (ไม่ใช้ AI)
//
// แหล่งข้อมูล:
//   Zabbix     — ประวัติจริงของวันนี้จาก event.get (r_eventid ≠ 0 = แก้แล้ว) + ปัญหาที่ยัง active ตั้งแต่เมื่อวาน
//   Omada/Hik  — ได้แค่สถานะปัจจุบัน → แสดงเฉพาะที่ดับ ณ ตอนรันสรุป (ไม่มี "แก้แล้ว" ตลอดทั้งวัน)
// แหล่งไหนดึงไม่ได้ต้องบอกในข้อความ — ห้ามสรุปว่า "ปกติ" ทั้งที่ข้อมูลไม่ครบ
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');

const TZ = 'Asia/Bangkok';
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000; // ไทย UTC+7 ไม่มี DST
// เวลาที่ตั้งค่าได้ (HH:mm เวลาไทยเสมอ) — ระบุ timezone ให้ node-cron ตรงๆ จึงถูกต้องแม้ host/container เป็น UTC
// เก็บใน data/settings.json (volume เดียวกับ users.json → อยู่รอดหลัง recreate) key "dailySummaryTimes"
// Manager เป็นผู้เขียนไฟล์ แล้วเรียก POST /api/daily-summary/reload ให้ bot ตั้ง cron ใหม่ทันทีโดยไม่ restart
const DEFAULT_TIMES = ['08:00', '17:00'];
const MAX_TIMES = 24;
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');
const { APPROVED_ROLES } = require('../config'); // allow-list กลาง ใช้ร่วมกับ alert (services/push-targets.js)
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
    // กล้อง HikCentral: ซ้ำกันภายใน HikCentral ตัดด้วย index code (ชื่อซ้ำแต่รหัสต่างคือคนละตัว ต้องแสดงทั้งคู่);
    // ซ้ำกับ Zabbix/Omada ที่รายงานไปแล้ว ตัดด้วยชื่อแบบ 1:1 (Zabbix ไม่มีรหัส Hik ให้เทียบ) ดู services/camera-identity.js
    const preSeen = src === 'hikcentral' ? new Set(seen) : null;
    const consumed = new Set();
    const codes = new Set();
    const uncodedNames = new Set(); // ไม่มี index code เลย → แยกกันได้แค่ด้วยชื่อ (fallback ภายใน HikCentral)
    for (const d of r.value) {
      if (src === 'hikcentral') {
        const code = d.id === undefined || d.id === null ? '' : String(d.id).trim();
        const k = key(d.name);
        if (code) { if (codes.has(code)) continue; codes.add(code); }
        else { if (uncodedNames.has(k)) continue; uncodedNames.add(k); }
        if (preSeen.has(k) && !consumed.has(k)) { consumed.add(k); continue; }
      } else {
        if (seen.has(key(d.name))) continue;
        seen.add(key(d.name));
      }
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

// ตรวจรายการเวลา: ต้องเป็น array ของ "HH:mm" (00:00–23:59) อย่างน้อย 1 ค่า ไม่ซ้ำ — คืน { ok, times (เรียงแล้ว) } หรือ { ok:false, error }
function validateTimes(list) {
  if (!Array.isArray(list)) return { ok: false, error: 'เวลาต้องเป็นรายการ (array) ของ HH:mm' };
  if (list.length === 0) return { ok: false, error: 'ต้องมีเวลาอย่างน้อย 1 ค่า' };
  if (list.length > MAX_TIMES) return { ok: false, error: `ตั้งได้ไม่เกิน ${MAX_TIMES} เวลา` };
  for (const v of list) {
    if (typeof v !== 'string' || !TIME_RE.test(v)) return { ok: false, error: `รูปแบบเวลาไม่ถูกต้อง: "${String(v).slice(0, 20)}" (ต้องเป็น HH:mm 24 ชม. 00:00–23:59)` };
  }
  const dup = list.find((v, idx) => list.indexOf(v) !== idx);
  if (dup) return { ok: false, error: `เวลาซ้ำกัน: ${dup}` };
  return { ok: true, times: [...list].sort() };
}

// อ่านเวลาจาก settings.json — ไฟล์ไม่มี/ไม่มี key = ค่าเริ่มต้น; ไฟล์พังหรือค่าไม่ผ่าน validate = error (ผู้เรียกตัดสินใจ)
function readTimesFromFile(file = SETTINGS_PATH) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch (err) { return err.code === 'ENOENT' ? { ok: true, times: [...DEFAULT_TIMES], source: 'default' } : { ok: false, error: err.message }; }
  let doc;
  try { doc = JSON.parse(raw); } catch { return { ok: false, error: 'settings.json อ่านไม่ได้ (JSON พัง)' }; }
  if (!doc || doc.dailySummaryTimes === undefined) return { ok: true, times: [...DEFAULT_TIMES], source: 'default' };
  const v = validateTimes(doc.dailySummaryTimes);
  return v.ok ? { ok: true, times: v.times, source: 'file' } : v;
}

// เวลา (ISO) ที่ cron รอบถัดไปจะยิง ตามเวลาไทย — ไว้แสดง/ตรวจสอบ
function nextRunAt(times, nowMs = Date.now()) {
  const day0 = startOfBangkokDay(nowMs);
  let best = Infinity;
  for (const t of times) {
    const [h, m] = t.split(':').map(Number);
    for (const add of [0, 24]) {
      const at = day0 + add * 3600_000 + (h * 60 + m) * 60_000;
      if (at > nowMs && at < best) best = at;
    }
  }
  return best === Infinity ? null : new Date(best).toISOString();
}

// ตัวตั้งเวลา: แต่ละเวลา = cron 1 งาน ("M H * * *" ตามเขต Asia/Bangkok) — reload() หยุดงานเก่าทั้งหมดแล้วตั้งใหม่ (ไม่ต้อง restart)
//   runFn(label) โยน error ได้ (จับแล้ว log กันทำ process ล้ม); loadTimes = () => ({ ok, times } | { ok:false, error })
function createScheduler({ runFn, logger, loadTimes = readTimesFromFile }) {
  let tasks = [];
  let state = { times: [], exprs: [] };

  function apply(times) {
    for (const t of tasks) t.stop();
    const exprs = times.map((v) => { const [h, m] = v.split(':').map(Number); return `${m} ${h} * * *`; });
    tasks = times.map((label, i) => cron.schedule(exprs[i], async () => {
      try { await runFn(label); }
      catch (err) { logger.error('daily-summary: รันตามเวลาล้มเหลว', err); }
    }, { timezone: TZ }));
    state = { times, exprs };
  }

  return {
    // ตอน start: ไฟล์พัง → ใช้ค่าเริ่มต้น (ดีกว่าไม่ส่งสรุปเลย) แล้ว warn
    start() {
      const r = loadTimes();
      if (!r.ok) logger.warn(`daily-summary: อ่านเวลาตั้งค่าไม่ได้ (${r.error}) — ใช้ค่าเริ่มต้น ${DEFAULT_TIMES.join(', ')}`);
      apply(r.ok ? r.times : [...DEFAULT_TIMES]);
      logger.info(`daily-summary: scheduled ${state.times.join(', ')} (${state.exprs.join(' | ')}) tz=${TZ}`);
      return this.current();
    },
    // ตอน reload: ค่าใหม่ใช้ไม่ได้ → คง schedule เดิมไว้ ไม่ไปทับด้วยค่าเริ่มต้น
    reload() {
      const r = loadTimes();
      if (!r.ok) { logger.warn(`daily-summary: reload ไม่สำเร็จ (${r.error}) — คง schedule เดิม`); return { ok: false, error: r.error, ...this.current() }; }
      apply(r.times);
      logger.info(`daily-summary: rescheduled ${state.times.join(', ')} (${state.exprs.join(' | ')}) tz=${TZ}`);
      return { ok: true, ...this.current() };
    },
    current() { return { times: [...state.times], exprs: [...state.exprs], timezone: TZ, nextRun: nextRunAt(state.times) }; },
  };
}

module.exports = { run, collect, summarize, buildFlex, createScheduler, validateTimes, readTimesFromFile, nextRunAt, startOfBangkokDay, clockTH, DEFAULT_TIMES, SETTINGS_PATH, TZ, APPROVED_ROLES };
