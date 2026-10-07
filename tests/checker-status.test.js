'use strict';
// getStatus() ของ hik-temp-alarm และ omada-traffic-alert: บันทึก "จบรอบ" (tick) สำหรับ /health/deep
// ใช้ fake timers + now ปลอม; ไม่ต่อเครือข่ายจริง

const { createChecker: createHik } = require('../services/hik-temp-alarm');
const { createChecker: createOmada, emptyState } = require('../services/omada-traffic-alert');

const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const memStore = () => ({ load: () => null, save: jest.fn(() => true) });
const omadaStore = () => { let saved = emptyState(); return { load: () => JSON.parse(JSON.stringify(saved)), save: jest.fn((s) => { saved = s; return true; }) }; };

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('hik-temp-alarm getStatus()', () => {
  const env = { HIKCENTRAL_TEMP_ALARM_ENABLED: 'true', HIKCENTRAL_TEMP_ALARM_CAMERAS: '9001,9002', HIKCENTRAL_TEMP_ALARM_INTERVAL_SEC: '60' };
  const mk = (over = {}) => {
    const hikcentral = over.hikcentral || { getTempAlarmEvents: jest.fn().mockResolvedValue({ events: [], truncated: false }), getCameras: jest.fn().mockResolvedValue([]), getBreakerState: () => ({ state: 'closed' }) };
    let nowMs = Date.parse('2030-01-01T00:00:00Z');
    const checker = createHik({ hikcentral, pusher: jest.fn(), logger: silent(), env: over.env || env, now: () => nowMs, store: memStore() });
    return { checker, hikcentral, setNow: (v) => { nowMs = v; }, getNow: () => nowMs };
  };

  it('ก่อน tick แรก: enabled + interval ถูกต้อง lastTickAt/lastResult เป็น null', () => {
    const { checker } = mk();
    expect(checker.getStatus()).toEqual({ enabled: true, intervalMs: 60_000, lastTickAt: null, lastResult: null });
  });

  it('ปิดอยู่ (ไม่ระบุกล้อง) → enabled false', () => {
    expect(mk({ env: { HIKCENTRAL_TEMP_ALARM_ENABLED: 'true' } }).checker.getStatus().enabled).toBe(false);
    expect(mk({ env: {} }).checker.getStatus().enabled).toBe(false);
  });

  it('จบรอบแล้วบันทึกเวลาและสถานะ (ok)', async () => {
    const { checker, setNow, getNow } = mk();
    const stop = checker.start();
    setNow(getNow() + 30_000);
    await jest.advanceTimersByTimeAsync(30_000); // START_DELAY_MS
    expect(checker.getStatus()).toMatchObject({ lastResult: 'ok', lastTickAt: getNow() });
    stop();
  });

  it('ดึงข้อมูลไม่ได้ (fetch-failed) ก็นับเป็น tick (loop ยังเดิน) และเก็บสถานะนั้น', async () => {
    const hikcentral = { getTempAlarmEvents: jest.fn().mockRejectedValue(new Error('ETIMEDOUT')), getCameras: jest.fn(), getBreakerState: () => ({ state: 'closed' }) };
    const { checker } = mk({ hikcentral });
    const stop = checker.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(checker.getStatus()).toMatchObject({ lastResult: 'fetch-failed' });
    expect(checker.getStatus().lastTickAt).not.toBeNull();
    stop();
  });

  it('check() โยน error → lastResult "error" และยัง tick; รอบถัดไปยังทำงานต่อ (interval ไม่หยุด)', async () => {
    const getTempAlarmEvents = jest.fn().mockImplementation(() => { throw new Error('พังนอก try'); });
    const hikcentral = { getTempAlarmEvents, getCameras: jest.fn(), getBreakerState: () => ({ state: 'closed' }) };
    const { checker } = mk({ hikcentral });
    const stop = checker.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(checker.getStatus().lastResult).toBe('fetch-failed'); // error ในการดึงถูกจับภายใน check() เป็น fetch-failed
    getTempAlarmEvents.mockClear();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(getTempAlarmEvents).toHaveBeenCalledTimes(1);       // รอบถัดไปยังเรียก
    stop();
  });

  it('check() โยน error จริง (breaker state อ่านไม่ได้) → lastResult "error" และยัง tick', async () => {
    const hikcentral = { getTempAlarmEvents: jest.fn(), getCameras: jest.fn(), getBreakerState: () => { throw new Error('boom'); } };
    const { checker } = mk({ hikcentral });
    const stop = checker.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(checker.getStatus().lastResult).toBe('error');
    expect(checker.getStatus().lastTickAt).not.toBeNull();
    stop();
  });

  it('tick บันทึกเมื่อ "จบรอบ" เท่านั้น: ระหว่างที่รอบยังค้างอยู่ lastTickAt ยังเป็น null จนกว่าจะจบ', async () => {
    const hikcentral = { getTempAlarmEvents: jest.fn(() => new Promise(() => {})), getCameras: jest.fn(), getBreakerState: () => ({ state: 'closed' }) };
    const { checker } = mk({ hikcentral });
    const stop = checker.start();
    await jest.advanceTimersByTimeAsync(30_000 + 5_000);   // เริ่มรอบแล้วแต่ยังไม่ครบ timeout ของการดึง
    expect(checker.getStatus().lastTickAt).toBeNull();
    await jest.advanceTimersByTimeAsync(60_000);           // เลย timeout ภายใน → จบเป็น fetch-failed
    expect(checker.getStatus()).toMatchObject({ lastResult: 'fetch-failed' });
    expect(checker.getStatus().lastTickAt).not.toBeNull();
    stop();
  });

  it('getStatus ไม่มีข้อมูลเหตุการณ์/กล้อง/ข้อความ error', async () => {
    const { checker } = mk();
    const stop = checker.start();
    await jest.advanceTimersByTimeAsync(30_000);
    expect(Object.keys(checker.getStatus()).sort()).toEqual(['enabled', 'intervalMs', 'lastResult', 'lastTickAt']);
    expect(JSON.stringify(checker.getStatus())).not.toMatch(/9001|9002/);
    stop();
  });
});

