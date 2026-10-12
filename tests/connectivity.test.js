'use strict';
// สถานะการเชื่อมต่อออฟฟิศ: ok / degraded (บางระบบล้ม) / unreachable (ทุกระบบที่เปิดใช้ล้มต่อเนื่อง >= เกณฑ์ ค่าเริ่มต้น 10 นาที)
// บันทึกจากผลการเรียก API ที่มีอยู่แล้ว (ไม่เพิ่มการเรียกเครือข่าย) — "ล้ม" = ติดต่อระบบไม่ถึง (timeout/refused/unreachable/ไม่มี response)
// ระบบที่ตอบกลับมาแล้ว (แม้เป็น 401/500) = ติดต่อถึง ไม่ใช่ปัญหาการเชื่อมต่อ

const {
  createConnectivity, isUnreachableError, loadThresholdMin, DEFAULT_UNREACHABLE_MIN, SYSTEMS,
} = require('../services/connectivity');

const MIN = 60_000;
let t;
const clock = () => t;
const mk = (opts = {}) => { t = Date.UTC(2026, 9, 12, 3, 0, 0); return createConnectivity({ now: clock, ...opts }); };
const advance = (min) => { t += min * MIN; };
const netErr = (code = 'ECONNABORTED') => Object.assign(new Error('timeout'), { isAxiosError: true, code });
const httpErr = (status) => Object.assign(new Error('http ' + status), { isAxiosError: true, response: { status } });

describe('isUnreachableError()', () => {
  it.each(['ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE'])('รหัสเครือข่าย %s = ติดต่อไม่ถึง (error ธรรมดาที่มีแค่ code — ไม่พึ่งกฎ axios ไม่มี response)', (code) => {
    expect(isUnreachableError(Object.assign(new Error('x'), { code }))).toBe(true);
    expect(isUnreachableError(netErr(code))).toBe(true);
  });

  it('axios error ที่ไม่มี response (ไม่มีรหัส) = ติดต่อไม่ถึง', () => {
    expect(isUnreachableError(Object.assign(new Error('Network Error'), { isAxiosError: true }))).toBe(true);
  });

  it('มี response (401/403/404/500/503) = ติดต่อถึงแล้ว ไม่ใช่ปัญหาเครือข่าย', () => {
    for (const s of [400, 401, 403, 404, 429, 500, 503]) expect(isUnreachableError(httpErr(s))).toBe(false);
  });

  it('error ของ API เอง (Error ธรรมดา เช่น Zabbix API Error / artemis code != 0) = ติดต่อถึง', () => {
    expect(isUnreachableError(new Error('Zabbix API Error [-32602]: Invalid params'))).toBe(false);
  });

  it('circuit breaker เปิด = ถือว่ายังติดต่อไม่ถึง (ไม่รีเซ็ตสตรีคที่ล้มอยู่)', () => {
    expect(isUnreachableError(Object.assign(new Error('circuit open'), { name: 'CircuitOpenError' }))).toBe(true);
  });

  it('ค่าแปลก (null/undefined/string) ไม่ throw และไม่ถือเป็นติดต่อไม่ถึง', () => {
    for (const v of [null, undefined, 'x', 42, {}]) expect(() => isUnreachableError(v)).not.toThrow();
    expect(isUnreachableError(null)).toBe(false);
  });
});

describe('loadThresholdMin()', () => {
  it('ค่าเริ่มต้น 10 นาที; รับ 1–1440; ค่าผิดรูปแบบ → ค่าเริ่มต้น', () => {
    expect(DEFAULT_UNREACHABLE_MIN).toBe(10);
    expect(loadThresholdMin({})).toBe(10);
    expect(loadThresholdMin({ CONNECTIVITY_UNREACHABLE_MIN: '15' })).toBe(15);
    expect(loadThresholdMin({ CONNECTIVITY_UNREACHABLE_MIN: '1' })).toBe(1);
    expect(loadThresholdMin({ CONNECTIVITY_UNREACHABLE_MIN: '1440' })).toBe(1440);
    for (const bad of ['0', '-5', '1441', 'abc', '', '2.5']) expect(loadThresholdMin({ CONNECTIVITY_UNREACHABLE_MIN: bad })).toBe(10);
  });
});

