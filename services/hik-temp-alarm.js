'use strict';
// แจ้งเตือน LINE เมื่อมี Temperature Alarm จาก HikCentral (กล้องความร้อน) — ปิดเป็นค่าเริ่มต้น และเปิดมาก็เป็น DRYRUN
//
// ที่มาของข้อมูล: POST eventService/v1/eventRecords/page (hikcentral.getTempAlarmEvents — ผ่าน circuit breaker เดิม)
//   ✔ ยืนยันกับ HikCentral จริง (2026-10-05): eventType 192517 = Temperature Alarm, srcType camera, กล้องความร้อน 1086/1087/1088/1089
//   ✔ record มี eventIndexCode (ใช้กันซ้ำ), startTime, stopTime — **ไม่มีตัวเลขอุณหภูมิ และ description ว่าง** → ข้อความไม่ใส่อุณหภูมิ
//     แต่บอกให้ไปตรวจค่าที่ HikCentral
//   ⚠️ ยังไม่ทราบความหน่วงที่ HikCentral บันทึกเหตุการณ์ → ค้นแบบเหลื่อมเวลา (ย้อน 30 นาที) แล้วกรองซ้ำด้วย eventIndexCode
//
// ค่าที่ตั้งผ่าน env (HIKCENTRAL_TEMP_ALARM_*):
//   ENABLED=true        เปิดใช้ (ค่าเริ่มต้น false — ไม่ทำงาน)
//   DRYRUN              ค่าเริ่มต้น true: คำนวณ/log "ข้อความที่จะส่ง" อย่างเดียว ไม่ส่ง LINE ไม่เขียน state — ต้องตั้ง false ชัดเจนจึงจะส่งจริง
//   TYPES=192517        รหัส eventType (จำนวนเต็มคั่น ",")
//   CAMERAS=1086,1087,1088,1089   camera index code ที่เฝ้า (ต้องระบุ — ไม่ระบุ = ไม่ทำงาน ไม่เดาจากชื่อ)
//   INTERVAL_SEC=60     ตรวจทุกกี่วินาที (30–3600)
//   LOOKBACK_MIN=30     ค้นย้อนจาก watermark กี่นาทีเผื่อ HikCentral บันทึกเหตุการณ์ช้า (1–1440; ช่วงค้นรวมไม่เกิน 24 ชม.)
//   COOLDOWN_MIN=10     กล้องตัวเดียวกันเกิดซ้ำภายในกี่นาที (นับจากเวลาเกิดเหตุ) ไม่แจ้งซ้ำ แต่นับรวมในข้อความ (0 = ไม่ใช้)
//   SEVERITY=3          ระดับที่ส่งเข้า pushToUsers (3 = เฉพาะ ADMIN/IT_STAFF; ≥4 ถึง VIEWER ด้วย)
//
// กันย้อนส่ง: รอบแรกที่ไม่มี state เริ่มนับจากเวลาที่เริ่มทำงาน (sinceMs) — เหตุการณ์ก่อนหน้านั้นไม่แจ้งเลย
//   state = { sinceMs, watermarkMs, seen[eventIndexCode ≤200], lastAlertByCam } เก็บใน data/ (รอด restart/recreate)
// กัน LINE ท่วม: รวมเหตุการณ์ในรอบเดียวเป็นข้อความเดียว (แสดงสูงสุด 5 + "และอีก N") + cooldown ต่อกล้อง
// ดึงไม่ได้/breaker เปิด → ข้ามรอบ ไม่เปลี่ยน state ไม่ส่งอะไร; ส่ง LINE ไม่สำเร็จเลย → ไม่บันทึก state (รอบหน้าลองใหม่)
const fs = require('fs');
const path = require('path');
const { withTimeout } = require('./stats');

