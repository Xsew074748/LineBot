'use strict';
// line-health: นับผลการส่ง LINE push ต่อ "การส่งหนึ่งครั้ง" (หลัง retry) — consecutive นับเฉพาะความล้มเหลวเชิงระบบ
// ไม่ต่อ LINE จริง: ไคลเอนต์จริงของ SDK ใช้กับ fetch ปลอม; ค่า token/userId ทั้งหมดเป็นค่าปลอม

const line = require('@line/bot-sdk');
const { createLineHealth, isSystemic, isQuota } = require('../services/line-health');

const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const httpErr = (status, body = '') => Object.assign(new Error(`HTTP ${status}`), { status, body });
const FAKE_USER = `U${'0123456789abcdef'.repeat(2)}`;

let t; let h; let logger;
beforeEach(() => { t = 1_700_000_000_000; logger = silent(); h = createLineHealth({ now: () => t, logger }); });

describe('consecutive', () => {
  it('ล้มเชิงระบบติดกันนับขึ้น และสำเร็จหนึ่งครั้งรีเซ็ตเป็น 0', () => {
    for (const e of [new Error('ETIMEDOUT'), httpErr(500), httpErr(503)]) h.recordFailure(e);
    expect(h.snapshot()).toMatchObject({ consecutive: 3, failed: 3, total: 3 });
    h.recordSuccess();
    expect(h.snapshot()).toMatchObject({ consecutive: 0, failed: 3, total: 4 });
  });

  it.each([[undefined, 'ไม่มี status (เครือข่าย/timeout)'], [429, '429'], [401, '401'], [403, '403'], [500, '500'], [503, '503']])(
    'ความล้มเหลวเชิงระบบ: %s (%s) ทำให้ consecutive ขึ้น',
    (status) => {
      h.recordFailure(status === undefined ? new Error('network') : httpErr(status));
      expect(h.snapshot().consecutive).toBe(1);
    });

  it.each([400, 404, 409, 413, 422])('%i ของผู้ใช้รายคนไม่ทำให้ consecutive ขึ้น (แต่นับใน failed)', (status) => {
    h.recordFailure(httpErr(status));
    expect(h.snapshot()).toMatchObject({ consecutive: 0, failed: 1, lastStatus: status });
  });

  it('400/404 ไม่รีเซ็ต consecutive ที่สะสมไว้ (เป็นกลาง) และไม่เพิ่มด้วย', () => {
    h.recordFailure(httpErr(503)); h.recordFailure(httpErr(503));
    h.recordFailure(httpErr(400)); h.recordFailure(httpErr(404));
    expect(h.snapshot()).toMatchObject({ consecutive: 2, failed: 4 });
  });

  it('error แปลกๆ (null/undefined/ไม่มี status) ไม่โยน และนับเป็นเครือข่าย', () => {
    expect(() => { h.recordFailure(null); h.recordFailure(undefined); h.recordFailure({}); h.recordFailure('x'); }).not.toThrow();
    expect(h.snapshot()).toMatchObject({ consecutive: 4, lastStatus: 'network' });
  });
});

describe('429 / โควตาเต็ม', () => {
  it('429 นับแยกใน status429 (และเป็นความล้มเหลวเชิงระบบ)', () => {
    h.recordFailure(httpErr(429, '{"message":"rate limit"}'));
    h.recordFailure(httpErr(500));
    expect(h.snapshot()).toMatchObject({ status429: 1, consecutive: 2, quotaExhausted: false });
  });

  it('429 ที่ body บอก monthly limit/quota → quotaExhausted; สำเร็จแล้วล้างค่า', () => {
    h.recordFailure(httpErr(429, '{"message":"You have reached your monthly limit."}'));
    expect(h.snapshot()).toMatchObject({ status429: 1, quotaExhausted: true });
    h.recordSuccess();
    expect(h.snapshot().quotaExhausted).toBe(false);
  });

  it('isQuota: เฉพาะ 429 + ข้อความที่เข้ากับโควตา; 500 ที่มีคำว่า quota ไม่ใช่', () => {
    expect(isQuota(httpErr(429, 'monthly limit'))).toBe(true);
    expect(isQuota(httpErr(429, 'Too many requests'))).toBe(false);
    expect(isQuota(httpErr(500, 'quota'))).toBe(false);
  });

  it('isSystemic: ตารางสถานะ', () => {
    expect([undefined, 429, 401, 403, 500, 502].every((s) => isSystemic(s === undefined ? {} : { status: s }))).toBe(true);
    expect([400, 404, 409].some((s) => isSystemic({ status: s }))).toBe(false);
  });
});

