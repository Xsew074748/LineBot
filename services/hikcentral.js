'use strict';
require('dotenv').config();
const axios  = require('axios');
const crypto = require('crypto');
const https  = require('https');
const fs     = require('fs');
const logger = require('./logger');
const { createBreaker, envPositiveInt } = require('./circuit-breaker');

// ── HikCentral OpenAPI (artemis) — AK/SK Signature Authentication ─────────────
// อ้างอิง: HikCentral Professional OpenAPI Developer Guide V2.6.1
const BASE_URL   = (process.env.HIKCENTRAL_URL || '').replace(/\/+$/, '');
const APP_KEY    = process.env.HIKCENTRAL_APP_KEY    || '';
const APP_SECRET = process.env.HIKCENTRAL_APP_SECRET || '';

const CA_PATH       = process.env.HIKCENTRAL_CA_CERT_PATH || '';
const SKIP_HOSTNAME = process.env.HIKCENTRAL_TLS_SKIP_HOSTNAME === 'true';

// ── สร้าง HTTPS Agent (ใช้เฉพาะเมื่อ BASE_URL เป็น https) ─────────────────────
// ห้ามใช้ NODE_TLS_REJECT_UNAUTHORIZED=0 เพราะจะปิด TLS verify ทั้ง process
// (รวมถึง LINE API และ Claude API) — ปิดเฉพาะ agent นี้เท่านั้น
function buildHttpsAgent() {
  if (CA_PATH) {
    try {
      const ca = fs.readFileSync(CA_PATH);
      const opts = { ca, rejectUnauthorized: true };
      if (SKIP_HOSTNAME) opts.checkServerIdentity = () => undefined;
      logger.info(
        `hikcentral: TLS โหมด CA cert → ${CA_PATH}` +
        (SKIP_HOSTNAME ? ' (+ skip hostname check)' : '')
      );
      return new https.Agent(opts);
    } catch (err) {
      logger.warn(`hikcentral: โหลด CA cert ล้มเหลว (${CA_PATH}): ${err.message} → fallback dev insecure`);
    }
  }
  return new https.Agent({ rejectUnauthorized: false });
}

// timeout ปรับได้ด้วย HIKCENTRAL_TIMEOUT_MS (ค่าเริ่มต้น 10 วินาที — ใช้ค่าต่ำใน test)
const hikHttp = axios.create({ httpsAgent: buildHttpsAgent(), timeout: envPositiveInt(process.env.HIKCENTRAL_TIMEOUT_MS, 10_000) });

// ── Circuit breaker ของ HikCentral (ตัวเดียวทั้ง server) ──────────────────────────────
// ที่มา: /cameras timeout ~10 วินาทีเป็นช่วงๆ (เคยล้มติดกัน ~26 ครั้ง) ทำให้คำสั่ง summary/cross/status/กล้อง ต้องรอ 10–20 วินาที
// ล้มเหลวติดกัน N ครั้ง (timeout / เครือข่ายขาด / HTTP 5xx) → งดเรียก cooldown แล้วลอง 1 คำขอ ดู services/circuit-breaker.js
// ปรับได้: HIKCENTRAL_BREAKER_THRESHOLD (3), HIKCENTRAL_BREAKER_COOLDOWN_MS (60000) — ไม่ใช้ข้อมูลเก่าแทนตอน breaker เปิด (ตั้งใจ)
const breaker = createBreaker({
  name: 'hikcentral',
  failureThreshold: envPositiveInt(process.env.HIKCENTRAL_BREAKER_THRESHOLD, 3),
  cooldownMs: envPositiveInt(process.env.HIKCENTRAL_BREAKER_COOLDOWN_MS, 60_000),
  logger,
});

function getBreakerState() {
  return breaker.snapshot();
}

