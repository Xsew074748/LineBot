'use strict';
// ops-alert: แจ้ง ADMIN เท่านั้น, cooldown ต่อ key (เก็บในไฟล์), timeout, ไม่ทำให้ผู้เรียกพัง/ค้าง
// ไม่ต่อ LINE จริง — send เป็น mock; ไฟล์ state อยู่ในโฟลเดอร์ชั่วคราว

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createAdminNotifier } = require('../services/ops-alert');

const MIN = 60_000;
const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const U = (id, role) => ({ id, role });
const USERS = [U('Uadmin1', 'ADMIN'), U('Uadmin2', 'ADMIN'), U('Uit', 'IT_STAFF'), U('Uviewer', 'VIEWER'), U('Upending', 'PENDING'), U('Uadminlower', 'admin')];

let dir; let file; let t;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-alert-')); file = path.join(dir, 'data', 'ops-alert.json'); t = 1_000_000_000_000; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function make(over = {}) {
  const send = jest.fn().mockResolvedValue(undefined);
  const logger = silent();
  const n = createAdminNotifier({ listUsers: () => USERS, send, logger, now: () => t, file, ...over });
  return { n, send, logger };
}

describe('ผู้รับ', () => {
  it('ส่งถึง role === "ADMIN" เท่านั้น (ไม่ใช่ IT_STAFF/VIEWER/PENDING/พิมพ์เล็ก) เป็นข้อความ text', async () => {
    const { n, send } = make();
    const r = await n.notify('crash', 'ข้อความ');
    expect(r).toEqual({ sent: 2, recipients: 2 });
    expect(send.mock.calls.map((c) => c[0]).sort()).toEqual(['Uadmin1', 'Uadmin2']);
    expect(send.mock.calls[0][1]).toEqual({ type: 'text', text: 'ข้อความ' });
  });

  it('ไม่มี ADMIN → ไม่ส่ง ไม่เขียนไฟล์ ไม่โยน', async () => {
    const { n, send, logger } = make({ listUsers: () => [U('Uit', 'IT_STAFF')] });
    expect(await n.notify('crash', 'x')).toEqual({ sent: 0, recipients: 0, skipped: 'no-admin' });
    expect(send).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });

  it('listUsers โยน error → ข้าม ไม่โยนต่อ', async () => {
    const { n, send } = make({ listUsers: () => { throw new Error('users.json พัง'); } });
    expect(await n.notify('crash', 'x')).toEqual({ sent: 0, recipients: 0, skipped: 'list-users-failed' });
    expect(send).not.toHaveBeenCalled();
  });

  it('ไม่ log/คืน LINE userId', async () => {
    const { n, logger } = make({ send: jest.fn().mockRejectedValue(new Error('push ล้ม')) });
    const r = await n.notify('crash', 'x');
    expect(r.sent).toBe(0);
    expect(JSON.stringify(r)).not.toMatch(/Uadmin/);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toMatch(/Uadmin/);
  });
});