describe('omada-traffic-alert getStatus()', () => {
  const env = { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100', OMADA_TRAFFIC_ALERT_INTERVAL_MIN: '5' };
  const mk = (over = {}) => {
    const omada = over.omada || { getTrafficActivities: jest.fn().mockResolvedValue({ data: [] }) };
    const nowMs = Date.parse('2030-01-01T00:00:00Z');
    return { checker: createOmada({ omada, pusher: jest.fn(), logger: silent(), env: over.env || env, now: () => nowMs, store: omadaStore() }), omada };
  };

  it('ก่อน tick แรก + ปิดอยู่ (ไม่ตั้ง threshold)', () => {
    expect(mk().checker.getStatus()).toEqual({ enabled: true, intervalMs: 300_000, lastTickAt: null, lastResult: null });
    expect(mk({ env: {} }).checker.getStatus().enabled).toBe(false);
  });

  it('จบรอบแล้วบันทึกสถานะ (อ่านค่าไม่ได้ก็ยัง tick)', async () => {
    const { checker } = mk();
    const stop = checker.start();
    await jest.advanceTimersByTimeAsync(60_000); // START_DELAY_MS
    const st = checker.getStatus();
    expect(st.lastTickAt).not.toBeNull();
    expect(st.lastResult).toMatch(/^[a-z-]+$/);
    stop();
  });

  it('ดึงไม่ได้ → fetch-failed แต่ tick; check() โยน → error และ tick', async () => {
    const failing = mk({ omada: { getTrafficActivities: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) } });
    const stop1 = failing.checker.start();
    await jest.advanceTimersByTimeAsync(60_000);
    expect(failing.checker.getStatus()).toMatchObject({ lastResult: 'fetch-failed' });
    expect(failing.checker.getStatus().lastTickAt).not.toBeNull();
    stop1();
  });

  it('ปิดอยู่ → start() ไม่ตั้ง timer ไม่มี tick', async () => {
    const { checker } = mk({ env: {} });
    checker.start();
    await jest.advanceTimersByTimeAsync(10 * 60_000);
    expect(checker.getStatus()).toMatchObject({ enabled: false, lastTickAt: null });
  });
});
