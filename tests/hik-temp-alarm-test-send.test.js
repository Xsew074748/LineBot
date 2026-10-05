'use strict';
// สคริปต์ส่งข้อความทดสอบ Temperature Alarm ถึง ADMIN เท่านั้น: ไม่ใส่ --confirm-send ต้องไม่ส่งและไม่สร้าง LINE client,
// ใส่แล้วส่ง 1 ข้อความ "[ทดสอบ]" ถึง ADMIN เท่านั้น (ไม่ถึง IT_STAFF/VIEWER/PENDING) ผ่าน createAlertPusher เดียวกับฟีเจอร์จริง, ไม่พิมพ์ userId

const { run, buildTestMessage } = require('../scripts/hik-temp-alarm-test-send');

const USERS = [
  { id: 'Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', role: 'ADMIN' },
  { id: 'Ubbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb2', role: 'IT_STAFF' },
  { id: 'Uccccccccccccccccccccccccccccccc3', role: 'VIEWER' },
  { id: 'Uddddddddddddddddddddddddddddddd4', role: 'PENDING' },
  { id: 'Ueeeeeeeeeeeeeeeeeeeeeeeeeeeeeee5', role: 'admin' }, // พิมพ์เล็ก = role ที่ไม่รู้จัก ไม่ได้รับ
];
const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
function harness(argv, users = USERS, sendImpl = null) {
  const out = [];
  const sent = [];
  const createSend = jest.fn(() => sendImpl || (async (to, message) => { sent.push({ to, message }); }));
  return { out, sent, createSend, go: () => run({ argv, listUsers: () => users, createSend, log: (t) => out.push(String(t)), logger: silent() }) };
}

describe('hik-temp-alarm-test-send', () => {
  it('ข้อความขึ้นต้น "[ทดสอบ]", บอกว่าไม่ใช่เหตุการณ์จริง, มีตัวอย่างข้อความจริง และไม่มี URL รูป/อุณหภูมิ', () => {
    const t = buildTestMessage();
    expect(t.startsWith('[ทดสอบ]')).toBe(true);
    expect(t).toMatch(/ไม่ใช่เหตุการณ์จริง/);
    expect(t).toContain('บ่อขยะ.กล้องความร้อน1-BW (1088)');
    expect(t).not.toMatch(/https?:|°/);
  });

  it('ไม่ใส่ --confirm-send: แสดงข้อความ + จำนวนผู้รับ, ไม่ส่ง, ไม่สร้าง LINE client', async () => {
    const h = harness([]);
    const r = await h.go();
    expect(r).toEqual({ exitCode: 0, sent: 0, recipients: 1 });
    expect(h.createSend).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
    const text = h.out.join('\n');
    expect(text).toMatch(/\[ทดสอบ\]/);
    expect(text).toMatch(/ADMIN 1 คน/);
    expect(text).toMatch(/ไม่ได้ส่ง/);
  });
  it('ไม่พิมพ์ LINE userId ออกมาเลย (ทั้งโหมดดูและโหมดส่ง)', async () => {
    for (const argv of [[], ['--confirm-send']]) {
      const h = harness(argv);
      await h.go();
      expect(h.out.join('\n')).not.toMatch(/U[a-z]{20,}/);
    }
  });
  it('ใส่ --confirm-send: ส่ง 1 ข้อความถึง ADMIN เท่านั้น (ไม่ถึง IT_STAFF/VIEWER/PENDING/role พิมพ์เล็ก)', async () => {
    const h = harness(['--confirm-send']);
    const r = await h.go();
    expect(r).toEqual({ exitCode: 0, sent: 1, recipients: 1 });
    expect(h.sent.map((s) => s.to)).toEqual(['Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1']);
    expect(h.sent[0].message).toMatchObject({ type: 'text' });
    expect(h.sent[0].message.text.startsWith('[ทดสอบ]')).toBe(true);
  });
  it('ADMIN หลายคน: ส่งถึง ADMIN ทุกคน (และเฉพาะ ADMIN)', async () => {
    const users = [...USERS, { id: 'Uffffffffffffffffffffffffffffff6', role: 'ADMIN' }];
    const h = harness(['--confirm-send'], users);
    await h.go();
    expect(h.sent.map((s) => s.to)).toEqual(['Uaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa1', 'Uffffffffffffffffffffffffffffff6']);
  });
  it('ไม่มี ADMIN → ยกเลิก (exit 1) ไม่ส่งแม้ใส่ --confirm-send และไม่สร้าง LINE client', async () => {
    const h = harness(['--confirm-send'], USERS.filter((u) => u.role !== 'ADMIN'));
    const r = await h.go();
    expect(r.exitCode).toBe(1);
    expect(h.createSend).not.toHaveBeenCalled();
    expect(h.sent).toEqual([]);
  });
  it('สร้าง LINE client ไม่ได้ (ไม่มี token) → exit 1 ไม่ crash ไม่ส่ง', async () => {
    const out = [];
    const r = await run({ argv: ['--confirm-send'], listUsers: () => USERS, createSend: () => { throw new Error('ไม่มี LINE_CHANNEL_ACCESS_TOKEN'); }, log: (t) => out.push(t), logger: silent() });
    expect(r.exitCode).toBe(1);
    expect(out.join('\n')).toMatch(/ส่งไม่ได้: ไม่มี LINE_CHANNEL_ACCESS_TOKEN/);
  });
  it('LINE ปฏิเสธ (ส่งไม่สำเร็จ) → exit 1 และรายงานจำนวนล้มเหลว', async () => {
    const h = harness(['--confirm-send'], USERS, async () => { throw new Error('LINE 400'); });
    const r = await h.go();
    expect(r).toEqual({ exitCode: 1, sent: 0, recipients: 1 });
    expect(h.out.join('\n')).toMatch(/ล้มเหลว 1/);
  });
  it('ธงที่ไม่ใช่ --confirm-send เป๊ะ (เช่น --confirm, --send, -y) ไม่ทำให้ส่ง', async () => {
    for (const flag of ['--confirm', '--send', '-y', '--confirm-sent', 'confirm-send']) {
      const h = harness([flag]);
      await h.go();
      expect(h.sent).toEqual([]);
      expect(h.createSend).not.toHaveBeenCalled();
    }
  });
});