describe('cooldown (เก็บในไฟล์)', () => {
  it('ส่งครั้งเดียวภายใน cooldown และส่งอีกครั้งหลัง cooldown', async () => {
    const { n, send } = make();
    const cooldownMs = 30 * MIN;
    expect((await n.notify('crash', 'ครั้งที่ 1', { cooldownMs })).sent).toBe(2);
    t += 29 * MIN + 59_000; // ยังไม่ครบ
    expect(await n.notify('crash', 'ครั้งที่ 2', { cooldownMs })).toMatchObject({ sent: 0, skipped: 'cooldown' });
    expect(send).toHaveBeenCalledTimes(2); // 2 ADMIN จากครั้งแรกเท่านั้น
    t += 1_000; // ครบ 30 นาทีพอดี
    expect((await n.notify('crash', 'ครั้งที่ 3', { cooldownMs })).sent).toBe(2);
    expect(send).toHaveBeenCalledTimes(4);
  });

  it('cooldown แยกตาม key', async () => {
    const { n } = make();
    expect((await n.notify('crash', 'a', { cooldownMs: 30 * MIN })).sent).toBe(2);
    expect((await n.notify('drill', 'b', { cooldownMs: 30 * MIN })).sent).toBe(2);
  });

  it('จำข้าม instance (เหมือน restart): ไฟล์เก่ายังกันส่งซ้ำ', async () => {
    await make().n.notify('crash', 'ก่อน restart', { cooldownMs: 30 * MIN });
    t += 5 * MIN;
    const { n, send } = make();
    expect(await n.notify('crash', 'หลัง restart', { cooldownMs: 30 * MIN })).toMatchObject({ skipped: 'cooldown' });
    expect(send).not.toHaveBeenCalled();
  });

  it('เขียน state ก่อนส่ง และเขียนแบบ atomic (ไม่ทิ้ง .tmp)', async () => {
    let existedWhenSending = null;
    const { n } = make({ send: jest.fn(async () => { existedWhenSending = JSON.parse(fs.readFileSync(file, 'utf8')); }) });
    await n.notify('crash', 'x', { cooldownMs: MIN });
    expect(existedWhenSending).toEqual({ crash: t }); // ต้องมีแล้วตอนส่ง
    expect(fs.readdirSync(path.dirname(file))).toEqual(['ops-alert.json']);
  });

  it('ไฟล์ state พัง/ไม่ใช่ object → ถือว่าไม่เคยแจ้ง (ส่งได้) แล้วเขียนทับ', async () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{พัง');
    const { n } = make();
    expect((await n.notify('crash', 'x', { cooldownMs: 30 * MIN })).sent).toBe(2);
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ crash: t });
  });

  it('cooldownMs = 0 → ไม่จำกัด', async () => {
    const { n } = make();
    expect((await n.notify('drill', 'a')).sent).toBe(2);
    expect((await n.notify('drill', 'b')).sent).toBe(2);
  });
});

describe('timeout และความพัง', () => {
  it('send ค้างไม่จบ → คืนผลภายใน timeout พร้อม timedOut (ไม่ค้างตาม)', async () => {
    const send = jest.fn(() => new Promise(() => {})); // ไม่เคย resolve
    const { n, logger } = make({ send, timeoutMs: 50 });
    const started = Date.now();
    const r = await n.notify('crash', 'x');
    expect(Date.now() - started).toBeLessThan(1000);
    expect(r).toMatchObject({ sent: 0, recipients: 2, timedOut: true });
    expect(logger.warn).toHaveBeenCalled();
  });

  it('send โยน error แบบ synchronous ก็ไม่ทำให้ notify โยน', async () => {
    const { n } = make({ send: () => { throw new Error('sync boom'); } });
    await expect(n.notify('crash', 'x')).resolves.toMatchObject({ sent: 0, recipients: 2 });
  });

  it('ส่งสำเร็จบางคน → นับเฉพาะที่สำเร็จ', async () => {
    const send = jest.fn((to) => (to === 'Uadmin1' ? Promise.resolve() : Promise.reject(new Error('x'))));
    const { n } = make({ send });
    expect(await n.notify('crash', 'x')).toEqual({ sent: 1, recipients: 2 });
  });

  it('เขียน data/ ไม่ได้ → ข้ามการแจ้ง (ไม่ส่ง ไม่โยน) และ log', async () => {
    const blocker = path.join(dir, 'blocker'); // เป็นไฟล์ → mkdir/เขียนใต้มันไม่ได้
    fs.writeFileSync(blocker, 'x');
    const { n, send, logger } = make({ file: path.join(blocker, 'data', 'ops-alert.json') });
    await expect(n.notify('crash', 'x', { cooldownMs: MIN })).resolves.toMatchObject({ sent: 0, skipped: 'state-unwritable' });
    expect(send).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