describe('createConnectivity() — state machine', () => {
  it('ยังไม่มีข้อมูล / ไม่มีระบบที่เปิดใช้ → ok', () => {
    const c = mk();
    expect(c.snapshot().state).toBe('ok');
    c.setEnabled([]);
    c.record('zabbix', false, netErr());
    expect(c.snapshot()).toMatchObject({ state: 'ok', since: null, minutes: 0 });
  });

  it('สำเร็จทุกระบบ → ok และบันทึกเวลาสำเร็จล่าสุด', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada', 'hikcentral']);
    for (const s of SYSTEMS) c.record(s, true);
    advance(5);
    const snap = c.snapshot();
    expect(snap.state).toBe('ok');
    expect(snap.systems.zabbix).toMatchObject({ ok: true, lastOkAgoSec: 300, failingMinutes: 0 });
  });

  it('ล้มระบบเดียวจาก 3 นานแค่ไหนก็เป็น degraded ไม่ใช่ unreachable', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada', 'hikcentral']);
    c.record('omada', true); c.record('hikcentral', true);
    c.record('zabbix', false, netErr());
    advance(600);
    c.record('omada', true); c.record('hikcentral', true); c.record('zabbix', false, netErr());
    const s = c.snapshot();
    expect(s.state).toBe('degraded');
    expect(s.minutes).toBe(600);
    expect(s.failing).toEqual(['zabbix']);
  });

  it('ล้มครบทุกระบบแต่ยังไม่ถึงเกณฑ์ → degraded; ถึงเกณฑ์ (10 นาทีพอดี) → unreachable', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada', 'hikcentral']);
    for (const s of SYSTEMS) c.record(s, false, netErr());
    t += 9 * MIN + 59_000;                         // 9 นาที 59 วินาที (คำนวณเป็นมิลลิวินาทีล้วน กัน float)
    expect(c.snapshot().state).toBe('degraded');
    t += 1_000;                                    // ครบ 10 นาทีพอดี
    expect(c.snapshot().state).toBe('unreachable');
  });

  it('unreachable: since = เวลาที่ "ระบบสุดท้าย" เริ่มล้ม (ทั้งหมดล้มมาตั้งแต่ตอนนั้น) และ minutes นับจากนั้น', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada']);
    c.record('zabbix', false, netErr());          // t0
    advance(5);
    c.record('omada', false, netErr());           // t0+5
    advance(12);
    const s = c.snapshot();
    expect(s.state).toBe('unreachable');
    expect(s.minutes).toBe(12);
    expect(s.since).toBe(new Date(Date.UTC(2026, 9, 12, 3, 5, 0)).toISOString());
  });

  it('degraded: since = ระบบที่ล้มเก่าสุด', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada', 'hikcentral']);
    c.record('zabbix', false, netErr());
    advance(3);
    c.record('omada', false, netErr());
    advance(2);
    const s = c.snapshot();
    expect(s.state).toBe('degraded');
    expect(s.minutes).toBe(5);
    expect(s.since).toBe(new Date(Date.UTC(2026, 9, 12, 3, 0, 0)).toISOString());
  });

  it('ล้มซ้ำไม่ขยับ "ล้มต่อเนื่องตั้งแต่" (เก็บเวลาเริ่มสตรีค)', () => {
    const c = mk(); c.setEnabled(['zabbix']);
    c.record('zabbix', false, netErr());
    advance(7);
    c.record('zabbix', false, netErr());
    advance(7);
    c.record('zabbix', false, netErr());
    expect(c.snapshot().systems.zabbix.failingMinutes).toBe(14);
  });

  it('สำเร็จครั้งเดียวรีเซ็ตสตรีค (กลับเป็น ok) และเริ่มนับใหม่เมื่อล้มรอบถัดไป', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada']);
    c.record('zabbix', false, netErr()); c.record('omada', false, netErr());
    advance(30);
    expect(c.snapshot().state).toBe('unreachable');
    c.record('zabbix', true); c.record('omada', true);
    expect(c.snapshot()).toMatchObject({ state: 'ok', since: null, minutes: 0 });
    advance(5);
    c.record('zabbix', false, netErr());
    advance(2);
    expect(c.snapshot().systems.zabbix.failingMinutes).toBe(2);   // ไม่ใช่ 37
  });

  it('unreachable → ระบบหนึ่งกลับมา → degraded (ไม่ค้างเป็น unreachable)', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada']);
    c.record('zabbix', false, netErr()); c.record('omada', false, netErr());
    advance(20);
    c.record('omada', true);
    expect(c.snapshot().state).toBe('degraded');
  });

  it('ระบบที่ตอบกลับ (401/500) ถือว่าติดต่อถึง: ไม่นับเป็นล้มต่อเนื่อง', () => {
    const c = mk(); c.setEnabled(['zabbix']);
    c.record('zabbix', false, netErr());
    advance(3);
    c.record('zabbix', false, httpErr(401));
    expect(c.snapshot().state).toBe('ok');
  });

  it('นับเฉพาะระบบที่เปิดใช้: ระบบที่ไม่ได้เปิดล้มไม่ทำให้ unreachable/degraded; ชื่อระบบแปลกถูกเมิน', () => {
    const c = mk(); c.setEnabled(['zabbix']);
    c.record('omada', false, netErr());
    c.record('mystery', false, netErr());
    expect(c.snapshot().state).toBe('ok');
    c.record('zabbix', false, netErr());
    advance(11);
    expect(c.snapshot().state).toBe('unreachable');    // zabbix เป็นระบบเดียวที่เปิด และล้มทั้งหมด
  });

  it('ระบบที่ยังไม่เคยมีผลการเรียกเลย ไม่ถูกนับว่าล้ม แต่ก็ไม่ถูกนับว่าสำเร็จ (ไม่ทำให้ unreachable)', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada']);
    c.record('zabbix', false, netErr());
    advance(30);
    expect(c.snapshot().state).toBe('degraded');       // omada ยังไม่มีข้อมูล → ไม่ใช่ "ทุกระบบล้ม"
  });

  it('เกณฑ์ปรับได้ (threshold) และนาฬิกาเดินถอยหลังไม่ทำให้ minutes ติดลบ', () => {
    const c = mk({ thresholdMin: 3 }); c.setEnabled(['zabbix']);
    c.record('zabbix', false, netErr());
    advance(3);
    expect(c.snapshot().state).toBe('unreachable');
    t -= 10 * MIN;
    expect(c.snapshot().minutes).toBe(0);
  });
});

