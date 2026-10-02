'use strict';
// แจ้งเตือนเมื่อ traffic ของ AP (Omada) เกิน threshold — ปิดเป็นค่าเริ่มต้น (ไม่ตั้ง threshold = ไม่ทำงาน)
//
// ที่มาของข้อมูล: GET dashboard/traffic-activities → apTrafficActivities (bucket ละ ~5 นาที)
//   ⚠️ ยังไม่ยืนยันกับ controller จริง: ชื่อ field ปริมาณ (tx/rx) และหน่วย — โค้ดสมมติว่าเป็น "bytes ต่อ bucket" และเผื่อชื่อ fallback
//      (ไซต์ที่ probe ไม่มี client/traffic) → แนะนำเปิด OMADA_TRAFFIC_ALERT_DRYRUN=true ก่อน เทียบค่าใน log กับหน้า Omada แล้วค่อยปิด dry-run
//   ใช้เฉพาะ bucket ที่ "ปิดแล้ว" (เวลาเริ่ม + ความกว้าง ≤ ตอนนี้) เพราะ bucket ล่าสุดยังไม่ครบ ค่าจะต่ำเกินจริง
//
// ค่าที่ตั้งผ่าน env (ทั้งหมดเป็น optional; ตั้ง DOWN หรือ UP อย่างน้อยหนึ่งตัวจึงจะเปิดใช้):
//   OMADA_TRAFFIC_ALERT_DOWN_MBPS / _UP_MBPS   threshold (Mbps) ของทิศทางดาวน์โหลด/อัปโหลด — ตัวไหนไม่ตั้ง = ไม่ตรวจทิศทางนั้น
//   OMADA_TRAFFIC_ALERT_SUSTAIN       กี่ bucket ติดกันถึงแจ้ง (ค่าเริ่มต้น 2 ≈ 10 นาที กัน spike)
//   OMADA_TRAFFIC_ALERT_COOLDOWN_MIN  ห่างระหว่าง "การแจ้ง" อย่างน้อยกี่นาที (30) — กันแจ้งรัวเมื่อ traffic แกว่งรอบ threshold
//   OMADA_TRAFFIC_ALERT_INTERVAL_MIN  ตรวจทุกกี่นาที (5)
//   OMADA_TRAFFIC_ALERT_SEVERITY      ระดับที่ส่งเข้า pushToUsers (3 = เฉพาะ ADMIN/IT_STAFF; ≥4 ถึง VIEWER ด้วย)
//   OMADA_TRAFFIC_ALERT_DRYRUN=true   คำนวณ/log อย่างเดียว ไม่ส่งข้อความและไม่เขียน state ลงไฟล์ (เก็บในหน่วยความจำ)
//
// วงจรสถานะ: เกิน threshold ติดกัน N bucket → แจ้ง (active) → ไม่แจ้งซ้ำขณะยังเกิน → ต่ำกว่า 80% ของ threshold ติดกัน N bucket
//   → ส่ง "กลับสู่ปกติ" → เกินอีกครั้งแจ้งใหม่ได้ (ถ้าพ้น cooldown นับจากการแจ้งครั้งก่อน)
// state เก็บใน data/ (อยู่รอดหลัง recreate container) — bucket ที่ประมวลผลแล้วไม่ถูกนับซ้ำเมื่อหน้าต่างที่ดึงมาซ้อนกัน
const fs = require('fs');
const path = require('path');
const { withTimeout } = require('./stats');
const { pickNum, TX_KEYS, RX_KEYS } = require('./stats-detail');

const DEFAULT_BUCKET_SEC = 300;
const RECOVER_RATIO = 0.8;
const FETCH_TIMEOUT_MS = 8000;
const START_DELAY_MS = 60_000;
const DEFAULT_STATE_FILE = path.join(__dirname, '..', 'data', 'omada-traffic-alert.json');

