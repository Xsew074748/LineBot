'use strict';
// /health/deep: กฎ 503 (checker ไม่ tick / LINE ล้มติดกัน), การเช็ก token, รูปแบบคำตอบที่ไม่รั่วข้อมูล, และ /health เดิมไม่เปลี่ยน
// ค่า token ทั้งหมดในไฟล์นี้เป็นค่าปลอมชัดเจน — ไม่ใช่ค่าจริง

const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const healthDeep = require('../services/health-deep');
const { createLineHealth } = require('../services/line-health');

const { evaluate, loadConfig, tokenMatches, createHandler, maxAgeMs } = healthDeep;
const FAKE_TOKEN = 'FAKE-TEST-TOKEN-not-a-real-secret-0000';
const SEC = 1000; const MIN = 60 * SEC;
const START = 1_700_000_000_000;

const hikOn = (over = {}) => ({ enabled: true, intervalMs: 60 * SEC, lastTickAt: null, lastResult: null, ...over });
const omadaOn = (over = {}) => ({ enabled: true, intervalMs: 5 * MIN, lastTickAt: null, lastResult: null, ...over });
const calm = { total: 10, failed: 0, consecutive: 0, status429: 0, quotaExhausted: false, lastSuccessAt: START, lastFailureAt: null, lastStatus: null };
const base = (over = {}) => ({ now: START + 10 * SEC, startedAt: START, checkers: {}, line: calm, ...over });