const DEFAULT_TYPES = [192517];
const DEFAULT_LOOKBACK_MIN = 30;
const OVERLAP_MS = DEFAULT_LOOKBACK_MIN * 60_000; // ค่าเริ่มต้นของการค้นย้อนจาก watermark เผื่อ HikCentral บันทึกช้า (ปรับด้วย LOOKBACK_MIN)
const MAX_WINDOW_MS = 24 * 3600_000;     // ช่วงค้นไม่เกิน 24 ชม. (เพดานของ API คือ 31 วัน)
const SEEN_MAX = 200;
const MAX_SHOWN = 5;
const OLD_EVENT_NOTE_MS = 15 * 60_000;   // เหตุการณ์เก่ากว่านี้ตอนแจ้ง → ระบุว่าเป็นเหตุการณ์ย้อนหลัง
const FETCH_TIMEOUT_MS = 30_000;
const NAMES_TIMEOUT_MS = 15_000;
const NAMES_TTL_MS = 3600_000;
const START_DELAY_MS = 30_000;
const DEFAULT_STATE_FILE = path.join(__dirname, '..', 'data', 'hik-temp-alarm.json');
const CODE_RE = /^[A-Za-z0-9_.-]{1,64}$/;

// ── config ────────────────────────────────────────────────────────────────────
function intInRange(raw, fallback, min, max) {
  const s = String(raw ?? '').trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number.parseInt(s, 10);
  return n >= min && n <= max ? n : fallback;
}

function splitList(raw) {
  return String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
}

// คืน { enabled, active, dryRun, types[], cameras[], intervalSec, lookbackMin, cooldownMin, severity, warnings[] }
// active = enabled และมีกล้องที่ถูกต้องอย่างน้อย 1 ตัว (ไม่มี = ไม่ทำงาน)
function loadConfig(env = process.env) {
  const warnings = [];
  const P = 'HIKCENTRAL_TEMP_ALARM_';
  const enabled = String(env[`${P}ENABLED`] ?? '').trim().toLowerCase() === 'true';

  // DRYRUN ปลอดภัยไว้ก่อน: ส่งจริงต่อเมื่อตั้ง "false" ชัดเจนเท่านั้น (ค่าว่าง/พิมพ์ผิด = ยัง dry-run)
  const dryRaw = String(env[`${P}DRYRUN`] ?? '').trim().toLowerCase();
  const dryRun = dryRaw !== 'false';
  if (dryRaw !== '' && dryRaw !== 'true' && dryRaw !== 'false') warnings.push(`${P}DRYRUN="${dryRaw.slice(0, 20)}" ไม่ใช่ true/false — ใช้ DRYRUN (ไม่ส่งจริง)`);

  const types = [];
  const badTypes = [];
  for (const t of splitList(env[`${P}TYPES`])) {
    if (/^\d{1,12}$/.test(t) && Number(t) > 0) { if (!types.includes(Number(t))) types.push(Number(t)); } else badTypes.push(t.slice(0, 20));
  }
  if (badTypes.length) warnings.push(`${P}TYPES มีค่าที่ไม่ใช่จำนวนเต็มบวก ถูกข้าม: ${badTypes.slice(0, 5).join(', ')}`);
  if (types.length > 20) types.length = 20;
  if (!types.length) {
    if (String(env[`${P}TYPES`] ?? '').trim() !== '') warnings.push(`${P}TYPES ใช้ไม่ได้เลย — ใช้ค่าเริ่มต้น ${DEFAULT_TYPES.join(',')}`);
    types.push(...DEFAULT_TYPES);
  }

  const cameras = [];
  const badCams = [];
  for (const c of splitList(env[`${P}CAMERAS`])) {
    if (CODE_RE.test(c)) { if (!cameras.includes(c)) cameras.push(c); } else badCams.push(c.slice(0, 20));
  }
  if (badCams.length) warnings.push(`${P}CAMERAS มีรหัสกล้องรูปแบบไม่ถูกต้อง ถูกข้าม: ${badCams.slice(0, 5).join(', ')}`);
  if (cameras.length > 50) cameras.length = 50;
  if (enabled && !cameras.length) warnings.push(`${P}ENABLED=true แต่ไม่มี ${P}CAMERAS ที่ใช้ได้ — ไม่ทำงาน (ไม่เดากล้องจากชื่อ)`);

  return {
    enabled,
    active: enabled && cameras.length > 0,
    dryRun,
    types,
    cameras,
    intervalSec: intInRange(env[`${P}INTERVAL_SEC`], 60, 30, 3600),
    lookbackMin: intInRange(env[`${P}LOOKBACK_MIN`], DEFAULT_LOOKBACK_MIN, 1, 1440),
    cooldownMin: intInRange(env[`${P}COOLDOWN_MIN`], 10, 0, 1440),
    severity: intInRange(env[`${P}SEVERITY`], 3, 0, 5),
    warnings,
  };
}