// ── AK/SK Signature ────────────────────────────────────────────────────────────
// stringToSign = METHOD\nAccept\nContent-MD5\nContent-Type\nDate\n
//                x-ca-key:AppKey\nx-ca-timestamp:ts\n/path
// header ที่ไม่ได้ส่ง (Content-MD5, Date) ต้องข้ามบรรทัดไปเลย ห้ามใส่บรรทัดว่าง
// signature = Base64(HmacSHA256(stringToSign, AppSecret))
function buildSignedHeaders(method, path, appKey = APP_KEY, appSecret = APP_SECRET) {
  const timestamp   = Date.now().toString();
  const accept      = '*/*';
  const contentType = 'application/json';

  const stringToSign = [
    method.toUpperCase(),
    accept,
    contentType,
    `x-ca-key:${appKey}`,
    `x-ca-timestamp:${timestamp}`,
    path,
  ].join('\n');

  const signature = crypto
    .createHmac('sha256', appSecret)
    .update(stringToSign, 'utf8')
    .digest('base64');

  return {
    Accept:                   accept,
    'Content-Type':           contentType,
    'X-Ca-Key':               appKey,
    'X-Ca-Signature':         signature,
    'X-Ca-Signature-Headers': 'x-ca-key,x-ca-timestamp',
    'X-Ca-Timestamp':         timestamp,
    'X-Ca-Nonce':             crypto.randomUUID(),
  };
}

// ── POST helper — ทุก endpoint ของ artemis ใช้ POST ────────────────────────────
// override: { url, appKey, appSecret, timeoutMs } — ใช้ทดสอบ config ที่ยังไม่บันทึก ไม่ส่ง = ใช้ env
// override (ทดสอบ config ที่ยังไม่บันทึก) ข้าม breaker ทั้งหมด — ไม่ให้การทดสอบเปลี่ยนสถานะของระบบจริง
function hikPost(path, body = {}, override = null) {
  return override ? hikPostRaw(path, body, override) : breaker.execute(() => hikPostRaw(path, body, null));
}

async function hikPostRaw(path, body = {}, override = null) {
  const start = Date.now();
  try {
    const baseUrl = override?.url !== undefined ? override.url.replace(/\/+$/, '') : BASE_URL;
    const resp = await hikHttp.post(`${baseUrl}${path}`, body, {
      headers: buildSignedHeaders('POST', path, override?.appKey ?? APP_KEY, override?.appSecret ?? APP_SECRET),
      ...(override?.timeoutMs ? { timeout: override.timeoutMs } : {}),
    });
    logger.apiCall('HikCentral', path, Date.now() - start);

    const data = resp.data;
    // artemis ตอบ 200 เสมอ ต้องเช็ค code ในเนื้อ response เอง ('0' = สำเร็จ)
    if (data?.code !== undefined && String(data.code) !== '0') {
      throw new Error(`HikCentral API error ${data.code}: ${data.msg || 'unknown'}`);
    }
    return data?.data;
  } catch (err) {
    logger.apiCall('HikCentral', path, Date.now() - start, false);
    throw err;
  }
}

// ── ดึงพื้นที่ (regions) — cache map indexCode → name ไว้ใน memory ────────────
// POST /artemis/api/resource/v1/regions — ใช้แปลง regionIndexCode ตัวเลขเป็นชื่อจริง
const REGION_CACHE_TTL_MS = 10 * 60 * 1000;
const regionCache = { map: null, expireAt: 0 };

async function getRegions(pageSize = 500) {
  const per = Math.min(pageSize, 500);
  const all = [];
  let page  = 1;
  for (;;) {
    const data = await hikPost('/artemis/api/resource/v1/regions', { pageNo: page, pageSize: per });
    const list = data?.list || [];
    all.push(...list);
    const total = Number(data?.total ?? 0);
    if (list.length < per || (total && all.length >= total)) break;
    page += 1;
  }
  return all.map((r) => ({
    indexCode:       r.indexCode || r.regionIndexCode,
    name:            r.name || r.regionName || 'N/A',
    parentIndexCode: r.parentIndexCode || null,
  }));
}

// คืน object { indexCode: name } จาก cache — ถ้าดึงไม่ได้คืน cache เดิม (หรือ {})
async function getRegionMap() {
  if (regionCache.map && Date.now() < regionCache.expireAt) return regionCache.map;
  try {
    const regions = await getRegions();
    const map = {};
    for (const r of regions) {
      if (r.indexCode) map[String(r.indexCode)] = r.name;
    }
    regionCache.map     = map;
    regionCache.expireAt = Date.now() + REGION_CACHE_TTL_MS;
    logger.info(`hikcentral: region map refreshed (${regions.length} regions)`);
  } catch (err) {
    logger.warn(`hikcentral: getRegions ล้มเหลว — ใช้ region map เดิม (${err.message})`);
  }
  return regionCache.map || {};
}

