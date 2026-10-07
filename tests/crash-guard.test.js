'use strict';
// crash-guard: exit(1) เสมอ, hard timeout, ไม่แจ้งซ้ำเมื่อ crash ซ้อน, OPS_CRASH_NOTIFY=false ไม่เรียกส่งเลย
// ไม่ล้มโปรเซสของ jest จริง: exit เป็น mock; ไม่ต่อ LINE จริง

const fs = require('fs');
const os = require('os');
const path = require('path');
const redact = require('../services/redact');
const { createAdminNotifier } = require('../services/ops-alert');
const { createCrashHandler, install, loadConfig, buildCrashMessage, MESSAGE_SNIPPET_MAX } = require('../services/crash-guard');

const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const USERS = [{ id: 'Uadmin', role: 'ADMIN' }, { id: 'Uit', role: 'IT_STAFF' }];
const COOLDOWN = 30 * 60_000;

let dir; let file;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crash-guard-')); file = path.join(dir, 'data', 'ops-alert.json'); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

function make({ notifyEnabled = true, users = USERS, send, notifierOver = {}, handlerOver = {} } = {}) {
  const sendFn = send || jest.fn().mockResolvedValue(undefined);
  const logger = silent();
  const notifier = createAdminNotifier({ listUsers: () => users, send: sendFn, logger, file, ...notifierOver });
  const exit = jest.fn();
  const onCrash = createCrashHandler({ logger, redact, getNotifier: () => notifier, notifyEnabled, cooldownMs: COOLDOWN, exit, ...handlerOver });
  return { onCrash, exit, send: sendFn, logger };
}

