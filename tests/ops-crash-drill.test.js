'use strict';
// สคริปต์ drill: ค่าเริ่มต้นไม่ส่ง, --confirm-send ส่งถึง ADMIN เท่านั้นโดยขึ้นต้น "[ทดสอบ]", ไม่เรียก process.exit, ไม่พิมพ์ userId
// ไม่ต่อ LINE จริง

const fs = require('fs');
const os = require('os');
const path = require('path');
const { run, buildDrillMessage } = require('../scripts/ops-crash-drill');

const USERS = [{ id: 'Uadmin1', role: 'ADMIN' }, { id: 'Uit', role: 'IT_STAFF' }, { id: 'Uviewer', role: 'VIEWER' }];
let dir; let file; let exitSpy;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ops-drill-'));
  file = path.join(dir, 'ops-alert.json');
  exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('drill ห้ามเรียก process.exit'); });
});
afterEach(() => { exitSpy.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); });

const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
function go(argv, over = {}) {
  const out = []; const send = jest.fn().mockResolvedValue(undefined); const createSend = jest.fn(() => send);
  const p = run({ argv, env: {}, listUsers: () => USERS, createSend, log: (s) => out.push(s), logger: silent(), file, ...over });
  return p.then((r) => ({ r, out: out.join('\n'), send, createSend }));
}

describe('ops-crash-drill', () => {
  it('ค่าเริ่มต้น: ไม่ส่ง ไม่สร้าง client ไม่เขียนไฟล์ — แสดงตัวอย่างและจำนวนผู้รับ', async () => {
    const { r, out, send, createSend } = await go([]);
    expect(r).toEqual({ exitCode: 0, sent: 0, recipients: 1 });
    expect(send).not.toHaveBeenCalled();
    expect(createSend).not.toHaveBeenCalled();
    expect(fs.existsSync(file)).toBe(false);
    expect(out).toContain('[ทดสอบ]');
    expect(out).toContain('ADMIN 1 คน');
    expect(out).toContain('ไม่ได้ส่ง');
  });

  it('--confirm-send: ส่ง 1 ข้อความถึง ADMIN เท่านั้น ขึ้นต้น "[ทดสอบ]" และคืนผลสำเร็จ', async () => {
    const { r, send } = await go(['--confirm-send']);
    expect(r).toEqual({ exitCode: 0, sent: 1, recipients: 1 });
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe('Uadmin1');
    expect(send.mock.calls[0][1].type).toBe('text');
    expect(send.mock.calls[0][1].text.startsWith('[ทดสอบ]')).toBe(true);
  });

  it('ข้อความตัวอย่างผ่าน redact จริง: ความลับปลอมใน error สมมติไม่หลุด', () => {
    const text = buildDrillMessage();
    expect(text).not.toContain('FAKEAPPKEY1234');
    expect(text).not.toContain('FAKETOKEN9876');
    expect(text).not.toMatch(/Ua{32}/);
    expect(text).toContain('uncaughtException');
  });

  it('ไม่พิมพ์ LINE userId ในผลลัพธ์ที่แสดง', async () => {
    const { out } = await go(['--confirm-send']);
    expect(out).not.toMatch(/Uadmin1|Uit\b|Uviewer/);
  });

  it('ใช้ key "drill" ไม่แตะ cooldown ของ key "crash"', async () => {
    fs.writeFileSync(file, JSON.stringify({ crash: 123 }));
    await go(['--confirm-send']);
    const st = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(st.crash).toBe(123);
    expect(typeof st.drill).toBe('number');
  });

  it('ไม่มี ADMIN → exitCode 1 ไม่ส่ง', async () => {
    const { r, send } = await go(['--confirm-send'], { listUsers: () => [USERS[1]] });
    expect(r).toMatchObject({ exitCode: 1, sent: 0, recipients: 0 });
    expect(send).not.toHaveBeenCalled();
  });

  it('สร้าง client ไม่ได้ (ไม่มี token) → exitCode 1 ไม่โยน', async () => {
    const { r, out } = await go(['--confirm-send'], { createSend: () => { throw new Error('ไม่มี LINE_CHANNEL_ACCESS_TOKEN'); } });
    expect(r).toMatchObject({ exitCode: 1, sent: 0 });
    expect(out).toContain('ส่งไม่ได้');
  });

  it('รายงานสถานะ OPS_CRASH_NOTIFY ตามที่ตั้งจริง', async () => {
    expect((await go([], { env: {} })).out).toContain('ไม่เปิด');
    expect((await go([], { env: { OPS_CRASH_NOTIFY: 'true' } })).out).toContain('true (เปิด)');
  });

  it('ไม่เรียก process.exit (spy จะโยนถ้าเรียก)', async () => {
    await expect(go(['--confirm-send'])).resolves.toBeDefined();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