const emptyState = () => ({ active: false, lastAlertAt: null, overStreak: 0, underStreak: 0, lastBucketTime: 0, peak: { down: 0, up: 0 } });

// ── config ────────────────────────────────────────────────────────────────────
function positiveNumber(raw) {
  if (raw === undefined || raw === null || String(raw).trim() === '') return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : NaN;
}
function intInRange(raw, fallback, min, max) {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

// คืน { enabled, downMbps, upMbps, sustain, cooldownMin, intervalMin, severity, dryRun, warnings[] }
function loadConfig(env = process.env) {
  const warnings = [];
  const read = (key) => {
    const v = positiveNumber(env[key]);
    if (Number.isNaN(v)) { warnings.push(`${key}="${env[key]}" ไม่ใช่ตัวเลขที่มากกว่า 0 — ไม่ตรวจทิศทางนี้`); return null; }
    return v;
  };
  const downMbps = read('OMADA_TRAFFIC_ALERT_DOWN_MBPS');
  const upMbps = read('OMADA_TRAFFIC_ALERT_UP_MBPS');
  return {
    enabled: downMbps !== null || upMbps !== null,
    downMbps,
    upMbps,
    sustain: intInRange(env.OMADA_TRAFFIC_ALERT_SUSTAIN, 2, 1, 12),
    cooldownMin: intInRange(env.OMADA_TRAFFIC_ALERT_COOLDOWN_MIN, 30, 1, 1440),
    intervalMin: intInRange(env.OMADA_TRAFFIC_ALERT_INTERVAL_MIN, 5, 1, 60),
    severity: intInRange(env.OMADA_TRAFFIC_ALERT_SEVERITY, 3, 0, 5),
    dryRun: String(env.OMADA_TRAFFIC_ALERT_DRYRUN || '').toLowerCase() === 'true',
    warnings,
  };
}

// ── แปลง response ของ Omada → bucket (Mbps) ────────────────────────────────────────
const mbps = (bytes, bucketSec) => (bytes * 8) / bucketSec / 1e6;

function inferBucketSec(items) {
  const times = items.map((i) => Number(i && i.time)).filter(Number.isFinite).sort((a, b) => a - b);
  let min = Infinity;
  for (let i = 1; i < times.length; i++) { const d = times[i] - times[i - 1]; if (d > 0 && d < min) min = d; }
  return Number.isFinite(min) ? Math.min(Math.max(min, 60), 3600) : DEFAULT_BUCKET_SEC;
}

// คืน { readable, buckets: [{ time, downMbps, upMbps }], bucketSec, unmappedKeys }
//   • bucket ที่มีแค่ "time" = ไม่มี traffic (0) — ไซต์จริงที่ว่างส่งมาแบบนี้
//   • มี field ตัวเลขอื่นแต่ไม่ตรงชื่อที่รู้จักสักชื่อ → readable:false (ห้ามเดาเป็น 0 เพราะจะไม่แจ้งทั้งที่ traffic สูง)
function extractBuckets(trafficActivities, nowSec) {
  const items = Array.isArray(trafficActivities && trafficActivities.apTrafficActivities) ? trafficActivities.apTrafficActivities : [];
  const bucketSec = inferBucketSec(items);
  const buckets = [];
  const unmapped = new Set();
  for (const it of items) {
    if (!it || !Number.isFinite(Number(it.time))) continue;
    const time = Number(it.time);
    if (time + bucketSec > nowSec) continue; // bucket ยังไม่ปิด
    const tx = pickNum(it, TX_KEYS);
    const rx = pickNum(it, RX_KEYS);
    if (tx === null && rx === null) {
      const extra = Object.keys(it).filter((k) => k !== 'time');
      if (extra.length > 0) { extra.forEach((k) => unmapped.add(k)); continue; }
      buckets.push({ time, downMbps: 0, upMbps: 0 });
      continue;
    }
    buckets.push({ time, downMbps: mbps(rx || 0, bucketSec), upMbps: mbps(tx || 0, bucketSec) });
  }
  buckets.sort((a, b) => a.time - b.time);
  const readable = unmapped.size === 0;
  return { readable, buckets, bucketSec, unmappedKeys: [...unmapped].sort().slice(0, 12) };
}

// ── ประเมิน (ฟังก์ชันบริสุทธิ์) ─────────────────────────────────────────────────────
// คืน { state, actions: [{ type: 'alert' | 'recovered' | 'suppressed', ... }] } — ไม่แก้ state เดิม
function evaluate(prevState, buckets, cfg, nowMs) {
  const state = { ...emptyState(), ...prevState, peak: { ...emptyState().peak, ...(prevState && prevState.peak) } };
  const actions = [];
  const cooldownMs = cfg.cooldownMin * 60_000;

  for (const b of buckets) {
    if (b.time <= state.lastBucketTime) continue; // ประมวลผลแล้ว — หน้าต่างที่ดึงซ้อนกันต้องไม่นับซ้ำ
    state.lastBucketTime = b.time;

    const over = (cfg.downMbps !== null && b.downMbps > cfg.downMbps) || (cfg.upMbps !== null && b.upMbps > cfg.upMbps);
    const clear = (cfg.downMbps === null || b.downMbps <= cfg.downMbps * RECOVER_RATIO) && (cfg.upMbps === null || b.upMbps <= cfg.upMbps * RECOVER_RATIO);

    if (over) {
      state.overStreak += 1; state.underStreak = 0;
      state.peak = { down: Math.max(state.peak.down, b.downMbps), up: Math.max(state.peak.up, b.upMbps) };
    } else if (clear) {
      state.underStreak += 1; state.overStreak = 0;
    } else { // ช่วงเทา (80–100% ของ threshold): ไม่นับทั้งเกินและกลับปกติ
      state.overStreak = 0; state.underStreak = 0;
    }

    if (!state.active && state.overStreak >= cfg.sustain) {
      const inCooldown = state.lastAlertAt !== null && nowMs - state.lastAlertAt < cooldownMs;
      if (inCooldown) {
        actions.push({ type: 'suppressed', reason: 'cooldown', retryInMs: cooldownMs - (nowMs - state.lastAlertAt) });
      } else {
        state.active = true;
        state.lastAlertAt = nowMs;
        actions.push({ type: 'alert', peak: { ...state.peak }, buckets: state.overStreak });
      }
    } else if (state.active && state.underStreak >= cfg.sustain) {
      state.active = false;
      const peak = { ...state.peak };
      state.peak = { down: 0, up: 0 };
      actions.push({ type: 'recovered', peak });
    }
    if (!over && !state.active) state.peak = { down: 0, up: 0 };
  }
  return { state, actions };
}

// ── ข้อความ (ตัวเลขล้วน ไม่มี secret) ───────────────────────────────────────────────
// ค่าเล็ก (เช่น threshold 0.001 ตอนทดสอบ) ต้องไม่ถูกปัดเป็น 0.0 — ใช้ทศนิยมตามขนาด
const fmt = (n) => (n >= 100 ? n.toFixed(0) : n >= 1 ? n.toFixed(1) : n.toFixed(3));
function thresholdText(cfg) {
  const parts = [];
  if (cfg.downMbps !== null) parts.push(`ดาวน์โหลด > ${fmt(cfg.downMbps)} Mbps`);
  if (cfg.upMbps !== null) parts.push(`อัปโหลด > ${fmt(cfg.upMbps)} Mbps`);
  return parts.join(' หรือ ');
}
function alertText(cfg, peak, buckets, bucketSec) {
  return [
    '⚠️ Omada traffic สูงกว่าเกณฑ์',
    `สูงสุดช่วงนี้: ดาวน์โหลด ${fmt(peak.down)} Mbps · อัปโหลด ${fmt(peak.up)} Mbps`,
    `เกณฑ์: ${thresholdText(cfg)}`,
    `ต่อเนื่อง ${buckets} ช่วง (~${Math.round((buckets * bucketSec) / 60)} นาที) · วัดจาก traffic รวมของ AP`,
  ].join('\n');
}
function recoveredText(cfg, peak) {
  return [
    '✅ Omada traffic กลับสู่ปกติ',
    `ต่ำกว่า ${Math.round(RECOVER_RATIO * 100)}% ของเกณฑ์ (${thresholdText(cfg)}) ต่อเนื่อง ${cfg.sustain} ช่วง`,
    `ค่าสูงสุดก่อนหน้า: ดาวน์โหลด ${fmt(peak.down)} Mbps · อัปโหลด ${fmt(peak.up)} Mbps`,
  ].join('\n');
}

// ── state file ─────────────────────────────────────────────────────────────────
function fileStore(file = DEFAULT_STATE_FILE, logger = null) {
  return {
    load() {
      try {
        const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!doc || typeof doc !== 'object') return emptyState();
        return {
          active: doc.active === true,
          lastAlertAt: Number.isFinite(doc.lastAlertAt) ? doc.lastAlertAt : null,
          overStreak: Number.isInteger(doc.overStreak) && doc.overStreak >= 0 ? doc.overStreak : 0,
          underStreak: Number.isInteger(doc.underStreak) && doc.underStreak >= 0 ? doc.underStreak : 0,
          lastBucketTime: Number.isFinite(doc.lastBucketTime) ? doc.lastBucketTime : 0,
          peak: { down: Number(doc.peak && doc.peak.down) || 0, up: Number(doc.peak && doc.peak.up) || 0 },
        };
      } catch {
        return emptyState(); // ไม่มีไฟล์/พัง → เริ่มใหม่ (ได้แจ้งซ้ำอย่างมาก 1 ครั้ง ดีกว่าไม่แจ้ง)
      }
    },
    save(state) {
      const tmp = `${file}.tmp`;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(tmp, JSON.stringify(state), 'utf8');
        fs.renameSync(tmp, file);
        return true;
      } catch (err) {
        if (logger) logger.warn(`omada-traffic-alert: บันทึก state ไม่ได้ (${err.code || err.message}) — ใช้ในหน่วยความจำต่อ`);
        try { fs.unlinkSync(tmp); } catch { /* ไม่มี tmp */ }
        return false;
      }
    },
  };
}