// ── state ─────────────────────────────────────────────────────────────────────
const freshState = (nowMs) => ({ sinceMs: nowMs, watermarkMs: nowMs, seen: [], lastAlertByCam: {} });

// อ่านจากไฟล์/ค่าที่ไม่น่าเชื่อถือ → state ที่ถูกต้อง หรือ null (พัง/ไม่มี → ผู้เรียกเริ่มใหม่ ไม่ย้อนส่ง)
function normalizeState(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return null;
  if (!Number.isFinite(doc.sinceMs) || doc.sinceMs <= 0) return null;
  const last = {};
  if (doc.lastAlertByCam && typeof doc.lastAlertByCam === 'object' && !Array.isArray(doc.lastAlertByCam)) {
    for (const [k, v] of Object.entries(doc.lastAlertByCam)) if (CODE_RE.test(k) && Number.isFinite(v)) last[k] = v;
  }
  return {
    sinceMs: doc.sinceMs,
    watermarkMs: Number.isFinite(doc.watermarkMs) && doc.watermarkMs >= doc.sinceMs ? doc.watermarkMs : doc.sinceMs,
    seen: Array.isArray(doc.seen) ? doc.seen.filter((x) => typeof x === 'string' && x).slice(-SEEN_MAX) : [],
    lastAlertByCam: last,
  };
}

function fileStore(file = DEFAULT_STATE_FILE, logger = null) {
  return {
    load() {
      try { return normalizeState(JSON.parse(fs.readFileSync(file, 'utf8'))); } catch { return null; }
    },
    save(state) {
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, file);
        return true;
      } catch (err) {
        if (logger) logger.warn(`hik-temp-alarm: บันทึก state ไม่ได้ (${err.code || err.message}) — ใช้ในหน่วยความจำต่อ`);
        try { fs.unlinkSync(tmp); } catch { /* ไม่มี tmp */ }
        return false;
      }
    },
  };
}

// ช่วงเวลาที่ต้องค้นรอบนี้ — ไม่ก่อน sinceMs (ไม่ย้อนส่ง), ย้อนจาก watermark เผื่อบันทึกช้า, และไม่เกิน 24 ชม.
function queryWindow(state, nowMs, lookbackMs = OVERLAP_MS) {
  return { startMs: Math.max(state.sinceMs, state.watermarkMs - lookbackMs, nowMs - MAX_WINDOW_MS), endMs: nowMs };
}