describe('กฎ 503 ข้อ 1: checker ไม่ tick', () => {
  it('maxAge = max(3 × interval, 180 วินาที)', () => {
    expect(maxAgeMs(60 * SEC)).toBe(180 * SEC);          // 3 × 60 = 180
    expect(maxAgeMs(30 * SEC)).toBe(180 * SEC);          // 3 × 30 = 90 → ยกขึ้นเป็น 180
    expect(maxAgeMs(5 * MIN)).toBe(15 * MIN);            // 3 × 300 = 900
  });

  it('อุ่นเครื่อง: ยังไม่เคย tick แต่เพิ่งเริ่ม → 200 (ใช้ startedAt เป็นฐาน)', () => {
    const r = evaluate(base({ now: START + 120 * SEC, checkers: { hikTempAlarm: hikOn() } }));
    expect(r.ok).toBe(true);
    expect(r.body.checkers.hikTempAlarm).toMatchObject({ enabled: true, lastTickAgoSec: null, maxAgeSec: 180 });
  });

  it('ไม่เคย tick เลยเกินเกณฑ์นับจากเริ่มบอท → 503 hik-temp-alarm-stale', () => {
    const r = evaluate(base({ now: START + 181 * SEC, checkers: { hikTempAlarm: hikOn() } }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['hik-temp-alarm-stale']);
    expect(r.body.status).toBe('fail');
  });

  it('ขอบเขตพอดี: เท่ากับเกณฑ์ยังผ่าน เกิน 1 มิลลิวินาทีไม่ผ่าน', () => {
    const at = START + 180 * SEC;
    expect(evaluate(base({ now: at, checkers: { hikTempAlarm: hikOn() } })).ok).toBe(true);
    expect(evaluate(base({ now: at + 1, checkers: { hikTempAlarm: hikOn() } })).ok).toBe(false);
  });

  it('tick ล่าสุดยังใหม่ → 200 และรายงานอายุเป็นวินาที + lastResult', () => {
    const now = START + 3600 * SEC;
    const r = evaluate(base({ now, checkers: { hikTempAlarm: hikOn({ lastTickAt: now - 42 * SEC, lastResult: 'ok' }) } }));
    expect(r.ok).toBe(true);
    expect(r.body.checkers.hikTempAlarm).toEqual({ enabled: true, lastTickAgoSec: 42, lastResult: 'ok', maxAgeSec: 180 });
  });

  it('tick เก่าเกินเกณฑ์ (ค้าง/ตาย) → 503 พร้อม reason ของ checker นั้น', () => {
    const now = START + 3600 * SEC;
    const r = evaluate(base({ now, checkers: { hikTempAlarm: hikOn({ lastTickAt: now - 181 * SEC }), omadaTrafficAlert: omadaOn({ lastTickAt: now - 10 * MIN }) } }));
    expect(r.reasons).toEqual(['hik-temp-alarm-stale']);     // omada 10 นาที < 15 นาที ยังผ่าน
    const r2 = evaluate(base({ now, checkers: { omadaTrafficAlert: omadaOn({ lastTickAt: now - 16 * MIN }) } }));
    expect(r2.reasons).toEqual(['omada-traffic-alert-stale']);
  });

  it('checker ที่ปิด (หรือไม่มี) ไม่นับ แม้ไม่เคย tick เลยนานแค่ไหน', () => {
    const now = START + 7 * 24 * 3600 * SEC;
    const r = evaluate(base({ now, checkers: { hikTempAlarm: hikOn({ enabled: false }), omadaTrafficAlert: null } }));
    expect(r.ok).toBe(true);
    expect(r.body.checkers).toEqual({ hikTempAlarm: { enabled: false }, omadaTrafficAlert: { enabled: false } });
  });

  it('lastResult ที่ไม่ใช่รหัสสถานะสั้นๆ ถูกกรองเป็น null (กันข้อความ error หลุดเข้าคำตอบ)', () => {
    const now = START + 10 * SEC;
    const r = evaluate(base({ now, checkers: { hikTempAlarm: hikOn({ lastTickAt: now, lastResult: 'ต่อ 192.0.2.1 ไม่ได้ token=abc' }) } }));
    expect(r.body.checkers.hikTempAlarm.lastResult).toBeNull();
  });
});

describe('กฎ 503 ข้อ 2: LINE ล้มติดกัน', () => {
  const failing = (over = {}) => ({ ...calm, consecutive: 3, failed: 3, lastFailureAt: START + 5 * SEC, lastStatus: 500, ...over });

  it('ต่ำกว่าเกณฑ์ → 200; เท่าเกณฑ์ → 503 line-push-failing', () => {
    expect(evaluate(base({ line: failing({ consecutive: 2 }), lineFailThreshold: 3 })).ok).toBe(true);
    const r = evaluate(base({ line: failing(), lineFailThreshold: 3 }));
    expect(r.ok).toBe(false);
    expect(r.reasons).toEqual(['line-push-failing']);
  });

  it('ใช้ค่าเกณฑ์ที่ส่งมา (เช่น 6)', () => {
    expect(evaluate(base({ line: failing({ consecutive: 5 }), lineFailThreshold: 6 })).ok).toBe(true);
    expect(evaluate(base({ line: failing({ consecutive: 6 }), lineFailThreshold: 6 })).ok).toBe(false);
  });

  it('โควตาเต็ม → reason line-quota-exhausted', () => {
    expect(evaluate(base({ line: failing({ quotaExhausted: true, status429: 3 }) })).reasons).toEqual(['line-quota-exhausted']);
  });

  it('ความล้มเหลวเก่าเกินหน้าต่างเวลา → ไม่ 503 ค้าง (ไม่มีการส่งใหม่มารีเซ็ต)', () => {
    const now = START + 3 * 3600 * SEC;
    expect(evaluate(base({ now, line: failing(), lineFailWindowMin: 60 })).ok).toBe(true);
    expect(evaluate(base({ now: START + 50 * MIN, line: failing(), lineFailWindowMin: 60 })).ok).toBe(false);
  });

  it('สำเร็จหนึ่งครั้งรีเซ็ต (ผ่านตัวนับจริง) → กลับเป็น 200; 400/404 ไม่ทำให้ 503', () => {
    let t = START; const h = createLineHealth({ now: () => t });
    for (let i = 0; i < 3; i += 1) h.recordFailure(Object.assign(new Error('x'), { status: 500 }));
    expect(evaluate(base({ now: t + SEC, line: h.snapshot() })).ok).toBe(false);
    h.recordSuccess();
    expect(evaluate(base({ now: t + SEC, line: h.snapshot() })).ok).toBe(true);
    for (let i = 0; i < 20; i += 1) h.recordFailure(Object.assign(new Error('x'), { status: 400 }));
    expect(evaluate(base({ now: t + SEC, line: h.snapshot() })).ok).toBe(true);
  });

  it('หลายเหตุผลพร้อมกันรายงานครบ', () => {
    const now = START + 3600 * SEC;
    const r = evaluate(base({ now, line: failing({ lastFailureAt: now - SEC }), checkers: { hikTempAlarm: hikOn({ lastTickAt: now - 600 * SEC }) } }));
    expect(r.reasons.sort()).toEqual(['hik-temp-alarm-stale', 'line-push-failing']);
  });
});

describe('รูปแบบคำตอบ ไม่รั่วข้อมูล', () => {
  it('JSON ทั้งก้อนไม่มี IP, hex 32 ตัว, userId, ชื่อ key/secret/token — แม้ input มีของพวกนี้ปนมา', () => {
    const now = START + 3600 * SEC;
    const body = evaluate(base({
      now,
      checkers: { hikTempAlarm: hikOn({ lastTickAt: now - SEC, lastResult: 'ok', secret: 'abc', cameras: ['9001'], names: { 9001: 'ชื่อกล้อง' } }) },
      line: { ...calm, lastStatus: 500, userId: 'Ua'.padEnd(34, 'a'), ip: '192.0.2.10', token: 'tok' },
      hikBreaker: 'closed',
    })).body;
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}/);
    expect(json).not.toMatch(/[0-9a-f]{32}/i);
    expect(json).not.toMatch(/\bU[0-9a-f]{32}\b/);
    expect(json).not.toMatch(/secret|token|appkey|password|userid|camera|ชื่อกล้อง/i);
    expect(body.hikcentral).toEqual({ breaker: 'closed' });
  });

  it('มีเฉพาะอายุ(วินาที)/สถานะ/ตัวนับ และรูปร่างคงที่', () => {
    const now = START + 100 * SEC;
    const b = evaluate(base({ now, checkers: { hikTempAlarm: hikOn({ lastTickAt: now - 10 * SEC, lastResult: 'fetch-failed' }) }, line: { ...calm, lastSuccessAt: now - 20 * SEC } })).body;
    expect(Object.keys(b).sort()).toEqual(['checkers', 'line', 'reasons', 'status', 'uptimeSec']);
    expect(b.line).toEqual({ consecutiveFailures: 0, failedTotal: 0, pushTotal: 10, status429: 0, quotaExhausted: false, lastStatus: null, lastSuccessAgoSec: 20, lastFailureAgoSec: null });
    expect(b.uptimeSec).toBe(100);
  });

  it('breaker ที่ไม่ใช่รูปแบบสถานะ → ไม่ใส่ hikcentral', () => {
    expect('hikcentral' in evaluate(base({ hikBreaker: 'ต่อ 192.0.2.1 ไม่ได้' })).body).toBe(false);
    expect('hikcentral' in evaluate(base({ hikBreaker: null })).body).toBe(false);
  });
});