describe('exit', () => {
  it('exit ถูกเรียกด้วยรหัส 1 (ครั้งเดียว) หลังจบการแจ้ง', async () => {
    const { onCrash, exit } = make();
    await onCrash('uncaughtException', new Error('พัง'));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('unhandledRejection ที่เป็นค่าไม่ใช่ Error (สตริง/undefined) ก็ออก 1', async () => {
    for (const reason of ['สตริง', undefined, { a: 1 }, null]) {
      const { onCrash, exit } = make();
      await onCrash('unhandledRejection', reason);
      expect(exit).toHaveBeenCalledWith(1);
    }
  });

  it('notify ค้างไม่จบ → hard timeout ทำให้ยังออก 1 (ไม่ค้างตลอดไป)', async () => {
    const hang = { notify: () => new Promise(() => {}) };
    const exit = jest.fn();
    const onCrash = createCrashHandler({ logger: silent(), redact, getNotifier: () => hang, notifyEnabled: true, exit, hardTimeoutMs: 40 });
    onCrash('uncaughtException', new Error('x')); // ไม่ await — ตัวมันเองค้างตาม notify
    expect(exit).not.toHaveBeenCalled();
    await new Promise((r) => setTimeout(r, 150));
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('send ค้าง (ผ่าน ops-alert จริง) → ออกภายใน timeout ของ notifier โดยไม่ต้องรอ hard timeout', async () => {
    const { onCrash, exit } = make({ send: () => new Promise(() => {}), notifierOver: { timeoutMs: 40 } });
    const started = Date.now();
    await onCrash('uncaughtException', new Error('x'));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('notify โยน error / logger พัง / redact พัง → ก็ยังออก 1', async () => {
    const exit = jest.fn();
    const brokenLogger = { info() { throw new Error('l'); }, warn() { throw new Error('l'); }, error() { throw new Error('l'); } };
    const onCrash = createCrashHandler({
      logger: brokenLogger, redact: () => { throw new Error('r'); },
      getNotifier: () => ({ notify: () => { throw new Error('n'); } }), notifyEnabled: true, exit,
    });
    await expect(onCrash('uncaughtException', new Error('x'))).resolves.toBeUndefined();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('ไม่มี notifier (ยังไม่ถูกสร้าง ตอน crash ช่วง startup) → log แล้วออก 1', async () => {
    const exit = jest.fn(); const logger = silent();
    const onCrash = createCrashHandler({ logger, redact, getNotifier: () => null, notifyEnabled: true, exit });
    await onCrash('uncaughtException', new Error('พังตอน startup'));
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('พังตอน startup'));
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('exit โยน error ก็ไม่ทำให้ handler โยน', async () => {
    const { onCrash } = make({ handlerOver: { exit: () => { throw new Error('exit พัง'); } } });
    await expect(onCrash('uncaughtException', new Error('x'))).resolves.toBeUndefined();
  });
});

describe('การแจ้ง ADMIN', () => {
  it('ส่งข้อความถึง ADMIN เท่านั้น โดยมี kind + ข้อความ error ที่ redact แล้ว', async () => {
    const { onCrash, send } = make();
    await onCrash('unhandledRejection', new Error('ต่อไม่ได้ appKey : FAKEKEY123 userId U' + '0123456789abcdef'.repeat(2)));
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('Uadmin');
    const text = send.mock.calls[0][1].text;
    expect(text).toContain('unhandledRejection');
    expect(text).toContain('กำลังรีสตาร์ตเอง');
    expect(text).not.toContain('FAKEKEY123');
    expect(text).not.toContain('0123456789abcdef');
  });

  it('ข้อความ error ยาวถูกตัด', () => {
    const text = buildCrashMessage('uncaughtException', new Error('ก'.repeat(5000)), redact);
    expect(text.length).toBeLessThan(MESSAGE_SNIPPET_MAX + 120);
  });

  it('log ที่ลง logger เป็นสตริง redact แล้ว (ไม่ส่ง Error ดิบที่ logger จะพิมพ์ stack)', async () => {
    const { onCrash, logger } = make({ notifyEnabled: false });
    await onCrash('uncaughtException', new Error('x token=SECRETVALUE99'));
    const [firstArg, secondArg] = logger.error.mock.calls[0];
    expect(typeof firstArg).toBe('string');
    expect(firstArg).not.toContain('SECRETVALUE99');
    expect(secondArg).toBeUndefined();
  });

  it('ส่งครั้งเดียวภายใน cooldown (crash ซ้ำหลัง restart จำลองด้วย handler ใหม่) และส่งอีกครั้งหลัง cooldown', async () => {
    let t = 2_000_000_000_000;
    const opts = { notifierOver: { now: () => t } };
    const a = make(opts); await a.onCrash('uncaughtException', new Error('1'));
    expect(a.send).toHaveBeenCalledTimes(1);
    t += 5 * 60_000;
    const b = make({ ...opts, send: a.send }); await b.onCrash('uncaughtException', new Error('2')); // "restart" แล้ว crash ซ้ำ
    expect(a.send).toHaveBeenCalledTimes(1);
    expect(b.exit).toHaveBeenCalledWith(1);
    t += 30 * 60_000;
    const c = make({ ...opts, send: a.send }); await c.onCrash('uncaughtException', new Error('3'));
    expect(a.send).toHaveBeenCalledTimes(2);
  });

  it('ไม่มีผู้รับ ADMIN → ไม่ส่ง แต่ยังออก 1', async () => {
    const { onCrash, exit, send } = make({ users: [{ id: 'Uit', role: 'IT_STAFF' }] });
    await onCrash('uncaughtException', new Error('x'));
    expect(send).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('เขียน data/ ไม่ได้ → ไม่ส่ง แต่ยังออก 1', async () => {
    const blocker = path.join(dir, 'blocker'); fs.writeFileSync(blocker, 'x');
    const { onCrash, exit, send } = make({ notifierOver: { file: path.join(blocker, 'data', 'ops-alert.json') } });
    await onCrash('uncaughtException', new Error('x'));
    expect(send).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
  });
});

describe('crash ซ้อน', () => {
  it('crash ที่สองระหว่างปิดตัวไม่แจ้งซ้ำ ไม่ออกซ้ำ แค่ log', async () => {
    let release;
    const send = jest.fn(() => new Promise((r) => { release = r; })); // ค้างไว้ก่อน
    const { onCrash, exit, logger } = make({ send });
    const first = onCrash('uncaughtException', new Error('แรก'));
    await new Promise((r) => setTimeout(r, 20));
    await onCrash('unhandledRejection', new Error('ซ้อน')); // เกิดระหว่าง first ยังรอส่ง
    expect(send).toHaveBeenCalledTimes(1);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('ซ้อนระหว่างปิดตัว'));
    release(); await first;
    expect(send).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    await onCrash('uncaughtException', new Error('หลังออก')); // เรียกอีกหลังออกแล้วก็ไม่ทำอะไรเพิ่ม
    expect(exit).toHaveBeenCalledTimes(1);
  });
});

describe('OPS_CRASH_NOTIFY=false (ค่าเริ่มต้น)', () => {
  it('ไม่เรียก send และไม่แตะ listUsers/ไฟล์ state เลย แต่ log และออก 1', async () => {
    const send = jest.fn(); const listUsers = jest.fn(() => USERS);
    const logger = silent(); const exit = jest.fn();
    const notifier = createAdminNotifier({ listUsers, send, logger, file });
    const onCrash = createCrashHandler({ logger, redact, getNotifier: () => notifier, notifyEnabled: false, exit });
    await onCrash('uncaughtException', new Error('พัง'));
    expect(send).not.toHaveBeenCalled();
    expect(listUsers).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('loadConfig: ค่าเริ่มต้นปิด; เปิดเฉพาะ "true"', () => {
    expect(loadConfig({}).notify).toBe(false);
    for (const v of ['false', 'TRUE ', '1', 'yes', 'on', '']) expect(loadConfig({ OPS_CRASH_NOTIFY: v }).notify).toBe(v.trim() === 'true');
    expect(loadConfig({ OPS_CRASH_NOTIFY: 'true' }).notify).toBe(true);
    expect(loadConfig({ OPS_CRASH_NOTIFY: ' true ' }).notify).toBe(true);
  });
});

describe('loadConfig: cooldown', () => {
  it('ค่าเริ่มต้น 30 นาที', () => expect(loadConfig({})).toMatchObject({ cooldownMin: 30, warnings: [] }));
  it('รับจำนวนเต็ม 1–1440', () => {
    expect(loadConfig({ OPS_CRASH_NOTIFY_COOLDOWN_MIN: '1' }).cooldownMin).toBe(1);
    expect(loadConfig({ OPS_CRASH_NOTIFY_COOLDOWN_MIN: '1440' }).cooldownMin).toBe(1440);
  });
  it.each(['0', '-5', '1441', 'abc', '2.5'])('ผิดรูปแบบ %s → 30 + warning', (v) => {
    const c = loadConfig({ OPS_CRASH_NOTIFY_COOLDOWN_MIN: v });
    expect(c.cooldownMin).toBe(30);
    expect(c.warnings).toHaveLength(1);
  });
});

describe('install', () => {
  it('ลงทะเบียน uncaughtException และ unhandledRejection แล้วส่งต่อให้ handler พร้อมชนิด', () => {
    const handlers = {};
    const proc = { on: (ev, fn) => { handlers[ev] = fn; } };
    const handler = jest.fn();
    install({ handler, proc });
    expect(Object.keys(handlers).sort()).toEqual(['uncaughtException', 'unhandledRejection']);
    const e1 = new Error('a'); const e2 = new Error('b');
    handlers.uncaughtException(e1); handlers.unhandledRejection(e2);
    expect(handler).toHaveBeenNthCalledWith(1, 'uncaughtException', e1);
    expect(handler).toHaveBeenNthCalledWith(2, 'unhandledRejection', e2);
  });
});
