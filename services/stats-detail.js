'use strict';
// ข้อมูลละเอียดสำหรับ endpoint /stats/detail — NetGuard Manager poll ทุก 5 นาที แล้วเก็บลง DB ทำกราฟ
// pure function รับ dependency เข้ามา (เหมือน services/stats.js) เพื่อ unit test ได้โดยไม่ยิงระบบจริง
//
// หลักการ: แต่ละ section (omada.clients / omada.overview / omada.traffic / hikcentral.events) ล้มเหลวแยกกัน —
// section ที่พังเป็น null และบันทึกชื่อไว้ใน failed[] ส่วนอื่นยังคืนปกติ (partial: true)

const { withTimeout } = require('./stats');

const DEFAULT_TIMEOUT_MS = 8000;
const HIK_TIMEOUT_MS     = 12000; // eventRecords ไล่หลายหน้า
const MAX_WINDOW_SEC     = 3600;  // หน้าต่างย้อนหลังสูงสุดต่อรอบ (Manager ดับนานก็ไม่ดึงยาวเกิน 1 ชม.)
const DEFAULT_WINDOW_SEC = 300;
const TOP_N              = 10;
const TOP_CAMERAS_N      = 5;

// ── ชื่อ field ที่ "ยังไม่ยืนยัน" กับระบบจริง — ลองตามลำดับ ใช้ตัวแรกที่เป็นตัวเลข ──────
const TX_KEYS     = ['tx', 'txBytes', 'upload', 'up', 'trafficUp', 'txTraffic', 'uploadBytes'];
const RX_KEYS     = ['rx', 'rxBytes', 'download', 'down', 'trafficDown', 'rxTraffic', 'downloadBytes'];
const CLIENT_DOWN = ['trafficDown', 'downBytes', 'rxBytes', 'download', 'down'];
const CLIENT_UP   = ['trafficUp', 'upBytes', 'txBytes', 'upload', 'up'];

function pickNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined || typeof v === 'boolean' || v === '') continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

// รวม traffic ของ bucket ทั้งหมด
// - ทุก bucket มีแค่ "time" → ถือเป็น 0 (ไซต์จริงที่ไม่มี traffic ไม่ส่ง field อื่นมาเลย)
// - มี field ตัวเลขอื่นแต่ไม่ตรงชื่อที่รู้จัก → tx/rx = null และคืนชื่อ field ใน unmapped (ใช้วินิจฉัย ไม่มีค่า)
function sumTraffic(items) {
  const list = Array.isArray(items) ? items : [];
  let tx = 0; let rx = 0; let matched = false;
  const extra = new Set();
  for (const it of list) {
    if (!it || typeof it !== 'object') continue;
    const t = pickNum(it, TX_KEYS);
    const r = pickNum(it, RX_KEYS);
    if (t !== null) { tx += t; matched = true; }
    if (r !== null) { rx += r; matched = true; }
    for (const k of Object.keys(it)) if (k !== 'time') extra.add(k);
  }
  if (matched) return { tx, rx, unmapped: [] };
  if (extra.size === 0) return { tx: 0, rx: 0, unmapped: [] };
  return { tx: null, rx: null, unmapped: [...extra].sort().slice(0, 12) };
}

function normalizeClients(rows) {
  return (Array.isArray(rows) ? rows : []).map((c) => {
    const down = pickNum(c, CLIENT_DOWN);
    const up   = pickNum(c, CLIENT_UP);
    return {
      mac:  c.mac || null,
      name: c.name || c.hostName || c.mac || 'N/A',
      ap:   c.apName || null,
      wireless: !!c.wireless,
      down, up,
      total: (down || 0) + (up || 0),
    };
  });
}

// ค่าสะสมต่อ client (ตั้งแต่เชื่อมต่อ) — top N ตามยอดรวม ไม่เอาตัวที่ไม่มี traffic
function topClients(rows, n = TOP_N) {
  return normalizeClients(rows)
    .filter((c) => c.total > 0)
    .sort((a, b) => b.total - a.total)
    .slice(0, n)
    .map(({ mac, name, ap, wireless, down, up }) => ({ mac, name, ap, wireless, down: down || 0, up: up || 0 }));
}

function summarizeClientStat(stat) {
  if (!stat || typeof stat !== 'object') return null;
  const n = (k) => (Number.isFinite(Number(stat[k])) ? Number(stat[k]) : null);
  return {
    total: n('total'), wireless: n('wireless'), wired: n('wired'),
    num2g: n('num2g'), num5g: n('num5g'), num6g: n('num6g'), guest: n('numGuest'),
  };
}

function summarizeOverview(o) {
  if (!o || typeof o !== 'object') return null;
  const n = (k) => (Number.isFinite(Number(o[k])) ? Number(o[k]) : null);
  return {
    totalPorts: n('totalPorts'), availablePorts: n('availablePorts'), powerConsumption: n('powerConsumption'),
  };
}

// ── Hik event: แยกหมวดจากชื่อ event (ยังไม่ยืนยันรหัสชนิดจริง) ───────────────────────
function classifyEvent(rec) {
  const text = `${rec?.name || ''}`.toLowerCase();
  if (/motion|เคลื่อนไหว|movement/.test(text)) return 'motion';
  if (/video\s*loss|signal\s*loss|สัญญาณ.*หาย|loss/.test(text)) return 'videoLoss';
  if (/tamper|occlu|block|cover|บัง|ขัดขวาง/.test(text)) return 'tamper';
  return 'other';
}