describe('เวลาและ log', () => {
  it('เก็บเวลาสำเร็จ/ล้มเหลวล่าสุด', () => {
    h.recordSuccess(); t += 5000; h.recordFailure(httpErr(500));
    expect(h.snapshot()).toMatchObject({ lastSuccessAt: 1_700_000_000_000, lastFailureAt: 1_700_000_005_000 });
  });

  it('log เฉพาะตอนเปลี่ยนสถานะ ไม่ log ทุกครั้ง และไม่มี body/userId/ข้อความ error', () => {
    for (let i = 0; i < 5; i += 1) h.recordFailure(httpErr(500, `body ของ ${FAKE_USER}`));
    h.recordSuccess();
    expect(logger.warn).toHaveBeenCalledTimes(1);   // เริ่มนับล้มติดกัน
    expect(logger.info).toHaveBeenCalledTimes(1);   // กลับมาปกติ
    const all = JSON.stringify([logger.warn.mock.calls, logger.info.mock.calls]);
    expect(all).not.toContain(FAKE_USER);
    expect(all).not.toContain('body ของ');
  });

  it('logger พังไม่กระทบการนับ', () => {
    const bad = { warn() { throw new Error('x'); }, info() { throw new Error('x'); } };
    const hh = createLineHealth({ now: () => t, logger: bad });
    expect(() => { hh.recordFailure(httpErr(500)); hh.recordSuccess(); }).not.toThrow();
    expect(hh.snapshot().total).toBe(2);
  });
});

describe('track()', () => {
  it('คืนผลเดิม นับสำเร็จหนึ่งครั้ง และส่งอาร์กิวเมนต์ต่อ', async () => {
    const fn = jest.fn().mockResolvedValue({ ok: 1 });
    expect(await h.track(fn)('a', 'b')).toEqual({ ok: 1 });
    expect(fn).toHaveBeenCalledWith('a', 'b');
    expect(h.snapshot()).toMatchObject({ total: 1, failed: 0 });
  });

  it('error: นับล้มเหลวหนึ่งครั้ง แล้วโยน error เดิมต่อ (ผู้เรียกจัดการเอง)', async () => {
    const err = httpErr(500);
    await expect(h.track(() => Promise.reject(err))()).rejects.toBe(err);
    expect(h.snapshot()).toMatchObject({ total: 1, failed: 1, consecutive: 1 });
  });

  it('ฟังก์ชันที่โยนแบบ synchronous ก็นับและโยนต่อ', async () => {
    await expect(h.track(() => { throw httpErr(503); })()).rejects.toThrow('HTTP 503');
    expect(h.snapshot().consecutive).toBe(1);
  });
});

describe('ใช้กับไคลเอนต์จริงของ LINE SDK + fetch ปลอม', () => {
  let realFetch; let calls;
  const respond = (status, body = '{}') => jest.fn(async (url) => { calls.push(String(url)); return new Response(body, { status, headers: { 'content-type': 'application/json' } }); });
  const client = () => new line.messagingApi.MessagingApiClient({ channelAccessToken: 'FAKE-TOKEN-FOR-TEST-ONLY' });
  beforeEach(() => { realFetch = global.fetch; calls = []; });
  afterEach(() => { global.fetch = realFetch; });

  it('push สำเร็จผ่าน track → นับสำเร็จ; replyMessage ไม่ถูกนับ (ไม่ครอบ)', async () => {
    global.fetch = respond(200);
    const c = client();
    const send = h.track((to, message) => c.pushMessage({ to, messages: [message] }));
    await send('Utest', { type: 'text', text: 'x' });
    await c.replyMessage({ replyToken: 'fake-reply-token', messages: [{ type: 'text', text: 'y' }] });
    expect(calls.some((u) => u.includes('/message/push'))).toBe(true);
    expect(calls.some((u) => u.includes('/message/reply'))).toBe(true);
    expect(h.snapshot()).toMatchObject({ total: 1, failed: 0 }); // นับเฉพาะ push
  });

  it('SDK จริงโยน HTTPFetchError ที่มี status/body: 429+โควตา, 400 (เป็นกลาง), 500, และเครือข่ายขาด', async () => {
    const c = client();
    const send = h.track((to, message) => c.pushMessage({ to, messages: [message] }));
    global.fetch = respond(429, '{"message":"You have reached your monthly limit."}');
    await expect(send('Utest', { type: 'text', text: 'x' })).rejects.toMatchObject({ status: 429 });
    expect(h.snapshot()).toMatchObject({ status429: 1, quotaExhausted: true, consecutive: 1 });
    global.fetch = respond(400, '{"message":"The request body has 1 error(s)"}');
    await expect(send('Utest', { type: 'text', text: 'x' })).rejects.toMatchObject({ status: 400 });
    expect(h.snapshot()).toMatchObject({ consecutive: 1, failed: 2 }); // 400 ไม่เพิ่ม
    global.fetch = respond(500);
    await expect(send('Utest', { type: 'text', text: 'x' })).rejects.toMatchObject({ status: 500 });
    expect(h.snapshot().consecutive).toBe(2);
    global.fetch = jest.fn(async () => { throw new TypeError('fetch failed'); });
    await expect(send('Utest', { type: 'text', text: 'x' })).rejects.toBeDefined();
    expect(h.snapshot()).toMatchObject({ consecutive: 3, lastStatus: 'network' });
    global.fetch = respond(200);
    await send('Utest', { type: 'text', text: 'x' });
    expect(h.snapshot()).toMatchObject({ consecutive: 0, quotaExhausted: false });
  });
});