describe('loadConfig / tokenMatches', () => {
  it('ไม่ตั้ง token → ปิด', () => expect(loadConfig({})).toMatchObject({ enabled: false, token: '' }));
  it('token สั้นกว่า 24 → ปิด + warning ที่ไม่มีค่า token', () => {
    const c = loadConfig({ HEALTH_DEEP_TOKEN: 'a'.repeat(23) });
    expect(c.enabled).toBe(false);
    expect(c.warnings).toHaveLength(1);
    expect(JSON.stringify(c.warnings)).not.toContain('aaaa');
  });
  it('token 24 ตัวอักษรขึ้นไป → เปิด (ตัดช่องว่าง/CR หัวท้าย)', () => {
    expect(loadConfig({ HEALTH_DEEP_TOKEN: 'a'.repeat(24) }).enabled).toBe(true);
    expect(loadConfig({ HEALTH_DEEP_TOKEN: `  ${FAKE_TOKEN}\r` }).token).toBe(FAKE_TOKEN);
  });
  it('ค่าเริ่มต้นเกณฑ์: threshold 3, window 60; ค่าผิดรูปแบบ → ค่าเริ่มต้น + warning', () => {
    expect(loadConfig({})).toMatchObject({ lineFailThreshold: 3, lineFailWindowMin: 60 });
    expect(loadConfig({ HEALTH_DEEP_LINE_FAIL_THRESHOLD: '6', HEALTH_DEEP_LINE_FAIL_WINDOW_MIN: '30' })).toMatchObject({ lineFailThreshold: 6, lineFailWindowMin: 30 });
    for (const v of ['0', '101', 'abc', '2.5', '-1']) {
      const c = loadConfig({ HEALTH_DEEP_LINE_FAIL_THRESHOLD: v });
      expect(c.lineFailThreshold).toBe(3);
      expect(c.warnings).toHaveLength(1);
    }
    expect(loadConfig({ HEALTH_DEEP_LINE_FAIL_WINDOW_MIN: '1441' }).lineFailWindowMin).toBe(60);
  });
  it('tokenMatches: ถูก=true; ผิด/ว่าง/ไม่ใช่สตริง/ความยาวต่าง=false; expected ว่างไม่เคยตรง', () => {
    expect(tokenMatches(FAKE_TOKEN, FAKE_TOKEN)).toBe(true);
    for (const bad of ['', 'x', FAKE_TOKEN + 'x', FAKE_TOKEN.slice(1), undefined, null, 123, [FAKE_TOKEN]]) expect(tokenMatches(bad, FAKE_TOKEN)).toBe(false);
    expect(tokenMatches('', '')).toBe(false);
    expect(tokenMatches(undefined, '')).toBe(false);
  });
  it('tokenMatches ใช้ crypto.timingSafeEqual (ไม่ใช่ ===)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'services', 'health-deep.js'), 'utf8');
    expect(src).toMatch(/crypto\.timingSafeEqual\(/);
  });
});