// ── ดึงกล้องทั้งหมด ───────────────────────────────────────────────────────────
// artemis จำกัด pageSize ไม่เกิน 500 — ถ้าขอมากกว่านั้นไล่ดึงทีละหน้าจนครบ
async function getCameras(pageNo = 1, pageSize = 100) {
  const per = Math.min(pageSize, 500);
  const all = [];
  let page  = pageNo;
  while (all.length < pageSize) {
    const data = await hikPost('/artemis/api/resource/v1/cameras', { pageNo: page, pageSize: per });
    const list = data?.list || [];
    all.push(...list);
    const total = Number(data?.total ?? 0);
    if (list.length < per || (total && all.length >= total)) break;
    page += 1;
  }
  const regionMap = await getRegionMap();
  return formatCameras(all.slice(0, pageSize), regionMap);
}

// ── ดึงสถานะกล้องตาม indexCode ────────────────────────────────────────────────
async function getCameraStatus(indexCode) {
  const cam = await hikPost('/artemis/api/resource/v1/cameras/indexCode', { cameraIndexCode: indexCode });
  const online = isOnline(cam);
  return {
    id:     indexCode,
    name:   cam?.cameraName || 'N/A',
    online,
    status: online ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
  };
}

// ── ดึงกล้องตามพื้นที่ (regionIndexCode หรือชื่อ region) ──────────────────────
async function getCamerasByArea(areaId) {
  const data      = await hikPost('/artemis/api/resource/v1/cameras', { pageNo: 1, pageSize: 500 });
  const regionMap = await getRegionMap();
  const list = (data?.list || []).filter((c) =>
    String(c.regionIndexCode) === String(areaId) ||
    (regionMap[String(c.regionIndexCode)] || '') === String(areaId)
  );
  return formatCameras(list, regionMap);
}

// ── ดึง Event ล่าสุด ──────────────────────────────────────────────────────────
async function getEvents(limit = 10) {
  const data = await hikPost('/artemis/api/eventService/v1/eventRecords/page', {
    pageNo: 1,
    pageSize: limit,
  });
  return (data?.list || []).map((e) => ({
    name:     e.eventName || e.srcName || 'N/A',
    type:     e.eventType || 'N/A',
    cameraId: e.srcIndex || e.cameraIndexCode || null,
    time:     e.happenTime ? new Date(e.happenTime).toLocaleString('th-TH') : 'N/A',
  }));
}


// ── Event ตามช่วงเวลา (ใช้กับ /stats/detail) ──────────────────────────────────
// รูปแบบ request ที่ "ยืนยันกับ HikCentral จริงแล้ว" (probe อ่านอย่างเดียว) — ผิดรูปแบบได้ code=2 [... parameter error]:
//   • startTime/endTime บังคับทั้งคู่ เป็น ISO8601 ลงท้าย offset เช่น +00:00 (ลงท้าย Z ไม่ผ่าน)
//   • eventTypes = สตริงรหัสคั่นด้วย "," (array ไม่ผ่าน)
//   • srcType = "camera" และ srcIndexs = สตริง camera index code คั่นด้วย "," (array ไม่ผ่าน; ขาดไม่ได้)
// ยังไม่ยืนยัน: ความหมายของรหัส eventTypes (motion/video loss/tamper) และชื่อ field ใน record
// → ต้องกำหนดรหัสเองผ่าน HIKCENTRAL_EVENT_TYPES (คั่นด้วย ,) ไม่เดาให้
const EVENT_PAGE_SIZE   = 500;
const EVENT_CAM_CHUNK   = 100; // จำนวนกล้องต่อ request (ทดสอบจริงผ่านที่ 68 กล้อง/321 ตัวอักษร; จำกัดไว้กัน URL/body ยาวเกิน)
const EVENT_MAX_REQUESTS = 10; // กันชน — รวมทุก chunk/หน้า
const CAMERA_CODES_TTL_MS = 10 * 60 * 1000;
const isoWithOffset = (ms) => new Date(ms).toISOString().replace(/\.\d+Z$/, '+00:00');

const cameraCodeCache = { codes: null, expireAt: 0 };