// ── evaluate (บริสุทธิ์: ไม่มี I/O ไม่แก้ state เดิม) ──────────────────────────────
// events: [{ id, type, cameraId, startMs }] จาก hikcentral.getTempAlarmEvents
// คืน { state, actions[], fresh } — actions: { type:'alert', shown[], extra, suppressed, total } | { type:'suppressed', count }
function evaluate(prevState, events, cfg, nowMs) {
  const prev = normalizeState(prevState) || freshState(nowMs);
  const seen = new Set(prev.seen);
  const camSet = new Set(cfg.cameras);
  const typeSet = new Set(cfg.types);

  const fresh = [];
  const inBatch = new Set();
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || !e.id || inBatch.has(e.id) || seen.has(e.id)) continue;
    if (!camSet.has(e.cameraId) || !typeSet.has(e.type)) continue;
    if (!Number.isFinite(e.startMs) || e.startMs < prev.sinceMs) continue; // ก่อนเริ่มทำงาน → ไม่ย้อนส่ง
    inBatch.add(e.id);
    fresh.push(e);
  }
  fresh.sort((a, b) => a.startMs - b.startMs || (a.id < b.id ? -1 : 1));

  const cooldownMs = cfg.cooldownMin * 60_000;
  const lastAlertByCam = { ...prev.lastAlertByCam };
  const alerted = [];
  const suppressed = [];
  for (const e of fresh) {
    const last = lastAlertByCam[e.cameraId];
    if (cooldownMs > 0 && last !== undefined && e.startMs - last < cooldownMs) suppressed.push(e);
    else { alerted.push(e); lastAlertByCam[e.cameraId] = e.startMs; }
  }
  for (const [cam, t] of Object.entries(lastAlertByCam)) if (nowMs - t > MAX_WINDOW_MS) delete lastAlertByCam[cam];

  const state = {
    sinceMs: prev.sinceMs,
    watermarkMs: fresh.reduce((m, e) => Math.max(m, e.startMs), prev.watermarkMs),
    seen: [...prev.seen, ...fresh.map((e) => e.id)].slice(-SEEN_MAX),
    lastAlertByCam,
  };

  const actions = [];
  if (alerted.length) {
    actions.push({ type: 'alert', shown: alerted.slice(0, MAX_SHOWN), extra: Math.max(0, alerted.length - MAX_SHOWN), suppressed: suppressed.length, total: alerted.length });
  } else if (suppressed.length) {
    actions.push({ type: 'suppressed', count: suppressed.length });
  }
  return { state, actions, fresh: fresh.length };
}

