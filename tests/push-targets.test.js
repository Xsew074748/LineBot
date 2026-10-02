'use strict';
// ผู้รับ alert จาก Zabbix webhook — ต้องเป็น role ที่อนุมัติแล้วเท่านั้น (allow-list) ทุก severity
// เคยมีบั๊ก: severity >= 4 ส่งให้ "ทุกคนในไฟล์" รวมถึง PENDING และ role แปลกๆ (ดู services/push-targets.js)

const fs = require('fs');
const path = require('path');
const { selectAlertRecipients, createAlertPusher } = require('../services/push-targets');
const config = require('../config');

const U = (id, role) => ({ id, role });
const users = [
  U('Uadmin', 'ADMIN'), U('Uit', 'IT_STAFF'), U('Uviewer', 'VIEWER'),
  U('Upending', 'PENDING'),
  U('Uundef', undefined), U('Unull', null), U('Uempty', ''),
  U('Ulower', 'admin'), U('Uspace', 'ADMIN '), U('Utypo', 'ADMN'), U('Uunknown', 'SUPERUSER'), U('Unum', 1),
];
const ids = (list) => list.map((u) => u.id);

describe('selectAlertRecipients() — allow-list', () => {
  it.each([4, 5])('severity %i (high/disaster): ทุกคนที่อนุมัติแล้ว (ADMIN, IT_STAFF, VIEWER) และไม่มีใครอื่น', (sev) => {
    expect(ids(selectAlertRecipients(users, sev))).toEqual(['Uadmin', 'Uit', 'Uviewer']);
  });

  it.each([0, 1, 2, 3])('severity %i (ต่ำกว่า high): เฉพาะ ADMIN และ IT_STAFF', (sev) => {
    expect(ids(selectAlertRecipients(users, sev))).toEqual(['Uadmin', 'Uit']);
  });

  it('PENDING ไม่ได้รับทุก severity 0–5 (รวมค่านอกช่วง)', () => {
    for (const sev of [-1, 0, 1, 2, 3, 4, 5, 6, 99]) {
      expect(ids(selectAlertRecipients(users, sev))).not.toContain('Upending');
    }
  });

  it('role ว่าง/null/undefined/พิมพ์เล็ก/มีช่องว่าง/พิมพ์ผิด/ไม่รู้จัก/ไม่ใช่สตริง ไม่ได้รับทุก severity (fail closed)', () => {
    const bad = ['Uundef', 'Unull', 'Uempty', 'Ulower', 'Uspace', 'Utypo', 'Uunknown', 'Unum'];
    for (const sev of [0, 3, 4, 5]) {
      const got = ids(selectAlertRecipients(users, sev));
      for (const b of bad) expect(got).not.toContain(b);
    }
  });

  it('severity ที่ไม่ใช่ตัวเลข (NaN/undefined/null/สตริง) → ถือว่าต่ำ: เฉพาะ ADMIN, IT_STAFF', () => {
    for (const sev of [NaN, undefined, null, '5', 'high', Infinity * 0]) {
      expect(ids(selectAlertRecipients(users, sev))).toEqual(['Uadmin', 'Uit']);
    }
  });

  it('รายการผิดรูป (ไม่ใช่ array, มี null/ไม่มี id) ไม่ crash และไม่ส่งให้ใคร', () => {
    expect(selectAlertRecipients(undefined, 5)).toEqual([]);
    expect(selectAlertRecipients(null, 5)).toEqual([]);
    expect(selectAlertRecipients({}, 5)).toEqual([]);
    expect(selectAlertRecipients([null, undefined, { role: 'ADMIN' }, { id: '', role: 'ADMIN' }, { id: 5, role: 'ADMIN' }], 5)).toEqual([]);
  });

  it('ใช้ allow-list จาก config กลางชุดเดียวกับ daily summary', () => {
    expect(config.APPROVED_ROLES).toEqual(['ADMIN', 'IT_STAFF', 'VIEWER']);
    expect(config.APPROVED_ROLES).not.toContain('PENDING');
    expect(config.IT_ROLES).toEqual(['ADMIN', 'IT_STAFF']);
    const ds = require('../services/daily-summary');
    expect(ds.APPROVED_ROLES).toBe(config.APPROVED_ROLES);
  });
});