describe('minutes ปัดลงเสมอ (floor) ไม่ปัดขึ้น', () => {
  it('ล้มมา 1 นาที 30 วินาที = 1 นาที (ไม่ใช่ 2) ทั้งรายระบบและรวม', () => {
    const c = mk(); c.setEnabled(['zabbix', 'omada', 'hikcentral']);
    c.record('zabbix', false, netErr());
    t += 90_000;
    const s = c.snapshot();
    expect(s.systems.zabbix.failingMinutes).toBe(1);
    expect(s.minutes).toBe(1);
  });

  it('ล้มมา 59 วินาที = 0 นาที', () => {
    const c = mk(); c.setEnabled(['zabbix']);
    c.record('zabbix', false, netErr());
    t += 59_000;
    expect(c.snapshot().minutes).toBe(0);
  });
});

describe('snapshot / publicView — ไม่มีที่อยู่ในผลลัพธ์', () => {
  const c0 = () => { const c = mk(); c.setEnabled(['zabbix', 'omada', 'hikcentral']); for (const s of SYSTEMS) c.record(s, false, Object.assign(netErr(), { message: 'connect ECONNREFUSED 192.0.2.10:8443 http://zabbix.example.test/api' })); advance(15); return c; };

  it('publicView มีแค่ state / since / minutes', () => {
    const v = c0().publicView();
    expect(Object.keys(v).sort()).toEqual(['minutes', 'since', 'state']);
    expect(v.state).toBe('unreachable');
    expect(v.minutes).toBe(15);
  });

  it('snapshot ทั้งก้อนไม่มี IP / hostname / ข้อความ error แม้ error ดิบจะมีที่อยู่', () => {
    const json = JSON.stringify(c0().snapshot());
    expect(json).not.toMatch(/192\.0\.2/);
    expect(json).not.toMatch(/example\.test/);
    expect(json).not.toMatch(/ECONNREFUSED/);
    expect(json).not.toMatch(/http:/);
  });

  it('คีย์ของระบบเป็นชื่อมาตรฐานเท่านั้น (zabbix / omada / hikcentral)', () => {
    const snap = c0().snapshot();
    expect(Object.keys(snap.systems).sort()).toEqual(['hikcentral', 'omada', 'zabbix']);
    for (const s of Object.values(snap.systems)) expect(Object.keys(s).sort()).toEqual(['failingMinutes', 'lastOkAgoSec', 'ok']);
  });
});