// ── ข้อความ ─────────────────────────────────────────────────────────────────────
const pad = (n) => String(n).padStart(2, '0');
function fmtTime(ms) { // เวลาไทย (+07:00)
  const d = new Date(ms + 7 * 3600_000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} (+07:00)`;
}
function fmtAge(ms) {
  const min = Math.max(1, Math.round(ms / 60_000));
  return min < 60 ? `${min} นาที` : `${Math.round(min / 60)} ชม.`;
}

// names: { cameraId: ชื่อกล้อง } — ไม่มี → "กล้อง <รหัส>"; ไม่ใส่ตัวเลขอุณหภูมิ (API ไม่ให้) และไม่มี URL รูป
function renderMessage(action, { names = {}, nowMs = Date.now(), cooldownMin = 0 } = {}) {
  const lines = ['🌡️ Temperature Alarm (กล้องความร้อน)'];
  for (const e of action.shown) {
    const nm = names[e.cameraId];
    const name = nm && nm !== e.cameraId ? `${nm} (${e.cameraId})` : `กล้อง ${e.cameraId}`; // ชื่อซ้ำกับรหัส/ไม่มีชื่อ → ใช้รหัส
    const age = nowMs - e.startMs > OLD_EVENT_NOTE_MS ? ` [เหตุการณ์ย้อนหลัง ${fmtAge(nowMs - e.startMs)}]` : '';
    lines.push(`• ${name} — ${fmtTime(e.startMs)}${age}`);
  }
  if (action.extra > 0) lines.push(`…และอีก ${action.extra} รายการ`);
  if (action.suppressed > 0) lines.push(`(ไม่นับซ้ำ ${action.suppressed} รายการของกล้องเดียวกันที่เกิดภายใน ${cooldownMin} นาที)`);
  lines.push('กรุณาตรวจค่าอุณหภูมิที่ HikCentral (ระบบแจ้งเตือนนี้ไม่ได้รับตัวเลขอุณหภูมิ)');
  return lines.join('\n');
}

// ── checker ─────────────────────────────────────────────────────────────────────
// deps: hikcentral (getTempAlarmEvents, getCameras, getBreakerState), pusher(text, severity) → { recipients, sent, failed }
function createChecker({ hikcentral, pusher, logger = console, env = process.env, now = Date.now, store = null } = {}) {
  const cfg = loadConfig(env);
  const st = store || fileStore(DEFAULT_STATE_FILE, logger);
  const startedAtMs = now();
  const loaded = normalizeState(st.load());
  let state = loaded || freshState(startedAtMs); // ไม่มี/เสีย → นับจากเวลาเริ่มทำงาน (ไม่ย้อนส่ง)
  const warned = new Set();
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); logger.warn(msg); } };
  let timer = null; let startTimer = null; let running = false;
  let lastTickAt = null; let lastResult = null; // ให้ /health/deep ดูว่า loop ยังเดินอยู่ (บันทึกเมื่อ "จบรอบ"; รอบที่ค้างไม่จบ = ไม่ tick)
  let nameCache = { map: {}, at: 0 };

  async function resolveNames() {
    if (nameCache.at && now() - nameCache.at < NAMES_TTL_MS) return nameCache.map;
    try {
      const cams = await withTimeout(hikcentral.getCameras(1, 500), NAMES_TIMEOUT_MS);
      const map = {};
      for (const c of cams || []) if (c && c.id) map[String(c.id)] = c.name;
      nameCache = { map, at: now() };
      return map;
    } catch {
      return nameCache.map; // ชื่อไม่ได้ → ใช้รหัสกล้องแทน (ข้อความยังส่งได้)
    }
  }

  const errText = (err) => (err && err.name === 'CircuitOpenError' ? 'breaker เปิดอยู่' : String((err && (err.code || err.message)) || 'unknown').slice(0, 120));

  async function check() {
    if (!cfg.active) return { status: 'disabled' };
    if (typeof hikcentral.getBreakerState === 'function' && hikcentral.getBreakerState().state === 'open') {
      warnOnce('fetch', 'hik-temp-alarm: HikCentral breaker เปิดอยู่ — ข้ามรอบนี้ ไม่เปลี่ยนสถานะ');
      return { status: 'breaker-open' };
    }

    const nowMs = now();
    const { startMs, endMs } = queryWindow(state, nowMs, cfg.lookbackMin * 60_000);
    let result;
    try {
      result = await withTimeout(hikcentral.getTempAlarmEvents({ startMs, endMs, eventTypes: cfg.types, srcIndexs: cfg.cameras.join(',') }), FETCH_TIMEOUT_MS);
      warned.delete('fetch');
    } catch (err) {
      warnOnce('fetch', `hik-temp-alarm: ดึงเหตุการณ์ไม่ได้ (${errText(err)}) — ข้ามรอบนี้ ไม่เปลี่ยนสถานะ`);
      return { status: 'fetch-failed' };
    }
    if (result.truncated) warnOnce('truncated', 'hik-temp-alarm: เหตุการณ์มากกว่าที่ดึงได้ต่อรอบ (ตัดที่หน้าสุดท้าย) — รอบถัดไปจะค้นซ้ำช่วงเหลื่อมเวลา');
    else warned.delete('truncated');

    const ev = evaluate(state, result.events, cfg, nowMs);
    const alert = ev.actions.find((a) => a.type === 'alert');
    const suppressedOnly = ev.actions.find((a) => a.type === 'suppressed');
    if (suppressedOnly) logger.info(`hik-temp-alarm: ${suppressedOnly.count} เหตุการณ์อยู่ใน cooldown ของกล้องเดิม — ไม่แจ้งซ้ำ`);

    if (alert) {
      const text = renderMessage(alert, { names: await resolveNames(), nowMs, cooldownMin: cfg.cooldownMin });
      if (cfg.dryRun) {
        // DRYRUN เก็บ state ในหน่วยความจำเท่านั้น — ไม่เขียนไฟล์ ไม่ส่ง (ไม่งั้นพอปิด dry-run แล้ว seen ที่ค้างจะกันการแจ้งจริง)
        logger.info(`hik-temp-alarm[DRYRUN]: จะส่ง (severity ${cfg.severity}, ${alert.total} รายการ) — ${text.split('\n').join(' | ')}`);
      } else {
        let sentOk = true;
        try {
          const r = await pusher(text, cfg.severity);
          if (r && r.recipients > 0 && r.sent === 0) sentOk = false; // ส่งไม่ถึงใครเลย → ไม่บันทึก state รอบหน้าลองใหม่
          logger.info(`hik-temp-alarm: ส่งแล้ว (${alert.total} รายการ; ผู้รับ ${r && r.recipients !== undefined ? r.recipients : '?'}, สำเร็จ ${r && r.sent !== undefined ? r.sent : '?'})`);
        } catch (err) {
          sentOk = false;
          logger.error(`hik-temp-alarm: ส่งไม่สำเร็จ: ${errText(err)}`);
        }
        if (!sentOk) return { status: 'send-failed', actions: ['alert'] };
      }
    }

    state = ev.state;
    if (!cfg.dryRun && ev.fresh > 0) st.save(state);
    return { status: 'ok', actions: ev.actions.map((a) => a.type), state };
  }

  // กันรอบซ้อนกัน (ถ้ารอบก่อนยังไม่จบ ข้ามรอบนี้)
  async function safeCheck() {
    if (running) return;
    running = true;
    try { const r = await check(); lastResult = (r && r.status) || 'ok'; } catch (err) { lastResult = 'error'; logger.error(`hik-temp-alarm: ผิดพลาด: ${errText(err)}`); } finally { running = false; lastTickAt = now(); }
  }

  function start() {
    cfg.warnings.forEach((w) => logger.warn(`hik-temp-alarm: ${w}`));
    if (!cfg.active) return () => {};
    // ไม่มี state ที่ใช้ได้ → บันทึกเวลาเริ่มทำงานทันที (ไม่ใช่ตอนรอบแรก) กันเหตุการณ์ที่เกิดระหว่างรอ delay ถูกข้าม และกัน restart ซ้อนรีเซ็ตเส้น since
    if (!cfg.dryRun && !loaded) st.save(state);
    logger.info(`hik-temp-alarm: เปิดใช้ (กล้อง ${cfg.cameras.length} ตัว, types=${cfg.types.join(',')}, ทุก ${cfg.intervalSec}s, lookback=${cfg.lookbackMin}m, cooldown=${cfg.cooldownMin}m, severity=${cfg.severity}${cfg.dryRun ? ', DRYRUN' : ''})`);
    startTimer = setTimeout(safeCheck, START_DELAY_MS);
    timer = setInterval(safeCheck, cfg.intervalSec * 1000);
    if (startTimer.unref) startTimer.unref();
    if (timer.unref) timer.unref();
    return stop;
  }
  function stop() {
    if (startTimer) clearTimeout(startTimer);
    if (timer) clearInterval(timer);
    startTimer = null; timer = null;
  }

  // สถานะ loop สำหรับ /health/deep — เฉพาะเวลา/สถานะ ไม่มีข้อมูลเหตุการณ์
  const getStatus = () => ({ enabled: cfg.active, intervalMs: cfg.intervalSec * 1000, lastTickAt, lastResult });

  return { check, start, stop, config: cfg, getState: () => state, getStatus };
}

module.exports = {
  loadConfig, evaluate, queryWindow, renderMessage, fmtTime, createChecker, fileStore, normalizeState, freshState,
  OVERLAP_MS, MAX_WINDOW_MS, SEEN_MAX, MAX_SHOWN,
};