// deps: { omada, pusher(text, severity), logger, env, now(), store: { load, save } }
function createChecker({ omada, pusher, logger = console, env = process.env, now = Date.now, store = null } = {}) {
  const cfg = loadConfig(env);
  const st = store || fileStore(DEFAULT_STATE_FILE, logger);
  let state = st.load();
  const warned = new Set();
  const warnOnce = (key, msg) => { if (!warned.has(key)) { warned.add(key); logger.warn(msg); } };
  let timer = null; let startTimer = null; let running = false;

  async function check() {
    if (!cfg.enabled) return { status: 'disabled' };
    const nowMs = now();
    const nowSec = Math.floor(nowMs / 1000);
    const windowSec = (cfg.sustain + 2) * DEFAULT_BUCKET_SEC;

    let data;
    try {
      data = await withTimeout(omada.getTrafficActivities(nowSec - windowSec, nowSec), FETCH_TIMEOUT_MS);
      warned.delete('fetch');
    } catch (err) {
      warnOnce('fetch', `omada-traffic-alert: ดึง traffic ไม่ได้ (${err.code || err.message}) — ข้ามรอบนี้ ไม่แจ้งและไม่เปลี่ยนสถานะ`);
      return { status: 'fetch-failed' };
    }

    const { readable, buckets, bucketSec, unmappedKeys } = extractBuckets(data, nowSec);
    if (!readable) {
      warnOnce('unmapped', `omada-traffic-alert: ตั้ง threshold แล้วแต่อ่านค่า traffic ไม่ได้ — field ที่เจอ: ${unmappedKeys.join(', ')} (ต้องเพิ่มชื่อ field ใน TX_KEYS/RX_KEYS ของ stats-detail.js) ข้ามรอบนี้`);
      return { status: 'unreadable', unmappedKeys };
    }
    warned.delete('unmapped');

    if (cfg.dryRun && buckets.length) {
      const last = buckets[buckets.length - 1];
      logger.info(`omada-traffic-alert[DRYRUN]: bucket ล่าสุด down=${fmt(last.downMbps)} up=${fmt(last.upMbps)} Mbps (เกณฑ์: ${thresholdText(cfg)}; ${buckets.length} bucket ในหน้าต่าง, กว้าง ${bucketSec}s)`);
    }

    const result = evaluate(state, buckets, cfg, nowMs);
    state = result.state;
    // DRYRUN เก็บ state ในหน่วยความจำเท่านั้น — ไม่เขียนไฟล์ ไม่งั้นพอปิด dry-run แล้ว state "active" ที่ค้างจะกันไม่ให้แจ้งครั้งแรกจริง
    if (!cfg.dryRun) st.save(state);

    for (const action of result.actions) {
      if (action.type === 'suppressed') {
        logger.info(`omada-traffic-alert: เกิน threshold แต่อยู่ใน cooldown (เหลือ ~${Math.ceil(action.retryInMs / 60_000)} นาที) — ไม่แจ้ง`);
        continue;
      }
      const text = action.type === 'alert' ? alertText(cfg, action.peak, action.buckets, bucketSec) : recoveredText(cfg, action.peak);
      if (cfg.dryRun) {
        logger.info(`omada-traffic-alert[DRYRUN]: จะส่ง ${action.type} — ${text.split('\n').join(' | ')}`);
        continue;
      }
      try {
        const r = await pusher(text, cfg.severity);
        logger.info(`omada-traffic-alert: ส่ง ${action.type} แล้ว (ผู้รับ ${r && r.recipients !== undefined ? r.recipients : '?'}, สำเร็จ ${r && r.sent !== undefined ? r.sent : '?'})`);
      } catch (err) {
        logger.error(`omada-traffic-alert: ส่ง ${action.type} ไม่สำเร็จ: ${err.message}`);
      }
    }
    return { status: 'ok', actions: result.actions.map((a) => a.type), state };
  }

  // กันรอบซ้อนกัน (ถ้ารอบก่อนยังไม่จบ ข้ามรอบนี้)
  async function safeCheck() {
    if (running) return;
    running = true;
    try { await check(); } catch (err) { logger.error(`omada-traffic-alert: ผิดพลาด: ${err.message}`); } finally { running = false; }
  }

  function start() {
    cfg.warnings.forEach((w) => logger.warn(`omada-traffic-alert: ${w}`));
    if (!cfg.enabled) return () => {};
    logger.info(`omada-traffic-alert: เปิดใช้ (${thresholdText(cfg)}; sustain=${cfg.sustain}, cooldown=${cfg.cooldownMin}m, ทุก ${cfg.intervalMin}m, severity=${cfg.severity}${cfg.dryRun ? ', DRYRUN' : ''})`);
    startTimer = setTimeout(safeCheck, START_DELAY_MS);
    timer = setInterval(safeCheck, cfg.intervalMin * 60_000);
    if (startTimer.unref) startTimer.unref();
    if (timer.unref) timer.unref();
    return stop;
  }
  function stop() {
    if (startTimer) clearTimeout(startTimer);
    if (timer) clearInterval(timer);
    startTimer = null; timer = null;
  }

  return { check, start, stop, config: cfg, getState: () => state };
}

module.exports = { loadConfig, extractBuckets, evaluate, createChecker, fileStore, alertText, recoveredText, emptyState, RECOVER_RATIO };