// ── ผ่าน HTTP จริง (express + ตัว handler จริง) ──────────────────────────────
describe('route /health/deep (HTTP จริง)', () => {
  let server; let base_; let state; let nowMs;
  const get = (p, headers = {}) => new Promise((resolve, reject) => {
    http.get(`${base_}${p}`, { headers }, (res) => {
      let data = ''; res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
    }).on('error', reject);
  });
  const start = (cfg, { limit = 30 } = {}) => new Promise((resolve) => {
    const app = express();
    app.get('/health', (req, res) => res.json({ status: 'ok' }));
    app.get('/health/deep', rateLimit({ windowMs: 60_000, max: limit, standardHeaders: true }), createHandler({ cfg, getState: () => state, now: () => nowMs }));
    server = app.listen(0, '127.0.0.1', () => { base_ = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
  beforeEach(() => { nowMs = START + 10 * SEC; state = { startedAt: START, checkers: {}, line: calm, hikBreaker: null }; });
  afterEach((done) => { if (server) server.close(done); else done(); server = null; });

  it('ไม่ตั้ง token → 404 (ปิดเป็นค่าเริ่มต้น) แม้ส่ง header มา', async () => {
    await start(loadConfig({}));
    expect((await get('/health/deep')).status).toBe(404);
    expect((await get('/health/deep', { 'x-health-token': FAKE_TOKEN })).status).toBe(404);
  });

  it('token สั้นกว่า 24 → 404', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: 'short' }));
    expect((await get('/health/deep', { 'x-health-token': 'short' })).status).toBe(404);
  });

  it('token ผิด/ว่าง/ไม่มี header → 401 เปล่าๆ (ไม่มี body ที่บอกอะไร)', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }));
    for (const h of [{}, { 'x-health-token': '' }, { 'x-health-token': 'wrong' }, { 'x-health-token': FAKE_TOKEN + 'x' }, { authorization: `Bearer ${FAKE_TOKEN}` }]) {
      const r = await get('/health/deep', h);
      expect(r.status).toBe(401);
      expect(r.body).toBe('');
    }
  });

  it('รับ token ทาง query string ไม่ได้ (header เท่านั้น)', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }));
    expect((await get(`/health/deep?x-health-token=${FAKE_TOKEN}&token=${FAKE_TOKEN}`)).status).toBe(401);
  });

  it('token ถูก + สถานะปกติ → 200 + Cache-Control: no-store + JSON', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }));
    const r = await get('/health/deep', { 'x-health-token': FAKE_TOKEN });
    expect(r.status).toBe(200);
    expect(r.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(r.body)).toMatchObject({ status: 'ok', reasons: [] });
  });

  it('token ถูก + checker ตาย → 503 พร้อม reason; LINE ล้มติดกัน → 503', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }));
    state.checkers = { hikTempAlarm: hikOn() };
    nowMs = START + 600 * SEC;
    let r = await get('/health/deep', { 'x-health-token': FAKE_TOKEN });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body)).toMatchObject({ status: 'fail', reasons: ['hik-temp-alarm-stale'] });
    state.checkers = {};
    state.line = { ...calm, consecutive: 3, failed: 3, lastFailureAt: nowMs - SEC };
    r = await get('/health/deep', { 'x-health-token': FAKE_TOKEN });
    expect(r.status).toBe(503);
    expect(JSON.parse(r.body).reasons).toEqual(['line-push-failing']);
  });

  it('คำตอบจริงทั้งก้อนไม่มีค่า token ที่ใช้ส่ง', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }));
    const r = await get('/health/deep', { 'x-health-token': FAKE_TOKEN });
    expect(r.body).not.toContain(FAKE_TOKEN);
    expect(JSON.stringify(r.headers)).not.toContain(FAKE_TOKEN);
  });

  it('rate limit: เกิน 30 ครั้งต่อนาที → 429', async () => {
    await start(loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }), { limit: 30 });
    let last;
    for (let i = 0; i < 31; i += 1) last = await get('/health/deep', { 'x-health-token': 'wrong' });
    expect(last.status).toBe(429);
  });

  it('handler ไม่เรียก upstream: getState เป็นแหล่งข้อมูลเดียว (เรียกครั้งเดียวต่อคำขอที่ผ่าน token)', async () => {
    const getState = jest.fn(() => state);
    await new Promise((resolve) => {
      const app = express();
      app.get('/health/deep', createHandler({ cfg: loadConfig({ HEALTH_DEEP_TOKEN: FAKE_TOKEN }), getState, now: () => nowMs }));
      server = app.listen(0, '127.0.0.1', () => { base_ = `http://127.0.0.1:${server.address().port}`; resolve(); });
    });
    await get('/health/deep', { 'x-health-token': 'wrong' });
    expect(getState).not.toHaveBeenCalled();
    await get('/health/deep', { 'x-health-token': FAKE_TOKEN });
    expect(getState).toHaveBeenCalledTimes(1);
  });
});

