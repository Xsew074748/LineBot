'use strict';
require('dotenv').config();

const express    = require('express');
const crypto     = require('crypto');
const rateLimit  = require('express-rate-limit');
const line       = require('@line/bot-sdk');

const path      = require('path');
const config    = require('./config');
const logger    = require('./services/logger');
const auth      = require('./services/auth');
const fmt       = require('./services/formatter');
const ai        = require('./services/ai');
const validator = require('./services/validator');
const { correlate } = require('./services/correlate');

const setupAuth   = require('./middleware/setupAuth');
const setupRouter = require('./routes/setup');
const configRouter = require('./routes/config');

// ── โหลด Monitor Services ที่ enabled เท่านั้น ───────────────────────────────
const enabledMonitors = config.getEnabledMonitors();
const zabbix     = enabledMonitors.zabbix     ? require('./services/zabbix')     : null;
const omada      = enabledMonitors.omada      ? require('./services/omada')      : null;
const hikcentral = enabledMonitors.hikcentral ? require('./services/hikcentral') : null;

logger.info('Monitors loaded', { enabled: Object.keys(enabledMonitors) });

// ── LINE Client ────────────────────────────────────────────────────────────────
const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
});

// ── Express App ────────────────────────────────────────────────────────────────
const app = express();
app.set('trust proxy', 1);

// Rate limit ระดับ IP (ป้องกัน webhook flood)
app.use('/webhook', rateLimit({ windowMs: 60_000, max: 100, standardHeaders: true }));

// ── Setup / Settings UI (LAN only) ───────────────────────────────────────────
app.use('/public', express.static(path.join(__dirname, 'public')));
app.use('/setup', setupAuth.lanOnly, setupRouter);
app.get('/settings', setupAuth.lanOnly, setupAuth.requireLogin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'settings.html'));
});
app.use('/api/config', setupAuth.lanOnly, setupAuth.requireLogin, express.json(), configRouter);

// Rate limit ระดับ User (จัดการใน handler)
const userCallCount = new Map(); // userId → { count, resetAt }

// LINE Profile cache (display name) — TTL 1 ชั่วโมง
const profileCache = new Map(); // userId → { name, expireAt }
const PROFILE_TTL  = 60 * 60 * 1000;

async function getDisplayName(userId) {
  const cached = profileCache.get(userId);
  if (cached && Date.now() < cached.expireAt) return cached.name;
  try {
    const profile = await lineClient.getProfile(userId);
    const name = profile.displayName || (userId.slice(0, 10) + '…');
    profileCache.set(userId, { name, expireAt: Date.now() + PROFILE_TTL });
    return name;
  } catch {
    return userId.slice(0, 10) + '…';
  }
}

// Camera summary cache (ใช้กับคำสั่ง "กล้อง" — ดึงทุก monitor)
const CAMERA_CACHE_TTL_MS = 2 * 60 * 1000;
const cameraCache = { data: null, expireAt: 0 };

// Offline camera background cache (ใช้กับ "กล้องดับ" — อัปเดตโดย poller)
const OFFLINE_CAM_POLL_MS = 90_000; // 90 วินาที
const offlineCamCache = { raw: null, refreshedAt: 0 };

// Per-user context สำหรับ on-demand AI analysis (TTL 10 นาที)
const CONTEXT_TTL_MS = 10 * 60 * 1000;
const userLastCameraCtx  = new Map(); // userId → { text, setAt }
const userLastAlertCtx   = new Map(); // userId → { problems, setAt }
const userLastHostCtx    = new Map(); // userId → { text, setAt }
const userLastWifiCtx    = new Map(); // userId → { text, setAt }
const userLastSummaryCtx = new Map(); // userId → { text, setAt }
const userLastCorrCtx    = new Map(); // userId → { groups, setAt }

function checkUserRateLimit(userId) {
  const limit = auth.isPending(userId) ? config.PENDING_RATE_LIMIT : config.RATE_LIMIT;
  const now   = Date.now();
  const entry = userCallCount.get(userId) || { count: 0, resetAt: now + limit.windowMs };
  if (now > entry.resetAt) {
    userCallCount.set(userId, { count: 1, resetAt: now + limit.windowMs });
    return true;
  }
  entry.count++;
  userCallCount.set(userId, entry);
  return entry.count <= limit.perUser;
}

// ── AI quota wrapper — ตรวจสอบสิทธิ์ + quota ก่อน call AI ─────────────────────
async function withAI(userId, replyToken, aiCall) {
  const check = auth.canUseAI(userId);
  if (!check.ok) {
    if (check.reason === 'role') {
      return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้งาน AI (ต้องการ IT_STAFF ขึ้นไป)'));
    }
    return reply(replyToken, fmt.buildError(
      `ใช้ AI ครบโควต้าวันนี้แล้ว (${check.used}/${check.limit} ครั้ง) — รีเซ็ตพรุ่งนี้`
    ));
  }
  const result = await aiCall();
  auth.incrementAIUsage(userId);
  return result;
}

// ── Verify LINE Signature ──────────────────────────────────────────────────────
// ตรวจสอบ HMAC SHA256 ก่อนทุก webhook เพื่อยืนยันว่ามาจาก LINE จริง
function verifyLineSignature(body, signature) {
  try {
    if (!signature) return false;
    const expected = crypto
      .createHmac('sha256', process.env.LINE_CHANNEL_SECRET)
      .update(body)
      .digest('base64');
    const sigBuf = Buffer.from(signature);
    const expBuf = Buffer.from(expected);
    // timingSafeEqual บังคับให้ทั้งสอง buffer ยาวเท่ากัน — ตรวจก่อนเรียกเสมอ
    if (sigBuf.length !== expBuf.length) return false;
    return crypto.timingSafeEqual(sigBuf, expBuf);
  } catch {
    return false;
  }
}

// ── /health endpoint ───────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ status: 'ok', service: 'IT Monitor Bot', monitorsLoaded: Object.keys(enabledMonitors) });
});

// ── /webhook endpoint ──────────────────────────────────────────────────────────
// รับ raw body ก่อน parse เพราะต้องใช้ verify signature
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig  = req.headers['x-line-signature'] || '';
  const body = req.body;

  // ตอบ 200 ทันทีก่อน เพื่อป้องกัน LINE Timeout (5 วินาที)
  res.sendStatus(200);

  // ตรวจสอบ Signature
  if (!verifyLineSignature(body, sig)) {
    logger.warn('webhook: Invalid LINE signature — rejected');
    return;
  }

  let events;
  try {
    events = JSON.parse(body.toString()).events || [];
  } catch {
    logger.error('webhook: JSON parse failed');
    return;
  }

  // ประมวลผลทุก event พร้อมกัน
  await Promise.allSettled(events.map(handleEvent));
});