describe('createAlertPusher() — ส่งจริงผ่าน send ปลอม', () => {
  const mk = (list = users) => {
    const sent = [];
    const send = jest.fn(async (to, message) => { sent.push({ to, message }); });
    const logger = { error: jest.fn() };
    const push = createAlertPusher({ listUsers: () => list, send, logger });
    return { push, sent, send, logger };
  };
  const flex = { type: 'bubble' };

  it.each([0, 1, 2, 3, 4, 5])('severity %i: PENDING/role แปลกๆ ไม่ถูกเรียก send เลย (flex)', async (sev) => {
    const { push, sent } = mk();
    await push(null, sev, flex);
    const to = sent.map((s) => s.to);
    for (const bad of ['Upending', 'Uundef', 'Unull', 'Uempty', 'Ulower', 'Uspace', 'Utypo', 'Uunknown', 'Unum']) expect(to).not.toContain(bad);
    expect(to).toEqual(expect.arrayContaining(['Uadmin', 'Uit']));
    expect(to.includes('Uviewer')).toBe(sev >= 4);
  });

  it('ข้อความ RESOLVED (text) ใช้ตัวกรองเดียวกัน ไม่ถึง PENDING', async () => {
    for (const sev of [2, 4, 5]) {
      const { push, sent } = mk();
      await push('✅ แก้ไขแล้ว: X', sev);
      expect(sent.map((s) => s.to)).not.toContain('Upending');
      expect(sent.every((s) => s.message.type === 'text' && s.message.text === '✅ แก้ไขแล้ว: X')).toBe(true);
    }
  });

  it('approved user ยังได้รับปกติ: flex ถูกห่อเป็น message เดียว และนับผลถูก', async () => {
    const { push, sent } = mk();
    const r = await push(null, 5, flex);
    expect(r).toEqual({ recipients: 3, sent: 3, failed: 0 });
    expect(sent[0].message).toEqual({ type: 'flex', altText: '🚨 แจ้งเตือนระบบ', contents: flex });
  });

  it('flex มาก่อน text ถ้ามีทั้งคู่ และไม่มีทั้งคู่ = ไม่ส่งอะไร', async () => {
    const a = mk(); await a.push('t', 5, flex);
    expect(a.sent[0].message.type).toBe('flex');
    const b = mk(); const r = await b.push(null, 5, null);
    expect(b.send).not.toHaveBeenCalled();
    expect(r.sent).toBe(0);
  });

  it('ส่งหาคนหนึ่งล้มเหลว → คนอื่นยังได้รับ และ log เฉพาะ userId (ไม่ log ข้อความ)', async () => {
    const sent = [];
    const send = jest.fn(async (to) => { if (to === 'Uadmin') throw new Error('LINE 400'); sent.push(to); });
    const logger = { error: jest.fn() };
    const push = createAlertPusher({ listUsers: () => users, send, logger });
    const r = await push('secret-alert-text', 5);
    expect(sent).toEqual(['Uit', 'Uviewer']);
    expect(r).toEqual({ recipients: 3, sent: 2, failed: 1 });
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0][0])).toContain('Uadmin');
    expect(JSON.stringify(logger.error.mock.calls)).not.toContain('secret-alert-text');
  });

  it('listUsers อ่านใหม่ทุกครั้ง: user ที่เพิ่งถูก approve ได้รับ alert ถัดไปทันที ส่วนที่ยัง PENDING ไม่ได้', async () => {
    const live = [U('Unew', 'PENDING')];
    const { push, sent } = mk(live);
    await push(null, 5, flex);
    expect(sent).toHaveLength(0);
    live[0].role = 'VIEWER';
    await push(null, 5, flex);
    expect(sent.map((s) => s.to)).toEqual(['Unew']);
  });
});

// ── รั้วกันของใหม่: index.js ต้องใช้ allow-list กลาง และห้ามมี push หาผู้ใช้หลายคนที่เลือกผู้รับเอง ──────────
describe('index.js wiring (static guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');

  it('pushToUsers มาจาก createAlertPusher และไม่เหลือ filter แบบ deny-list เดิม', () => {
    expect(src).toMatch(/const pushToUsers = pushTargets\.createAlertPusher\(/);
    expect(src).not.toMatch(/if \(severity >= 4\) return true/);
    expect(src).not.toMatch(/async function pushToUsers\(/);
  });

  it('จุดเรียก lineClient.pushMessage มีเท่าที่รู้จักและตรวจผู้รับแล้วเท่านั้น (เพิ่มจุดใหม่ต้องมาทบทวนผู้รับก่อน)', () => {
    const sites = src.split('\n').filter((l) => /lineClient\.pushMessage\(/.test(l));
    // 1 อนุมัติ→ผู้ถูกอนุมัติ, 3 push() หาผู้สั่งที่ผ่าน aiGate, 1 pushToUsers (allow-list), 1 daily summary (ส่งผ่าน APPROVED_ROLES)
    expect(sites).toHaveLength(6);
  });
});