// cameraIndexCode ของทุกกล้อง (cache 10 นาที — ถ้าดึงใหม่ไม่ได้ใช้ของเดิม ไม่มีเลยค่อย throw)
async function getCameraIndexCodes() {
  if (cameraCodeCache.codes && Date.now() < cameraCodeCache.expireAt) return cameraCodeCache.codes;
  try {
    const codes = [];
    for (let page = 1; page <= 20; page++) {
      const data = await hikPost('/artemis/api/resource/v1/cameras', { pageNo: page, pageSize: 500 });
      const list = data?.list || [];
      for (const c of list) { const id = c.cameraIndexCode || c.indexCode; if (id) codes.push(String(id)); }
      const total = Number(data?.total ?? 0);
      if (list.length < 500 || (total && codes.length >= total)) break;
    }
    cameraCodeCache.codes = codes;
    cameraCodeCache.expireAt = Date.now() + CAMERA_CODES_TTL_MS;
  } catch (err) {
    if (!cameraCodeCache.codes) throw err;
    logger.warn(`hikcentral: ดึงรายชื่อกล้องไม่ได้ ใช้รายการเดิม (${err.message})`);
  }
  return cameraCodeCache.codes;
}

// eventTypes: array ของรหัส (จำนวนเต็ม) — แปลงเป็นสตริงคั่น "," ตอนส่ง
async function getEventRecords({ startMs, endMs, eventTypes }) {
  const codes = await getCameraIndexCodes();
  const records = [];
  let truncated = false;
  let requests = 0;
  const typesCsv = eventTypes.join(',');

  outer:
  for (let i = 0; i < codes.length; i += EVENT_CAM_CHUNK) {
    const srcIndexs = codes.slice(i, i + EVENT_CAM_CHUNK).join(',');
    for (let page = 1; ; page++) {
      if (requests >= EVENT_MAX_REQUESTS) { truncated = true; break outer; }
      requests++;
      const data = await hikPost('/artemis/api/eventService/v1/eventRecords/page', {
        pageNo: page, pageSize: EVENT_PAGE_SIZE,
        startTime: isoWithOffset(startMs), endTime: isoWithOffset(endMs),
        eventTypes: typesCsv, srcType: 'camera', srcIndexs,
      });
      const list = data?.list || [];
      records.push(...list);
      const total = Number(data?.total ?? 0);
      const got = (page - 1) * EVENT_PAGE_SIZE + list.length;
      if (list.length < EVENT_PAGE_SIZE || (total && got >= total)) break;
    }
  }
  return {
    records: records.map((e) => ({
      name:       e.eventName || e.eventTypeName || e.srcName || 'N/A',
      type:       e.eventType ?? null,
      cameraId:   e.srcIndex || e.cameraIndexCode || null,
      cameraName: e.srcName || e.cameraName || null,
    })),
    truncated,
  };
}

// ── สถานะ online — artemis ใช้ status: 1 = online, 0 = offline ────────────────
function isOnline(cam) {
  if (!cam) return false;
  if (cam.online !== undefined) return cam.online === true;
  return Number(cam.status) === 1;
}

// ── แปลงข้อมูลกล้องให้อ่านง่าย ────────────────────────────────────────────────
// regionMap: { indexCode: name } — แปลง regionIndexCode ตัวเลขเป็นชื่อพื้นที่จริง
function formatCameras(list, regionMap = {}) {
  return list.map((cam) => {
    const online = isOnline(cam);
    const regionName = regionMap[String(cam.regionIndexCode)] || null;
    return {
      id:           cam.cameraIndexCode || cam.indexCode || cam.id,
      name:         cam.cameraName || cam.name || 'N/A',
      location:     regionName || cam.areaName || cam.regionIndexCode || 'N/A',
      status:       online ? '🟢 ออนไลน์' : '🔴 ออฟไลน์',
      online,
      offlineSince: null, // artemis camera list ไม่มี offlineTime
      duration:     '',
    };
  });
}

// ── Health Check — ยิงขอกล้อง 1 ตัวเพื่อทดสอบ signature + การเชื่อมต่อ ────────
async function healthCheck() {
  try {
    await hikPost('/artemis/api/resource/v1/cameras', { pageNo: 1, pageSize: 1 });
    return { ok: true, name: 'HikCentral' };
  } catch (err) {
    return { ok: false, name: 'HikCentral', error: err.message };
  }
}

// ทดสอบ url/appKey/appSecret ที่ส่งมา — ขอ regions 1 แถว (endpoint เบาที่สุด)
async function checkAuth(cfg) {
  await hikPost('/artemis/api/resource/v1/regions', { pageNo: 1, pageSize: 1 }, { timeoutMs: 5000, ...cfg });
}

module.exports = {
  getBreakerState,
  checkAuth,
  getCameras,
  getCameraStatus,
  getCamerasByArea,
  getRegions,
  getEvents,
  getEventRecords,
  healthCheck,
};