// ── /zabbix-webhook endpoint (Auto Alert จาก Zabbix Webhook Media Type) ────────
// Zabbix ต้องส่ง header  x-zabbix-secret: <ZABBIX_WEBHOOK_SECRET>
// ตั้งได้ที่ Zabbix > Alerts > Media types > Webhook > Parameters
//   หรือ Actions > Operations > Message > (custom HTTP header)
app.post('/zabbix-webhook', express.json({ limit: '10kb' }), async (req, res) => {
  const secret = process.env.ZABBIX_WEBHOOK_SECRET;
  // timingSafeEqual บังคับให้ทั้งสอง buffer ยาวเท่ากัน — ตรวจก่อนเรียกเสมอ
  const given    = Buffer.from(String(req.headers['x-zabbix-secret'] || ''));
  const expected = Buffer.from(secret || '');
  if (!secret || given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.sendStatus(200);
  try {
    await handleZabbixPush(req.body);
  } catch (err) {
    logger.error('zabbix-webhook: error', err);
  }
});

// ── จัดการ LINE Event ─────────────────────────────────────────────────────────
async function handleEvent(event) {
  if (event.source?.type !== 'user') return;

  // Postback (ปุ่ม 🤖 ข้าง device) — แยก handler
  if (event.type === 'postback') return handlePostback(event);

  // รองรับเฉพาะ text message
  if (event.type !== 'message') return;

  const userId    = event.source.userId;
  const replyToken = event.replyToken;
  const rawText   = validator.sanitizeText(event.message.text || '');
  const text      = rawText.toLowerCase().trim();

  // Timestamp freshness check (ป้องกัน Replay Attack)
  if (!validator.isTimestampFresh(event.timestamp)) {
    logger.warn(`webhook: stale event from ${userId} (age=${Date.now() - event.timestamp}ms)`);
    return;
  }

  logger.message(userId, rawText);

  // Auto-register user ใหม่เป็น PENDING (ถ้ายังไม่มีในระบบ)
  auth.registerPending(userId);

  // Rate limit ต่อ User (pending ใช้ limit เข้มงวดกว่า)
  if (!checkUserRateLimit(userId)) {
    return reply(replyToken, fmt.buildError('คุณส่งคำสั่งเร็วเกินไป กรุณารอ 1 นาทีแล้วลองใหม่'));
  }

  // "myid" — ทุก user ใช้ได้ แม้แต่ pending (ต้องไว้ก่อน pending block)
  if (text === 'myid') {
    const name = await getDisplayName(userId);
    const role = auth.getUserRole(userId);
    return reply(replyToken, fmt.buildMyId(userId, name, role));
  }

  // Block pending user — ตอบข้อความคงที่ ไม่เรียก AI
  if (auth.isPending(userId)) {
    logger.audit(userId, 'PENDING_BLOCKED', rawText.slice(0, 80));
    return reply(replyToken, fmt.buildAiResponse(
      '⏳ ระบบสำหรับเจ้าหน้าที่ IT เท่านั้น\n\nกรุณารอ admin อนุมัติก่อนใช้งาน\n\nพิมพ์ "myid" เพื่อดู ID ของคุณ'
    ));
  }

  try {
    await route(text, rawText, userId, replyToken);
  } catch (err) {
    logger.error(`handleEvent: userId=${userId}`, err);
    await reply(replyToken, fmt.buildError('เกิดข้อผิดพลาดที่ไม่คาดคิด'));
  }
}

// ── Postback Handler (ปุ่ม 🤖 — data = "analyze:{type}:{name}:{ip}") ──────────
async function handlePostback(event) {
  const userId     = event.source.userId;
  const replyToken = event.replyToken;
  const data       = String(event.postback?.data || '');

  if (!validator.isTimestampFresh(event.timestamp)) {
    logger.warn(`postback: stale event from ${userId}`);
    return;
  }

  logger.message(userId, `[postback] ${data}`);
  auth.registerPending(userId);

  if (!checkUserRateLimit(userId)) {
    return reply(replyToken, fmt.buildError('คุณส่งคำสั่งเร็วเกินไป กรุณารอ 1 นาทีแล้วลองใหม่'));
  }
  if (auth.isPending(userId)) {
    logger.audit(userId, 'PENDING_BLOCKED', `[postback] ${data.slice(0, 80)}`);
    return reply(replyToken, fmt.buildAiResponse(
      '⏳ ระบบสำหรับเจ้าหน้าที่ IT เท่านั้น\n\nกรุณารอ admin อนุมัติก่อนใช้งาน\n\nพิมพ์ "myid" เพื่อดู ID ของคุณ'
    ));
  }

  try {
    if (data.startsWith('analyze:')) return await handleAnalyze(data, userId, replyToken);
  } catch (err) {
    logger.error(`handlePostback: userId=${userId}`, err);
    await reply(replyToken, fmt.buildError('เกิดข้อผิดพลาดที่ไม่คาดคิด'));
  }
}

// ── AI วิเคราะห์รายอุปกรณ์ 2 layer — Layer 1 ตัว device, Layer 2 อุปกรณ์รอบข้าง ─
async function handleAnalyze(data, userId, replyToken) {
  return withAI(userId, replyToken, async () => {
    // data = "analyze:{type}:{name}:{ip}" — name อาจมี ":" จึงตัด segment แรก/สุดท้ายออก
    const parts = data.split(':');
    const type  = parts[1] || '';
    const rawIp = parts.length > 3 ? parts[parts.length - 1] : '-';
    const name  = parts.slice(2, parts.length > 3 ? -1 : undefined).join(':') || '-';
    const ip    = rawIp && rawIp !== '-' && rawIp !== 'N/A' ? rawIp : null;

    const ctx = await gatherAnalyzeContext(type, name, ip);

    const prompt = `คุณเป็น Network Engineer วิเคราะห์ปัญหาของ ${name} (${type})${ip ? ` IP ${ip}` : ''}
สถานะ: ${ctx.status}

ข้อมูลอุปกรณ์ในเครือข่ายเดียวกัน:
AP ที่เกี่ยวข้อง: ${ctx.apContext}
กล้องที่เกี่ยวข้อง: ${ctx.cameraContext}

วิเคราะห์สาเหตุและแนะนำการแก้ไขเป็นภาษาไทย
ถ้าหลายอุปกรณ์มีปัญหาพร้อมกัน ให้ระบุว่าน่าจะเป็นปัญหาระดับ network/switch`;

    // 800 tokens — วิเคราะห์รายอุปกรณ์มี context 2 layer คำตอบยาวกว่า chat ปกติ (500)
    const analysis = await ai.chat(prompt, null, 800);
    return reply(replyToken, fmt.buildAiResponse(analysis));
  });
}

// เทียบ /24 subnet เดียวกัน เช่น 192.168.1.10 กับ 192.168.1.99
function sameSubnet(a, b) {
  if (!a || !b) return false;
  const pa = String(a).split('.');
  const pb = String(b).split('.');
  return pa.length === 4 && pb.length === 4 &&
    pa.slice(0, 3).join('.') === pb.slice(0, 3).join('.');
}

const camIp      = (c) => c.ip || c.interfaces?.[0]?.ip || null;
const apHasIssue = (a) => a.isProblem === true || a.status === 'down';

async function gatherAnalyzeContext(type, name, ip) {
  // Layer 2: ดึง AP (Omada) + กล้อง (HikCentral/Zabbix) พร้อมกัน — ตัวที่ fail ข้าม
  const [apsR, camsR] = await Promise.allSettled([
    omada ? omada.getAPs() : Promise.resolve([]),
    getCamerasWithCache(),
  ]);
  const aps  = apsR.status  === 'fulfilled' ? (apsR.value  || []) : [];
  const cams = camsR.status === 'fulfilled' ? (camsR.value || []) : [];

  const apLine  = (a) => `${a.name} (${a.ip || '-'}) ${apHasIssue(a) ? 'down' : 'up'}`;
  const camLine = (c) => `${c.name}${camIp(c) ? ` (${camIp(c)})` : ''} ${isCamOnline(c) ? 'ออนไลน์' : 'ออฟไลน์'}`;
  const fmtList = (arr, mapFn, max = 10) => arr.length
    ? arr.slice(0, max).map(mapFn).join(', ') + (arr.length > max ? ` … และอีก ${arr.length - max}` : '')
    : 'ไม่พบ';

  let status        = 'ไม่ทราบ';
  let apContext     = 'ไม่พบข้อมูล';
  let cameraContext = 'ไม่พบข้อมูล';

  if (type === 'camera') {
    const self = cams.find((c) => String(c.name) === name);
    if (self) status = self.status || (isCamOnline(self) ? 'ออนไลน์' : 'ออฟไลน์');

    // AP ที่ IP ใกล้เคียง (same /24) — ไม่รู้ IP ให้ดู AP ที่มีปัญหาแทน
    const nearAPs = ip ? aps.filter((a) => sameSubnet(a.ip, ip)) : aps.filter(apHasIssue);
    apContext = ip
      ? `subnet เดียวกัน: ${fmtList(nearAPs, apLine)}`
      : `AP ที่มีปัญหา: ${fmtList(nearAPs, apLine)}`;

    // กล้องอื่นในไซต์เดียวกัน
    const site      = getCameraSite(name);
    const siteCams  = cams.filter((c) => String(c.name) !== name && getCameraSite(c.name) === site);
    const offInSite = siteCams.filter((c) => !isCamOnline(c));
    cameraContext = `ไซต์ ${site} มี ${siteCams.length} ตัว ออฟไลน์ ${offInSite.length} ตัว — ${fmtList(offInSite, camLine, 8)}`;

  } else if (type === 'ap') {
    const self = aps.find((a) => String(a.name) === name);
    if (self) status = apHasIssue(self) ? 'down/มีปัญหา' : 'up';

    // AP อื่นที่มีปัญหา
    const problemAPs = aps.filter((a) => String(a.name) !== name && apHasIssue(a));
    apContext = `AP อื่นที่มีปัญหา ${problemAPs.length} ตัว: ${fmtList(problemAPs, apLine)}`;

    // กล้องใน subnet เดียวกัน
    const nearCams = ip ? cams.filter((c) => sameSubnet(camIp(c), ip)) : [];
    const offNear  = nearCams.filter((c) => !isCamOnline(c));
    cameraContext = nearCams.length
      ? `subnet เดียวกัน ${nearCams.length} ตัว ออฟไลน์ ${offNear.length} ตัว — ${fmtList(offNear, camLine, 8)}`
      : 'ไม่พบกล้องใน subnet เดียวกัน';

  } else {
    // host / alert — สถานะจาก Zabbix + อุปกรณ์รอบข้างทั้ง AP และกล้อง
    if (zabbix) {
      try {
        const hosts = await zabbix.getHosts(200);
        const self  = hosts.find((h) => String(h.name) === name);
        if (self) status = self.status || 'ไม่ทราบ';
      } catch { /* ใช้ค่า default */ }
    }
    const nearAPs    = ip ? aps.filter((a) => sameSubnet(a.ip, ip)) : [];
    const problemAPs = aps.filter(apHasIssue);
    apContext = [
      nearAPs.length    ? `subnet เดียวกัน: ${fmtList(nearAPs, apLine, 8)}`  : null,
      problemAPs.length ? `มีปัญหา: ${fmtList(problemAPs, apLine, 8)}`       : null,
    ].filter(Boolean).join(' | ') || 'ไม่พบ AP ที่เกี่ยวข้อง';

    const nearCams = ip ? cams.filter((c) => sameSubnet(camIp(c), ip)) : [];
    const offCams  = cams.filter((c) => !isCamOnline(c));
    cameraContext = [
      nearCams.length ? `subnet เดียวกัน: ${fmtList(nearCams, camLine, 8)}`               : null,
      offCams.length  ? `ออฟไลน์ทั้งหมด ${offCams.length} ตัว: ${fmtList(offCams, camLine, 6)}` : null,
    ].filter(Boolean).join(' | ') || 'ไม่พบกล้องที่เกี่ยวข้อง';
  }

  return { status, apContext, cameraContext };
}

// ── Command Router ────────────────────────────────────────────────────────────
// Fuzzy match: หา key ที่ตรงกับคำที่พิมพ์ (รองรับ partial match)
const COMMAND_MAP = {
  help:      ['help', 'ช่วยเหลือ', 'เมนู', 'menu', '?', 'คำสั่ง'],
  alert:     ['alert', 'alerts', 'แจ้งเตือน', 'การแจ้งเตือน', 'problem', 'problems'],
  host:      ['host', 'hosts', 'เครื่อง', 'เซิร์ฟเวอร์', 'server', 'servers'],
  camera:    ['กล้อง', 'camera', 'cameras', 'cctv', 'nvr', 'ip camera', 'ipcam'],
  cameraOff: ['กล้องดับ', 'camera offline', 'กล้องออฟไลน์'],
  wifi:      ['wifi', 'wi-fi', 'ap', 'wireless', 'ไวไฟ', 'access point', 'wlan'],
  client:    ['client', 'clients', 'ลูกค้า', 'จำนวน client'],
  summary:   ['ทั้งหมด', 'all', 'สรุป', 'summary', 'overview', 'dashboard'],
  status:    ['status', 'สถานะระบบ', 'monitor status'],
  listuser:  ['listuser', 'users', 'รายชื่อ user', 'ดู user', 'list user'],
  cross:     ['cross', 'ข้ามระบบ', 'correlation', 'สหสัมพันธ์'],
};

// ── Alert processing helpers ──────────────────────────────────────────────────
const CLUSTER_WINDOW_SEC = 5 * 60; // 5 นาที
const CLUSTER_MIN_SIZE   = 3;      // ต้องมีอย่างน้อย 3 อุปกรณ์

function extractZone(hostName) {
  return hostName.replace(/\d+$/g, '').split(/[-_\s]+/).filter(Boolean).slice(0, 2).join('-') || hostName.slice(0, 8);
}

function processProblems(problems) {
  const counts = { disaster: 0, high: 0, average: 0, warning: 0, total: problems.length };
  for (const p of problems) {
    if      (p.priority === 5) counts.disaster++;
    else if (p.priority === 4) counts.high++;
    else if (p.priority === 3) counts.average++;
    else if (p.priority === 2) counts.warning++;
  }

  const critical  = problems.filter((p) => p.priority >= 4);
  const clustered = new Set();
  const clusters  = [];

  for (let i = 0; i < critical.length; i++) {
    if (clustered.has(i)) continue;
    const pi    = critical[i];
    const zoneI = extractZone(pi.host);
    const group = [i];
    for (let j = i + 1; j < critical.length; j++) {
      if (clustered.has(j)) continue;
      const pj = critical[j];
      if (Math.abs((pi.lastchangeTs || 0) - (pj.lastchangeTs || 0)) <= CLUSTER_WINDOW_SEC &&
          extractZone(pj.host) === zoneI) {
        group.push(j);
      }
    }
    if (group.length >= CLUSTER_MIN_SIZE) {
      group.forEach((idx) => clustered.add(idx));
      clusters.push({ zone: zoneI, count: group.length });
    }
  }

  return {
    counts,
    clusters,
    topItems:    critical.slice(0, 10),
    moreCount:   Math.max(0, critical.length - 10),
    hiddenCount: counts.average + counts.warning,
  };
}

// ── Pagination helpers ────────────────────────────────────────────────────────
// ใช้ร่วมกันทุกคำสั่งที่แสดงรายการ (host / wifi / alert / กล้อง)
const LIST_PAGE_SIZE = 8;

function paginate(items, page = 1, pageSize = LIST_PAGE_SIZE) {
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  const safePage   = Math.min(Math.max(page, 1), totalPages);
  return {
    items:      items.slice((safePage - 1) * pageSize, safePage * pageSize),
    page:       safePage,
    totalPages,
    hasNext:    safePage < totalPages,
    hasPrev:    safePage > 1,
  };
}

// ปุ่ม Quick Reply เปลี่ยนหน้า — กดแล้วส่ง "<cmdText> <เลขหน้า>" กลับมาเป็นข้อความ
function pageQR(cmdText, pg) {
  const items = [];
  if (pg.hasPrev) items.push({ type: 'action', action: { type: 'message', label: '← หน้าก่อน',   text: `${cmdText} ${pg.page - 1}` } });
  if (pg.hasNext) items.push({ type: 'action', action: { type: 'message', label: 'หน้าถัดไป →', text: `${cmdText} ${pg.page + 1}` } });
  return items;
}

// เลขหน้าจากท้ายข้อความ เช่น "host 2" → 2 (ไม่มีเลข = หน้า 1)
function parsePage(text) {
  const m = text.match(/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : 1;
}

// ── Site grouping สำหรับคำสั่ง "กล้อง" 2 ระดับ ───────────────────────────────
// ชื่อกล้องขึ้นต้นด้วยชื่อไซต์ เช่น "นเรศวร.ทางเข้า1" — ไม่ match = "อื่นๆ"
const CAMERA_SITES  = ['นเรศวร', 'บ่อขยะ', 'วอแก้ว', 'สูงอายุ', 'หนองกระทิง', 'อบจ'];
const getCameraSite = (name) => CAMERA_SITES.find((s) => String(name || '').startsWith(s)) || 'อื่นๆ';
// รองรับทั้ง shape จาก Zabbix (available) และ HikCentral (online)
const isCamOnline   = (c) => (c.available !== undefined ? c.available === 1 : c.online === true);

// LINE Flex bubble จำกัด JSON 10KB — กันชนที่ 9000 bytes
// นับ byte ไม่ใช่ char เพราะภาษาไทยกิน 3 bytes/ตัวอักษรใน UTF-8
// (guard เดิม 4500 chars ตัดหน้า 8 รายการเหลือ 5 ทุกครั้ง ทำให้รายการ 6-8 ไม่มีทางแสดง)
const FLEX_SAFE_BYTES = 9000;
const flexOversize = (msg) => Buffer.byteLength(JSON.stringify(msg), 'utf8') > FLEX_SAFE_BYTES;

function matchCommand(text) {
  for (const [cmd, keywords] of Object.entries(COMMAND_MAP)) {
    if (keywords.some((kw) => text === kw || text.startsWith(kw + ' '))) return cmd;
  }
  // Fuzzy: คำสำคัญต้องอยู่เป็นคำเต็ม (word boundary) ไม่ใช่ substring
  // เช่น "ap" ต้องไม่ match "approve" หรือ "map"
  for (const [cmd, keywords] of Object.entries(COMMAND_MAP)) {
    if (keywords.some((kw) => {
      const escaped = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return new RegExp(`(?<![\\w])${escaped}(?![\\w])`, 'i').test(text);
    })) return cmd;
  }
  return null;
}

async function route(text, rawText, userId, replyToken) {
  const userRole = auth.getUserRole(userId);

  // helpers สำหรับดึง argument จาก rawText (ป้องกัน toLowerCase ทำลาย User ID / Role)
  // wa(n) = whitespace-split arg n, cc(n) = colon-split part n — ทั้งคู่ trim แล้ว
  const _raw  = rawText.trim();
  const _ws   = _raw.split(/\s+/);
  const _col  = _raw.split(':');
  const wa    = (n) => (_ws[n]  || '').trim();
  const cc    = (n) => (_col[n] || '').trim();

  // ── Admin commands ──────────────────────────────────────────────────────────
  if (text.startsWith('adduser ')) {
    if (!auth.canExecute(userId, 'adduser')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const targetId = wa(1);               // case-preserved
    const role     = wa(2).toUpperCase(); // normalize เป็น uppercase
    const result   = auth.addUser(targetId, role);
    logger.audit(userId, 'adduser', `target=${targetId} role=${role}`);
    return reply(replyToken, fmt.buildAiResponse(result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`));
  }

  if (text.startsWith('removeuser ')) {
    if (!auth.canExecute(userId, 'removeuser')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const targetId = wa(1); // case-preserved
    const result   = auth.removeUser(targetId);
    logger.audit(userId, 'removeuser', `target=${targetId}`);
    return reply(replyToken, fmt.buildAiResponse(result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`));
  }

  // ── approve:Uxxxxxxx[:ROLE] — กดปุ่มจาก pending list ───────────────────────
  if (text.startsWith('approve:')) {
    if (!auth.canExecute(userId, 'approve')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const targetId = cc(1);               // case-preserved
    const role     = cc(2).toUpperCase(); // normalize
    // approve:Uxxxxxxx:ROLE → execute
    if (targetId && role) {
      const result = auth.approvePending(targetId, role);
      logger.audit(userId, 'approve', `target=${targetId} role=${role}`);
      if (result.ok) {
        const approvedName = await getDisplayName(targetId);
        try {
          await lineClient.pushMessage({ to: targetId, messages: [{
            type: 'text', text: `✅ คุณได้รับอนุมัติให้เข้าใช้งาน IT Monitor Bot แล้ว (role: ${role})\nพิมพ์ "help" เพื่อดูคำสั่งทั้งหมด`,
          }] });
        } catch { /* push อาจล้มเหลวถ้า user ไม่ได้ follow bot */ }
        return reply(replyToken, fmt.buildAiResponse(`✅ อนุมัติ ${approvedName} เป็น ${role} แล้ว`));
      }
      return reply(replyToken, fmt.buildError(result.msg));
    }
    // approve:Uxxxxxxx → แสดง role select card
    const targetName = await getDisplayName(targetId);
    return replyCustomQR(replyToken, fmt.buildRoleSelectCard(targetName, targetId), roleQR(targetId, 'approve'));
  }

  // ── approve [userId] [role] — fallback พิมพ์ตรง ─────────────────────────────
  if (text.startsWith('approve ')) {
    if (!auth.canExecute(userId, 'approve')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const targetId = wa(1);
    const role     = wa(2).toUpperCase();
    const result   = auth.approvePending(targetId, role);
    logger.audit(userId, 'approve', `target=${targetId} role=${role}`);
    return reply(replyToken, fmt.buildAiResponse(result.ok ? `✅ ${result.msg}` : `❌ ${result.msg}`));
  }

  // ── manage:Uxxxxxxx — กดแถวใน user list ─────────────────────────────────────
  if (text.startsWith('manage:')) {
    if (!auth.canExecute(userId, 'listuser')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const targetId   = cc(1); // case-preserved
    const targetName = await getDisplayName(targetId);
    return replyCustomQR(replyToken, fmt.buildRoleSelectCard(targetName, targetId), [
      ...roleQR(targetId, 'changerole'),
      { type: 'action', action: { type: 'message', label: '🗑 ลบออก', text: `removeuser ${targetId}` } },
    ]);
  }

  // ── changerole:Uxxxxxxx:ROLE — กด Quick Reply จาก manage ────────────────────
  // จับทั้ง "changerole" เปล่า ๆ ด้วย — args ไม่ครบต้องตอบ error ไม่ไหลลง AI
  if (text.startsWith('changerole')) {
    if (!auth.canExecute(userId, 'adduser')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const targetId = cc(1);
    const role     = cc(2).toUpperCase();
    if (!targetId || !role) {
      return reply(replyToken, fmt.buildError('กรุณาระบุ ID และ role ให้ครบ — รูปแบบ: changerole:USER_ID:ROLE'));
    }
    const result     = auth.addUser(targetId, role);
    logger.audit(userId, 'changerole', `target=${targetId} role=${role}`);
    const targetName = await getDisplayName(targetId);
    return reply(replyToken, fmt.buildAiResponse(result.ok ? `✅ เปลี่ยน role ${targetName} เป็น ${role} แล้ว` : `❌ ${result.msg}`));
  }

  if (text === 'pending') {
    if (!auth.canExecute(userId, 'pending')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const rawList = auth.getPendingUsers();
    // ดึง display name พร้อมกันทุกคน
    const withNames = await Promise.all(rawList.map(async u => ({
      ...u, displayName: await getDisplayName(u.id),
    })));
    return reply(replyToken, fmt.buildPendingList(withNames));
  }

  if (text.startsWith('วิเคราะห์')) {
    return withAI(userId, replyToken, async () => {
      const subCmd = rawText.replace(/^วิเคราะห์\s*/i, '').trim().toLowerCase();

      // "วิเคราะห์กล้อง CAM-xxx" — วิเคราะห์กล้องรายตัว
      const camIdMatch = subCmd.match(/^กล้อง\s+(cam-\d+)/i);
      if (camIdMatch) {
        const camId   = camIdMatch[1].toUpperCase();
        const cameras = await getCamerasWithCache();
        const cam     = cameras.find(c => String(c.name || c.id || '').toUpperCase() === camId);
        if (!cam) return reply(replyToken, fmt.buildError(`ไม่พบข้อมูลกล้อง ${camId}`));
        const ctx      = `กล้อง ${cam.name} ตำแหน่ง ${cam.location || '-'} สถานะ ${cam.status} ดับมา ${cam.duration || '-'} ตั้งแต่ ${cam.offlineSince || 'N/A'}`;
        const analysis = await ai.chat(`วิเคราะห์ปัญหากล้อง CCTV รายตัว บอกสาเหตุที่น่าจะเป็นและวิธีแก้ไข:\n${ctx}`);
        return reply(replyToken, fmt.buildAiResponse(analysis));
      }

      // "วิเคราะห์กล้อง" หรือ "วิเคราะห์"
      if (subCmd === 'กล้อง' || subCmd === '') {
        const ctx = userLastCameraCtx.get(userId);
        if (ctx && Date.now() - ctx.setAt < CONTEXT_TTL_MS) {
          const analysis = await ai.chat(`วิเคราะห์ปัญหากล้อง CCTV ต่อไปนี้ บอกสาเหตุที่เป็นไปได้ วิธีแก้ไข และวิธีป้องกัน:\n${ctx.text}`);
          return reply(replyToken, fmt.buildAiResponse(analysis));
        }
        return reply(replyToken, fmt.buildError('ไม่มีข้อมูลกล้องล่าสุด — กรุณาพิมพ์ "กล้องดับ" ก่อน'));
      }

      // "วิเคราะห์ alert"
      if (subCmd === 'alert' || subCmd === 'alerts') {
        const ctx = userLastAlertCtx.get(userId);
        if (ctx && Date.now() - ctx.setAt < CONTEXT_TTL_MS) {
          const top      = ctx.problems[0] || { description: 'ไม่มี alert', host: 'N/A', priorityLabel: 'N/A', lastChange: 'N/A', comments: '' };
          const analysis = await ai.analyzeAlert(top);
          return reply(replyToken, fmt.buildAiResponse(analysis));
        }
        return reply(replyToken, fmt.buildError('ไม่มีข้อมูล alert ล่าสุด — กรุณาพิมพ์ "alert" ก่อน'));
      }

      // "วิเคราะห์ host"
      if (subCmd === 'host' || subCmd === 'hosts') {
        const ctx = userLastHostCtx.get(userId);
        if (ctx && Date.now() - ctx.setAt < CONTEXT_TTL_MS) {
          const analysis = await ai.chat(`วิเคราะห์สถานะ Host ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:\n${ctx.text}`);
          return reply(replyToken, fmt.buildAiResponse(analysis));
        }
        return reply(replyToken, fmt.buildError('ไม่มีข้อมูล host ล่าสุด — กรุณาพิมพ์ "host" ก่อน'));
      }

      // "วิเคราะห์ wifi"
      if (subCmd === 'wifi') {
        const ctx = userLastWifiCtx.get(userId);
        if (ctx && Date.now() - ctx.setAt < CONTEXT_TTL_MS) {
          const analysis = await ai.chat(`วิเคราะห์สถานะ WiFi AP ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:\n${ctx.text}`);
          return reply(replyToken, fmt.buildAiResponse(analysis));
        }
        return reply(replyToken, fmt.buildError('ไม่มีข้อมูล WiFi ล่าสุด — กรุณาพิมพ์ "wifi" ก่อน'));
      }

      // "วิเคราะห์ summary"
      if (subCmd === 'summary' || subCmd === 'ทั้งหมด' || subCmd === 'สรุป') {
        const ctx = userLastSummaryCtx.get(userId);
        if (ctx && Date.now() - ctx.setAt < CONTEXT_TTL_MS) {
          const analysis = await ai.chat(`วิเคราะห์ภาพรวมระบบ IT ต่อไปนี้ บอกสถานการณ์ปัจจุบันและคำแนะนำ:\n${ctx.text}`);
          return reply(replyToken, fmt.buildAiResponse(analysis));
        }
        return reply(replyToken, fmt.buildError('ไม่มีข้อมูลสรุปล่าสุด — กรุณาพิมพ์ "ทั้งหมด" ก่อน'));
      }

      // "วิเคราะห์ cross" — AI วิเคราะห์ Cross-System Correlation (on-demand)
      if (subCmd === 'cross' || subCmd === 'correlation' || subCmd === 'ข้ามระบบ' || subCmd === 'สหสัมพันธ์') {
        const ctx = userLastCorrCtx.get(userId);
        if (ctx && Date.now() - ctx.setAt < CONTEXT_TTL_MS) {
          if (!ctx.groups.length) {
            return reply(replyToken, fmt.buildError('ไม่พบกลุ่มที่น่ากังวล — กรุณาพิมพ์ "cross" ก่อน'));
          }
          const analysis = await ai.analyzeCorrelation(ctx.groups[0]);
          return reply(replyToken, fmt.buildAiResponse(analysis));
        }
        return reply(replyToken, fmt.buildError('ไม่มีข้อมูล cross-system ล่าสุด — กรุณาพิมพ์ "cross" ก่อน'));
      }

      // "วิเคราะห์ <ข้อความ>" — วิเคราะห์โดยตรง
      const fakeAlert = { description: rawText.replace(/^วิเคราะห์\s*/i, '').trim(), host: 'N/A', priorityLabel: 'N/A', lastChange: 'N/A', comments: '' };
      const analysis  = await ai.analyzeAlert(fakeAlert);
      return reply(replyToken, fmt.buildAiResponse(analysis));
    });
  }

  // ── กล้อง:ไซต์ [หน้า] — ระดับ 2 ของคำสั่ง "กล้อง" (กดปุ่มไซต์จาก Quick Reply) ─
  if (text.startsWith('กล้อง:')) {
    if (!auth.canExecute(userId, 'กล้อง')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
    const arg  = text.slice('กล้อง:'.length).trim();
    const m    = arg.match(/^(.*?)\s*(\d+)?$/);
    const site = (m?.[1] || '').trim();
    const page = m?.[2] ? parseInt(m[2], 10) : 1;

    const cameras  = await getCamerasWithCache();
    const siteCams = cameras.filter((c) => getCameraSite(c.name) === site);
    if (!siteCams.length) {
      return reply(replyToken, fmt.buildError(`ไม่พบกล้องในไซต์ "${site}" — พิมพ์ "กล้อง" เพื่อดูรายชื่อไซต์`));
    }

    // Pagination: หน้าละ 8 — ปุ่ม "กล้อง:ไซต์ 2" = หน้า 2
    const pg  = paginate(siteCams, page);
    const msg = fmt.buildSiteCameras(site, pg.items, pg, siteCams);
    const safeMsg = flexOversize(msg)
      ? fmt.buildSiteCameras(site, pg.items.slice(0, 5), pg, siteCams)
      : msg;

    // ปุ่มเปลี่ยนหน้าอยู่ในการ์ดแล้ว (listFooter) — เหลือแค่ปุ่มกลับใน Quick Reply
    return reply(replyToken, safeMsg, [
      { type: 'action', action: { type: 'message', label: '↩ กลับ', text: 'กล้อง' } },
    ]);
  }

  // ── Matched commands ────────────────────────────────────────────────────────
  const cmd = matchCommand(text);

  switch (cmd) {
    case 'help': {
      const AUTH_CMD_DEFS = [
        ['myid',    '🪪 myid',                  'ดู LINE User ID ของคุณ'],
        ['pending', '⏳ pending',               'ดูคนรออนุมัติ'],
        ['adduser', '➕ adduser [ID] [ROLE]',   'เพิ่มผู้ใช้'],
        ['approve', '✅ approve [ID] [ROLE]',   'อนุมัติ + ตั้ง role'],
      ];
      const extraCmds = AUTH_CMD_DEFS
        .filter(([key]) => auth.canExecute(userId, key))
        .map(([, label, desc]) => [label, desc]);
      return reply(replyToken, fmt.buildHelp(extraCmds));
    }

    case 'alert': {
      if (!auth.canExecute(userId, 'alert')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
      if (!zabbix) return reply(replyToken, fmt.buildError('Zabbix ยังไม่เปิดใช้งาน'));

      // ตรวจ subcommand เช่น "alert warning"
      const alertKeywords = ['alerts', 'alert', 'การแจ้งเตือน', 'แจ้งเตือน', 'problems', 'problem'];
      let alertSub = '';
      for (const kw of alertKeywords) {
        if (text === kw) { alertSub = ''; break; }
        if (text.startsWith(kw + ' ')) { alertSub = text.slice(kw.length + 1).trim(); break; }
      }

      const problems = await zabbix.getProblems(200);

      // Subcommand: แสดง Average / Warning — "alert warning 2" = หน้า 2
      const warnMatch = alertSub.match(/^(warning|average|warn|avg)(?:\s+(\d+))?$/);
      if (warnMatch) {
        userLastAlertCtx.set(userId, { problems, setAt: Date.now() });
        const lowItems = problems.filter((p) => p.priority >= 2 && p.priority <= 3);

        // Pagination: ครั้งละ 8 เหมือนคำสั่งอื่น
        const pg       = paginate(lowItems, warnMatch[2] ? parseInt(warnMatch[2], 10) : 1);
        const pageInfo = { page: pg.page, totalPages: pg.totalPages, total: lowItems.length };

        const warnMsg  = fmt.buildAlertWarning(pg.items, pageInfo);
        const safeWarn = flexOversize(warnMsg)
          ? fmt.buildAlertWarning(pg.items.slice(0, 5), pageInfo)
          : warnMsg;
        return reply(replyToken, safeWarn, pageQR(`alert ${warnMatch[1]}`, pg));
      }

      // Pagination: แบ่งหน้ารายการ Disaster+High ครั้งละ 8 — "alert 2" = หน้า 2
      const processed = processProblems(problems);
      const critical  = problems.filter((p) => p.priority >= 4);
      const pg        = paginate(critical, parsePage(text));
      processed.topItems  = pg.items;
      processed.moreCount = 0;
      processed.pageInfo  = { page: pg.page, totalPages: pg.totalPages };
      userLastAlertCtx.set(userId, { problems, page: pg.page, setAt: Date.now() });

      const alertOpts = { pageCmd: 'alert', pg };
      const msg     = fmt.buildAlerts(processed, null, 'วิเคราะห์ alert', alertOpts);
      const safeMsg = flexOversize(msg)
        ? fmt.buildAlerts({ ...processed, topItems: processed.topItems.slice(0, 5), clusters: [] }, null, 'วิเคราะห์ alert', alertOpts)
        : msg;
      return reply(replyToken, safeMsg);
    }

    case 'host': {
      if (!auth.canExecute(userId, 'host')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
      if (!zabbix) return reply(replyToken, fmt.buildError('Zabbix ยังไม่เปิดใช้งาน'));
      const hosts = await zabbix.getHosts(50);
      const hostOffline = hosts.filter((h) => h.available !== 1);
      const hostCtxText = `Host ทั้งหมด ${hosts.length} เครื่อง ออนไลน์ ${hosts.filter((h) => h.available === 1).length} ออฟไลน์ ${hostOffline.length}` +
        (hostOffline.length > 0 ? `: ${hostOffline.slice(0, 10).map((h) => h.name).join(', ')}` : '');

      // Pagination: ครั้งละ 8 — "host 2" = หน้า 2
      const pg = paginate(hosts, parsePage(text));
      userLastHostCtx.set(userId, { text: hostCtxText, page: pg.page, setAt: Date.now() });

      const hostTitle = pg.totalPages > 1 ? `สถานะ Host (หน้า ${pg.page}/${pg.totalPages})` : 'สถานะ Host';
      const hostOpts = { statsFrom: hosts, deviceType: 'host', pageCmd: 'host', pg };
      const hostMsg  = fmt.buildHosts(pg.items, null, hostTitle, '💻', 'วิเคราะห์ host', hostOpts);
      const safeHost = flexOversize(hostMsg)
        ? fmt.buildHosts(pg.items.slice(0, 5), null, hostTitle, '💻', 'วิเคราะห์ host', hostOpts)
        : hostMsg;
      return reply(replyToken, safeHost);
    }

    case 'camera': {
      if (!auth.canExecute(userId, 'กล้อง')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));

      const cameras = await getCamerasWithCache();

      const cameraOffline = cameras.filter((c) => !isCamOnline(c));
      const cameraCtxText = `กล้องทั้งหมด ${cameras.length} เครื่อง ปกติ ${cameras.length - cameraOffline.length} มีปัญหา ${cameraOffline.length}` +
        (cameraOffline.length > 0 ? `: ${cameraOffline.slice(0, 5).map((c) => c.name).join(', ')}` : '');
      userLastCameraCtx.set(userId, { text: cameraCtxText, setAt: Date.now() });

      // ระดับ 1: สรุปรายไซต์ — กดปุ่ม/แถวไซต์ส่ง "กล้อง:ไซต์" เข้าระดับ 2
      const siteMap = new Map();
      for (const c of cameras) {
        const s = getCameraSite(c.name);
        const e = siteMap.get(s) || { site: s, total: 0, online: 0, offline: 0 };
        e.total++;
        if (isCamOnline(c)) e.online++; else e.offline++;
        siteMap.set(s, e);
      }
      const siteStats = [...CAMERA_SITES, 'อื่นๆ']
        .filter((s) => siteMap.has(s))
        .map((s) => siteMap.get(s));

      const siteMsg = fmt.buildCameraSites(siteStats, 'วิเคราะห์กล้อง');
      const safeCam = flexOversize(siteMsg)
        ? fmt.buildCameraSites(siteStats.slice(0, 8), 'วิเคราะห์กล้อง')
        : siteMsg;

      const siteQR = siteStats.slice(0, 8).map((s) => ({
        type: 'action', action: { type: 'message', label: `${s.site} (${s.total})`, text: `กล้อง:${s.site}` },
      }));
      return reply(replyToken, safeCam, siteQR);
    }

    case 'cameraOff': {
      if (!auth.canExecute(userId, 'กล้องดับ')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
      if (!zabbix) return reply(replyToken, fmt.buildError('Zabbix ยังไม่เปิดใช้งาน'));

      // Parse page number จากคำสั่ง เช่น "กล้องดับ 2"
      const pageMatch = text.match(/\d+/);
      const reqPage   = pageMatch ? parseInt(pageMatch[0], 10) : 1;

      // ดึงจาก background cache — ถ้ายังไม่มีให้ดึงสดครั้งแรก
      if (!offlineCamCache.raw) await refreshOfflineCameraCache();
      const raw         = offlineCamCache.raw || { allOffline: [], total: 0, groups: [], clockMap: {} };
      const cacheAgeMin = offlineCamCache.refreshedAt
        ? Math.floor((Date.now() - offlineCamCache.refreshedAt) / 60_000)
        : null;

      const data    = zabbix.pageOfflineCameras(reqPage, raw);
      const flexMsg = fmt.buildOfflineCameras(data, cacheAgeMin, 'วิเคราะห์กล้อง');

      // ตรวจ payload ≤ 4500 ตัวอักษร (กันชน 5000)
      const safeMsg = JSON.stringify(flexMsg).length > 4500
        ? fmt.buildOfflineCameras({ ...data, cameras: data.cameras.slice(0, 5), groups: data.groups.slice(0, 8) }, cacheAgeMin, 'วิเคราะห์กล้อง')
        : flexMsg;

      // เก็บ context สำหรับ AI วิเคราะห์ on-demand
      userLastCameraCtx.set(userId, { text: buildCameraAnalysisContext(data), setAt: Date.now() });

      return reply(replyToken, safeMsg);
    }

    case 'wifi': {
      if (!auth.canExecute(userId, 'wifi')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
      if (!omada) return reply(replyToken, fmt.buildError('Omada ยังไม่เปิดใช้งาน'));
      const aps = await omada.getAPs();
      const wifiOffline = aps.filter((a) => a.isProblem);
      const wifiCtxText = `AP ทั้งหมด ${aps.length} เครื่อง ปกติ ${aps.filter((a) => !a.isProblem).length} มีปัญหา ${wifiOffline.length}` +
        (wifiOffline.length > 0 ? `: ${wifiOffline.slice(0, 10).map((a) => a.name).join(', ')}` : '');

      // Pagination: ครั้งละ 8 — "wifi 2" = หน้า 2
      const pg = paginate(aps, parsePage(text));
      userLastWifiCtx.set(userId, { text: wifiCtxText, page: pg.page, setAt: Date.now() });

      const wifiTitle = pg.totalPages > 1 ? `สถานะ Access Point (หน้า ${pg.page}/${pg.totalPages})` : 'สถานะ Access Point';
      const wifiOpts = { statsFrom: aps, deviceType: 'ap', pageCmd: 'wifi', pg };
      const wifiMsg  = fmt.buildHosts(pg.items, null, wifiTitle, '📶', 'วิเคราะห์ wifi', wifiOpts);
      const safeWifi = flexOversize(wifiMsg)
        ? fmt.buildHosts(pg.items.slice(0, 5), null, wifiTitle, '📶', 'วิเคราะห์ wifi', wifiOpts)
        : wifiMsg;
      return reply(replyToken, safeWifi);
    }

    case 'client': {
      if (!auth.canExecute(userId, 'client')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
      if (!omada) return reply(replyToken, fmt.buildError('Omada ยังไม่เปิดใช้งาน'));
      const clients = await omada.getClients();
      if (clients.unavailable) {
        return reply(replyToken, fmt.buildError('ดึงข้อมูล Client จาก Omada ไม่ได้ชั่วคราว ลองใหม่อีกครั้ง'));
      }
      return reply(replyToken, fmt.buildAiResponse(
        `👥 Client ที่เชื่อมต่ออยู่\n📶 Wireless: ${clients.wireless}\n🔌 Wired: ${clients.wired}\n📊 รวม: ${clients.total}`
      ));
    }

    case 'summary': {
      // ดึงข้อมูลจากทุก Monitor พร้อมกัน — แยก getClients ออกจาก Promise.all
      // เพื่อไม่ให้ Omada /clients fail ทำให้ AP fail ตามไปด้วย
      const [zData, apsResult, clientsResult, hData] = await Promise.allSettled([
        zabbix     ? zabbix.getSummary()         : Promise.resolve(null),
        omada      ? omada.getAPs()              : Promise.resolve(null),
        omada      ? omada.getClients()          : Promise.resolve(null),
        hikcentral ? hikcentral.getCameras()     : Promise.resolve(null),
      ]);

      const allData = {
        zabbix: zData.status === 'fulfilled' ? zData.value : null,
        omada: {
          aps:     apsResult.status === 'fulfilled' ? (apsResult.value || null) : null,
          clients: clientsResult.status === 'fulfilled' ? (clientsResult.value || null) : null,
        },
        hik:    hData.status === 'fulfilled' ? { cameras: hData.value } : null,
      };

      const z = allData.zabbix || {};
      const h = allData.hik    || {};
      const o = allData.omada  || {};
      const summaryCtxText = [
        `Zabbix: ${z.problems?.length || 0} alerts, ${z.hosts?.filter((h2) => h2.available === 1).length || 0}/${z.hosts?.length || 0} hosts online`,
        h.cameras ? `กล้อง: ${h.cameras.filter((c) => c.online).length}/${h.cameras.length} online` : null,
        o.aps     ? `WiFi: ${o.aps.length} APs, ${o.clients?.total || 0} clients` : null,
      ].filter(Boolean).join('. ');
      userLastSummaryCtx.set(userId, { text: summaryCtxText, setAt: Date.now() });
      const msg = fmt.buildSummary(allData, null, 'วิเคราะห์ summary');
      return reply(replyToken, msg);
    }

    case 'status': {
      const checks = await Promise.allSettled([
        zabbix     ? zabbix.healthCheck()     : Promise.resolve({ ok: false, name: 'Zabbix',     error: 'ปิดใช้งาน' }),
        omada      ? omada.healthCheck()      : Promise.resolve({ ok: false, name: 'Omada WiFi', error: 'ปิดใช้งาน' }),
        hikcentral ? hikcentral.healthCheck() : Promise.resolve({ ok: false, name: 'HikCentral', error: 'ปิดใช้งาน' }),
      ]);
      const statuses = checks.map((r) =>
        r.status === 'fulfilled' ? r.value : { ok: false, name: 'Unknown', error: r.reason?.message }
      );
      return reply(replyToken, fmt.buildStatus(statuses));
    }

    case 'listuser': {
      if (!auth.canExecute(userId, 'listuser')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));
      logger.audit(userId, 'listuser');
      const rawUsers = auth.listUsers();
      const withNames = await Promise.all(rawUsers.map(async u => ({
        ...u, displayName: await getDisplayName(u.id),
      })));
      return reply(replyToken, fmt.buildUserList(withNames));
    }

    case 'cross': {
      if (!auth.canExecute(userId, 'cross')) return reply(replyToken, fmt.buildError('คุณไม่มีสิทธิ์ใช้คำสั่งนี้'));

      const adapters = config.getAdapters();
      if (!adapters.length) return reply(replyToken, fmt.buildError('ไม่มี Monitor ที่เปิดใช้งาน'));

      // รวบรวม problems จากทุก adapter — ตัวที่ error ข้ามไป ไม่ทำให้ตัวอื่นพัง
      const adapterResults = await Promise.allSettled(
        adapters.map(({ adapter }) => adapter.getProblems())
      );
      const allProblems = adapterResults.flatMap((r, i) => {
        if (r.status === 'fulfilled') return r.value;
        logger.warn(`cross: adapter "${adapters[i].name}" error: ${r.reason?.message}`);
        return [];
      });

      const groups     = correlate(allProblems, config.CORRELATION_CONFIG);
      const highGroups = groups.filter((g) => g.confidence === 'high');

      // เก็บ context สำหรับ AI วิเคราะห์ on-demand (เฉพาะ high-confidence)
      userLastCorrCtx.set(userId, { groups: highGroups, setAt: Date.now() });

      const analyzeText = highGroups.length > 0 ? 'วิเคราะห์ cross' : null;
      const msg = fmt.buildCorrelation(groups, analyzeText);

      // ตรวจ payload ≤ 4500 ตัวอักษร
      const safeMsg = JSON.stringify(msg).length > 4500
        ? fmt.buildCorrelation(groups.slice(0, 2), analyzeText)
        : msg;

      return reply(replyToken, safeMsg);
    }

    default: {
      return withAI(userId, replyToken, async () => {
        let context = null;
        if (zabbix) {
          try { context = await zabbix.getProblems(5); } catch { /* ไม่มีผลกับ AI */ }
        }
        const answer = await ai.chat(rawText, context);
        return reply(replyToken, fmt.buildAiResponse(answer));
      });
    }
  }
}

// ── ดึงกล้องจากทุก Monitor ที่ enabled ───────────────────────────────────────
async function getAllCameras() {
  const results = await Promise.allSettled([
    zabbix     ? zabbix.getCameras()            : Promise.resolve([]),
    hikcentral ? hikcentral.getCameras(1, 1000) : Promise.resolve([]), // ดึงครั้งเดียว
  ]);
  return results.flatMap((r) => r.status === 'fulfilled' ? r.value : []);
}

// Cache wrapper — คืน cached data ถ้าไม่ถึง 2 นาที ลด API call เมื่อมีกล้องเยอะ
async function getCamerasWithCache() {
  if (cameraCache.data && Date.now() < cameraCache.expireAt) {
    logger.info('camera: cache hit');
    return cameraCache.data;
  }
  const cameras = await getAllCameras();
  cameraCache.data    = cameras;
  cameraCache.expireAt = Date.now() + CAMERA_CACHE_TTL_MS;
  logger.info(`camera: cache refreshed (${cameras.length} cameras)`);
  return cameras;
}

// ── Background Offline Camera Poller ─────────────────────────────────────────
async function refreshOfflineCameraCache() {
  if (!zabbix) return;
  try {
    const raw = await zabbix.fetchOfflineCamerasRaw();
    offlineCamCache.raw         = raw;
    offlineCamCache.refreshedAt = Date.now();
    logger.info(`poller: offline cameras refreshed (total=${raw.total})`);
  } catch (err) {
    // timeout → warn + ใช้ cache เดิมต่อ (ไม่ reset offlineCamCache.raw)
    const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message);
    if (isTimeout) {
      logger.warn(`poller: Zabbix timeout — ใช้ cache เดิมต่อ (cached total=${offlineCamCache.raw?.total ?? 'none'})`);
    } else {
      logger.error('poller: offline camera refresh failed', err);
    }
  }
}

// ── สร้าง summary text สำหรับส่งให้ AI วิเคราะห์ (ไม่ส่ง raw ทั้งหมด) ──────
function buildCameraAnalysisContext(data) {
  const { total, groups, cameras } = data;
  if (total === 0) return 'ไม่มีกล้องออฟไลน์';
  if (cameras.length === 0) {
    const top = groups.slice(0, 8).map((g) => `${g.location}: ${g.count} ตัว`).join(', ');
    return `กล้องออฟไลน์ ${total} ตัว จัดกลุ่มตามตำแหน่ง: ${top}`;
  }
  return `กล้องออฟไลน์ ${total} ตัว: ` +
    cameras.map((c) => `${c.name} (${c.location || '-'}) IP:${c.ip} ดับ ${c.duration}`).join(' | ');
}

// ── Role Quick Reply items ─────────────────────────────────────────────────────
function roleQR(targetId, action) {
  // action = 'approve' | 'changerole'
  return [
    { type: 'action', action: { type: 'message', label: '👑 ADMIN',    text: `${action}:${targetId}:ADMIN`    } },
    { type: 'action', action: { type: 'message', label: '👔 IT_STAFF', text: `${action}:${targetId}:IT_STAFF` } },
    { type: 'action', action: { type: 'message', label: '👤 VIEWER',   text: `${action}:${targetId}:VIEWER`   } },
  ];
}

// ── Reply ไปยัง LINE ──────────────────────────────────────────────────────────
const ALT_TEXT       = 'IT Monitor Bot';
const PAYLOAD_LIMIT  = 9500; // ตัวอักษร (LINE Flex bubble จำกัด JSON 10KB — ดู FLEX_SAFE_BYTES)

// extraQR: array ของ quick reply items เพิ่มเติม (เช่น ปุ่ม AI)
async function reply(replyToken, flexContents, extraQR = []) {
  const payload = {
    replyToken,
    messages: [{
      type:       'flex',
      altText:    ALT_TEXT,
      contents:   flexContents,
      quickReply: fmt.quickReply(extraQR),
    }],
  };

  const payloadJson = JSON.stringify(payload);
  logger.info(`reply: payload ${payloadJson.length} chars / ${Buffer.byteLength(payloadJson, 'utf8')} bytes`);
  if (payloadJson.length > PAYLOAD_LIMIT) {
    logger.warn(`reply: payload เกิน ${PAYLOAD_LIMIT} chars (${payloadJson.length})`);
  }

  try {
    await lineClient.replyMessage(payload);
  } catch (err) {
    logger.warn(`reply: ล้มเหลวครั้งแรก (${err.message}) — retrying without quickReply`);
    if (err.body) logger.warn(`reply: LINE error body=${err.body}`);
    try {
      await lineClient.replyMessage({
        replyToken,
        messages: [{ type: 'flex', altText: ALT_TEXT, contents: flexContents }],
      });
    } catch (err2) {
      logger.error('reply: ล้มเหลวทั้ง 2 ครั้ง', err2);
      if (err2.body) logger.error(`reply: LINE error body=${err2.body}`);
    }
  }
}

// Reply with custom QR items only (ไม่ใช้ standard QR)
async function replyCustomQR(replyToken, flexContents, qrItems) {
  const payload = {
    replyToken,
    messages: [{
      type:       'flex',
      altText:    ALT_TEXT,
      contents:   flexContents,
      quickReply: { items: qrItems.slice(0, 13) },
    }],
  };
  try {
    await lineClient.replyMessage(payload);
  } catch (err) {
    logger.warn(`replyCustomQR: ${err.message}`);
    try {
      await lineClient.replyMessage({ replyToken, messages: [{ type: 'flex', altText: ALT_TEXT, contents: flexContents }] });
    } catch (err2) {
      logger.error('replyCustomQR: failed', err2);
    }
  }
}

// ── Auto Alert จาก Zabbix Webhook ────────────────────────────────────────────
// Zabbix Media Type → ส่ง POST มาที่ /zabbix-webhook พร้อม JSON alert data
const ALERTS_FILE = require('path').join(__dirname, 'data', 'notified_alerts.json');
const fs          = require('fs');

function loadNotified() {
  try { return new Set(JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveNotified(set) {
  try { fs.writeFileSync(ALERTS_FILE, JSON.stringify([...set].slice(-500)), 'utf8'); }
  catch { /* ignore */ }
}

async function handleZabbixPush(body) {
  const triggerId = String(body.triggerId || body.trigger_id || '');
  const resolved  = body.status === 'RESOLVED' || body.value === '0';
  const severity  = parseInt(body.severity || body.priority || '0', 10);

  const notified = loadNotified();

  if (resolved) {
    if (notified.has(triggerId)) {
      notified.delete(triggerId);
      saveNotified(notified);
      await pushToUsers(`✅ แก้ไขแล้ว: ${body.triggerName || body.name || 'Alert'}`, severity);
    }
    return;
  }

  // Alert ซ้ำ → ข้ามไป
  if (notified.has(triggerId)) return;

  notified.add(triggerId);
  saveNotified(notified);

  const alert = {
    description:   body.triggerName || body.name || 'Unknown Alert',
    host:          body.host || body.hostname || 'N/A',
    priorityLabel: ['ไม่ระบุ','ข้อมูล','คำเตือน','ปานกลาง','สูง','วิกฤต'][severity] || 'N/A',
    priorityIcon:  severity >= 5 ? '🟣' : severity >= 4 ? '🔴' : '⚠️',
    lastChange:    new Date().toLocaleString('th-TH'),
    lastchangeTs:  Math.floor(Date.now() / 1000),
    priority:      severity,
    comments:      body.comments || '',
  };

  const processed = processProblems([alert]);

  // AI เป็นส่วนเสริม — push ต้องเกิดเสมอไม่ว่า AI จะทำงานหรือไม่
  let analysis = null;
  try {
    analysis = await ai.analyzeAlert(alert);
  } catch (err) {
    logger.warn(`zabbix-webhook: AI วิเคราะห์ไม่ได้ — push ต่อโดยไม่มี AI (${err.message})`);
  }

  const flex = fmt.buildAlerts(processed, analysis);
  await pushToUsers(null, severity, flex);
}

// ── Push Message ให้ผู้ใช้ตาม Role ──────────────────────────────────────────
async function pushToUsers(text, severity, flex = null) {
  const users = auth.listUsers();
  const targets = users.filter((u) => {
    if (severity >= 4) return true;           // วิกฤต/สูง → แจ้งทุกคน
    return ['ADMIN', 'IT_STAFF'].includes(u.role); // Warning → เฉพาะ IT+
  });

  for (const user of targets) {
    try {
      if (flex) {
        await lineClient.pushMessage({ to: user.id, messages: [{ type: 'flex', altText: '🚨 แจ้งเตือนระบบ', contents: flex }] });
      } else if (text) {
        await lineClient.pushMessage({ to: user.id, messages: [{ type: 'text', text }] });
      }
    } catch (err) {
      logger.error(`pushToUsers: userId=${user.id}`, err);
    }
  }
}

// ── Start Server ───────────────────────────────────────────────────────────────
const PORT = config.SERVER_CONFIG.port;
app.listen(PORT, () => {
  logger.info(`IT Monitor Bot started`, { port: PORT });

  // เริ่ม background poller สำหรับ offline cameras
  if (zabbix) {
    refreshOfflineCameraCache(); // initial fetch ทันที
    setInterval(refreshOfflineCameraCache, OFFLINE_CAM_POLL_MS);
    logger.info(`poller: offline camera poller started (interval=${OFFLINE_CAM_POLL_MS / 1000}s)`);
  }
});