// ── รั้วกันของเดิม: /health และ HEALTHCHECK ต้องไม่เปลี่ยน ───────────────────
describe('/health เดิมและ Docker HEALTHCHECK คงเดิม', () => {
  const root = path.join(__dirname, '..');
  const idx = fs.readFileSync(path.join(root, 'index.js'), 'utf8').replace(/\r\n/g, '\n');

  it('handler ของ /health ยังเป็นรูปเดิมทุกบรรทัด', () => {
    const original = [
      "app.get('/health', (req, res) => {",
      '  res.json({',
      "    status: 'ok',",
      "    service: 'IT Monitor Bot',",
      '    monitorsLoaded: Object.keys(enabledMonitors),',
      '    aiProvider: getActiveAiProviderName(),',
      '  });',
      '});',
    ].join('\n');
    expect(idx).toContain(original);
  });

  it('Dockerfile HEALTHCHECK ยังชี้ /health เดิม (ไม่ใช่ /health/deep)', () => {
    const df = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    expect(df).toMatch(/HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\\s*\n\s*CMD wget -qO- http:\/\/localhost:3000\/health \|\| exit 1/);
    expect(df).not.toContain('health/deep');
  });

  it('route /health/deep ผูกกับ rateLimit + createHandler และไม่ใช้ lanOnly (โดเมน tunnel จะถูก 403)', () => {
    const line = idx.split('\n').find((l) => l.startsWith("app.get('/health/deep'"));
    expect(line).toMatch(/rateLimit\(\{ windowMs: 60_000, max: 30,/);
    expect(line).toMatch(/healthDeep\.createHandler\(\{/);
    expect(line).not.toMatch(/lanOnly/);
  });
});