function summarizeEvents(records, truncated) {
  const counts = { total: 0, motion: 0, videoLoss: 0, tamper: 0, other: 0 };
  const byCam = new Map();
  for (const r of records) {
    counts.total++;
    counts[classifyEvent(r)]++;
    const id = r.cameraId || r.cameraName;
    if (!id) continue;
    const cur = byCam.get(id) || { id, name: r.cameraName || id, count: 0 };
    cur.count++;
    byCam.set(id, cur);
  }
  const topCameras = [...byCam.values()].sort((a, b) => b.count - a.count).slice(0, TOP_CAMERAS_N);
  return { events: { ...counts, truncated: !!truncated }, topCameras };
}

// HIKCENTRAL_EVENT_TYPES="131330,131331" → [131330, 131331] (จำนวนเต็มบวก ไม่เกิน 50 ตัว)
function parseEventTypes(raw) {
  return String(raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^\d{1,12}$/.test(s))
    .map(Number)
    .slice(0, 50);
}

function resolveWindow(since, nowSec) {
  let s = Number(since);
  if (!Number.isFinite(s) || s <= 0 || s >= nowSec) s = nowSec - DEFAULT_WINDOW_SEC;
  s = Math.max(s, nowSec - MAX_WINDOW_SEC);
  s = Math.floor(s);
  return { sinceSec: s, windowSec: Math.max(1, nowSec - s) };
}

// deps:
//   monitorKeys — monitor ที่ enabled; omada / hikcentral — service module หรือ null
//   since       — Unix วินาที (รอบก่อนหน้าที่ traffic ของ Omada ดึงสำเร็จ) = ต้นหน้าต่าง traffic
//   eventsSince — เหมือนกันแต่สำหรับ event ของ HikCentral (ไม่ส่ง = ใช้ since) — แยกกันเพื่อให้ฝั่งหนึ่งพัง
//                 แล้วอีกฝั่งไม่ต้องดึงหน้าต่างซ้ำ/นับซ้ำ
//   eventTypes  — array รหัสชนิด event ของ HikCentral (ว่าง = ไม่ดึง event และบอก eventsUnavailable)
//   now         — ฉีดเวลาได้เพื่อ test (Unix วินาที)
async function buildDetail({
  monitorKeys = [], omada = null, hikcentral = null, since = null, eventsSince = null, eventTypes = [],
  now = Math.floor(Date.now() / 1000), timeoutMs = DEFAULT_TIMEOUT_MS, hikTimeoutMs = HIK_TIMEOUT_MS,
} = {}) {
  const { sinceSec, windowSec } = resolveWindow(since, now);
  const ev = resolveWindow(eventsSince ?? since, now);
  const detail = { ok: true, timestamp: new Date(now * 1000).toISOString(), monitors: monitorKeys, windowSec, sinceSec };
  const failed = new Set();

  if (omada) {
    const [clientsR, overviewR, trafficR] = await Promise.allSettled([
      withTimeout(omada.getClientOverview(), timeoutMs),
      withTimeout(omada.getDashboardOverview(), timeoutMs),
      withTimeout(omada.getTrafficActivities(sinceSec, now), timeoutMs),
    ]);
    const o = { clients: null, topClients: [], overview: null, traffic: null };

    if (clientsR.status === 'fulfilled') {
      o.clients    = summarizeClientStat(clientsR.value.stat);
      o.topClients = topClients(clientsR.value.clients);
    } else failed.add('omada');

    if (overviewR.status === 'fulfilled') o.overview = summarizeOverview(overviewR.value);
    else failed.add('omada');

    if (trafficR.status === 'fulfilled') {
      const v = trafficR.value || {};
      const ap = sumTraffic(v.apTrafficActivities);
      const sw = sumTraffic(v.switchTrafficActivities);
      o.traffic = {
        apTx: ap.tx, apRx: ap.rx, swTx: sw.tx, swRx: sw.rx,
        unmapped: [...new Set([...ap.unmapped, ...sw.unmapped])],
      };
    } else failed.add('omada');

    detail.omada = o;
  }

  if (hikcentral) {
    const h = { events: null, topCameras: [] };
    if (!eventTypes.length) {
      h.eventsUnavailable = 'event-types-not-configured';
    } else {
      try {
        const r = await withTimeout(
          hikcentral.getEventRecords({ startMs: ev.sinceSec * 1000, endMs: now * 1000, eventTypes }),
          hikTimeoutMs);
        Object.assign(h, summarizeEvents(r.records, r.truncated), { windowSec: ev.windowSec });
      } catch (err) {
        failed.add('hikcentral');
        h.eventsUnavailable = 'fetch-failed';
      }
    }
    detail.hikcentral = h;
  }

  if (failed.size > 0) { detail.partial = true; detail.failed = [...failed]; }
  return detail;
}

module.exports = {
  buildDetail, sumTraffic, topClients, normalizeClients, summarizeClientStat, summarizeOverview,
  classifyEvent, summarizeEvents, parseEventTypes, resolveWindow, pickNum,
};
