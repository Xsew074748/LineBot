'use strict';
// cache กล้องดับ (คำสั่ง "กล้องดับ"): cache ว่าง + ดึงสดล้ม → ต้องรู้ว่า "ดึงไม่ได้" ไม่ใช่ตอบว่า 0 ตัว
// เดิม index.js กลืน error แล้วตกไปใช้ { total: 0 } ทำให้ผู้ใช้เห็น "ไม่มีกล้องดับ" ทั้งที่ไม่รู้สถานะ

const { createOfflineCameraCache } = require('../services/offline-camera-cache');

const mkLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const timeoutErr = () => Object.assign(new Error('timeout of 15000ms exceeded'), { code: 'ECONNABORTED' });
const refusedErr = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });

describe('createOfflineCameraCache()', () => {
  it('ดึงสำเร็จ → เก็บ raw และ ensure() คืน raw + อายุ (นาที)', async () => {
    let t = 1_000_000;
    const raw = { total: 3, allOffline: [], groups: [], clockMap: {} };
    const c = createOfflineCameraCache({ fetchRaw: async () => raw, logger: mkLogger(), now: () => t });
    expect(await c.refresh()).toBe(true);
    t += 5 * 60_000;
    expect(await c.ensure()).toEqual({ raw, ageMin: 5 });
  });

  it('cache ว่าง + ดึงสดล้ม (ไม่ใช่ timeout) → ensure() คืน null (ไม่ใช่ศูนย์) และ log ERROR', async () => {
    const logger = mkLogger();
    const c = createOfflineCameraCache({ fetchRaw: async () => { throw refusedErr(); }, logger });
    expect(await c.ensure()).toBeNull();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('offline camera refresh failed'), expect.anything());
  });

  it('cache ว่าง + ดึงสด timeout → ensure() คืน null และ warn บอกว่ายังไม่มี cache', async () => {
    const logger = mkLogger();
    const c = createOfflineCameraCache({ fetchRaw: async () => { throw timeoutErr(); }, logger });
    expect(await c.ensure()).toBeNull();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cached total=none'));
  });

  it('มี cache แล้วรอบถัดไป timeout → ใช้ cache เดิมต่อ (ไม่ล้าง) และ warn ระบุ total ที่ค้าง', async () => {
    let t = 0;
    const logger = mkLogger();
    const fetchRaw = jest.fn()
      .mockResolvedValueOnce({ total: 4 })
      .mockRejectedValueOnce(timeoutErr());
    const c = createOfflineCameraCache({ fetchRaw, logger, now: () => t });
    await c.refresh();
    t = 12 * 60_000;
    expect(await c.refresh()).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('cached total=4'));
    expect(await c.ensure()).toEqual({ raw: { total: 4 }, ageMin: 12 });
    expect(fetchRaw).toHaveBeenCalledTimes(2);       // ensure() ไม่ยิงซ้ำเมื่อมี cache
  });

  it('มี cache แล้วรอบถัดไปล้มแบบอื่น → ยังคง cache เดิม (ไม่ถูกแทนด้วยศูนย์)', async () => {
    const fetchRaw = jest.fn().mockResolvedValueOnce({ total: 2 }).mockRejectedValueOnce(refusedErr());
    const c = createOfflineCameraCache({ fetchRaw, logger: mkLogger() });
    await c.refresh();
    expect(await c.refresh()).toBe(false);
    expect((await c.ensure()).raw).toEqual({ total: 2 });
  });

  it('ดึงได้ total=0 จริง → เป็นผลสำเร็จ (ไม่ใช่ null) แยกจากกรณีดึงไม่ได้', async () => {
    const c = createOfflineCameraCache({ fetchRaw: async () => ({ total: 0, allOffline: [] }), logger: mkLogger() });
    const got = await c.ensure();
    expect(got).not.toBeNull();
    expect(got.raw.total).toBe(0);
  });

  it('ensure() ครั้งแรกที่ cache ว่างจะดึงสด 1 ครั้ง; ล้ม → ครั้งถัดไปลองใหม่อีก', async () => {
    const fetchRaw = jest.fn().mockRejectedValueOnce(refusedErr()).mockResolvedValueOnce({ total: 1 });
    const c = createOfflineCameraCache({ fetchRaw, logger: mkLogger() });
    expect(await c.ensure()).toBeNull();
    expect((await c.ensure()).raw).toEqual({ total: 1 });
    expect(fetchRaw).toHaveBeenCalledTimes(2);
  });
});

// index.js เปิดเซิร์ฟเวอร์ตอน require จึงทดสอบพฤติกรรมตรงๆ ไม่ได้ — ตรวจรูปแบบซอร์สของจุดที่ต่อ helper เข้ากับคำสั่ง
describe('index.js — คำสั่ง "กล้องดับ" และข้อความบริบท host ต่อกับ helper ถูกจุด', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');

  it('กล้องดับ: ใช้ ensure() และตอบ buildError เมื่อได้ null (ไม่มีทางตกไปเป็น total: 0)', () => {
    expect(src).toMatch(/const cached = await offlineCamCache\.ensure\(\);\s*\n\s*if \(!cached\) return reply\(replyToken, fmt\.buildError\(/);
    expect(src).not.toMatch(/raw:\s*\{\s*allOffline:\s*\[\],\s*total:\s*0/);
    expect(src).not.toMatch(/offlineCamCache\.raw\s*\|\|/);
  });

  it('คำสั่ง host: ข้อความบริบท AI สร้างจาก buildHostContextText ไม่ใช่การนับ available !== 1 เอง', () => {
    expect(src).toMatch(/const hostCtxText = buildHostContextText\(hosts\);/);
    expect(src).not.toMatch(/hosts\.filter\(\(h\) => h\.available !== 1\)/);
  });

  it('error body ของ LINE ใน reply()/push() ผ่าน redact ก่อนลง log', () => {
    expect(src).not.toMatch(/LINE error body=\$\{err2?\.body\}/);
    expect((src.match(/LINE error body=\$\{redact\(err2?\.body\)\}/g) || []).length).toBe(4);
  });
});

// ── index.js ต้องไม่ส่ง error object ดิบให้ logger อีก (ก่อนแก้มี 10 จุด) ──
describe('index.js — logger ไม่รับ error object ดิบ', () => {
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n');
  const raw = src.split('\n').filter((l) => /logger\.(error|warn)\(.*,\s*(err[0-9]?|e|error)\s*\)/.test(l));

  it('ไม่เหลือจุดที่ส่ง err / err2 / err3 ดิบให้ logger.error/warn', () => {
    expect(raw).toEqual([]);
  });

  it('ใช้ safeError ห่อแทนอย่างน้อย 10 จุด และนำเข้าจาก services/send-error', () => {
    expect(src).toMatch(/require\('\.\/services\/send-error'\)/);
    expect((src.match(/safeError\(/g) || []).length).toBeGreaterThanOrEqual(10);
  });
});
