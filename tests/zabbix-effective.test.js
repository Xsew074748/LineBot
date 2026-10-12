'use strict';
// getHosts(limit, { effective: true }): ดึง host.get กับ item.get(icmpping) ขนานกัน แล้วใส่ effective / effectiveSource ให้แต่ละ host
// ต้องไม่เปลี่ยน available เดิม, ไม่ทำให้ getHosts ล้มเมื่อ item.get ล้ม, และ log warn ครั้งเดียว (ไม่ใส่ชื่อ/รหัส host)

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));
jest.mock('axios');
const axios = require('axios');
axios.post = jest.fn();

const logger = require('../services/logger');
const zabbix = require('../services/zabbix');

const NOW = 1_800_000_000;
let nowSpy;
beforeEach(() => {
  axios.post.mockReset();
  logger.warn.mockClear();
  zabbix._resetEffectiveLogState();
  nowSpy = jest.spyOn(Date, 'now').mockReturnValue(NOW * 1000);
});
afterEach(() => nowSpy.mockRestore());

const rawHost = (id, name, available, groups = 'Servers') => ({
  hostid: String(id), host: name, name, status: '0',
  groups: [{ name: groups }],
  interfaces: [{ ip: '192.0.2.' + id, available: String(available), main: '1' }],
});
const item = (hostid, value, ageSec, over = {}) => ({ hostid: String(hostid), lastvalue: String(value), lastclock: String(NOW - ageSec), status: '0', state: '0', ...over });

function api({ hosts, items, itemsError = null }) {
  axios.post.mockImplementation(async (_url, body) => {
    if (body.method === 'host.get') return { data: { result: hosts } };
    if (body.method === 'item.get') { if (itemsError) throw itemsError; return { data: { result: items } }; }
    throw new Error('unexpected method ' + body.method);
  });
}
const methods = () => axios.post.mock.calls.map((c) => c[1].method);

const HOSTS = [rawHost(1, 'agent-ok', 1), rawHost(2, 'agent-bad', 2), rawHost(3, 'ping-up', 0), rawHost(4, 'ping-down', 0), rawHost(5, 'ping-stale', 0), rawHost(6, 'no-item', 0)];
const ITEMS = [item(3, 1, 60), item(4, 0, 60), item(5, 1, 5000)];

describe('getHosts() ไม่ opt-in', () => {
  it('ไม่เรียก item.get และไม่มีฟิลด์ effective (พฤติกรรมเดิมทุกอย่าง)', async () => {
    api({ hosts: HOSTS, items: ITEMS });
    const hosts = await zabbix.getHosts(200);
    expect(methods()).toEqual(['host.get']);
    expect(hosts).toHaveLength(6);
    expect(hosts.every((h) => h.effective === undefined && h.effectiveSource === undefined)).toBe(true);
    expect(hosts.map((h) => h.available)).toEqual([1, 2, 0, 0, 0, 0]);
  });
});

describe('getHosts(limit, { effective: true })', () => {
  it('เรียก host.get 1 ครั้ง + item.get 1 ครั้ง ด้วย key_ = "icmpping" ตรงตัว (ไม่ใช่ icmppingsec/icmppingloss)', async () => {
    api({ hosts: HOSTS, items: ITEMS });
    await zabbix.getHosts(200, { effective: true });
    expect(methods().sort()).toEqual(['host.get', 'item.get']);
    const params = axios.post.mock.calls.find((c) => c[1].method === 'item.get')[1].params;
    expect(params.filter).toEqual({ key_: 'icmpping' });
    expect(params.output).toEqual(expect.arrayContaining(['hostid', 'lastvalue', 'lastclock', 'status', 'state']));
    expect(JSON.stringify(params)).not.toMatch(/icmppingsec|icmppingloss/);
  });

  it('เริ่มทั้งสองคำขอก่อนที่คำขอใดจะตอบ (ขนาน ไม่ต่อกัน)', async () => {
    let releaseHosts;
    axios.post.mockImplementation((_url, body) => {
      if (body.method === 'host.get') return new Promise((res) => { releaseHosts = () => res({ data: { result: HOSTS } }); });
      return Promise.resolve({ data: { result: ITEMS } });
    });
    const p = zabbix.getHosts(200, { effective: true });
    await new Promise((r) => setImmediate(r));
    expect(methods().sort()).toEqual(['host.get', 'item.get']);   // item.get ออกไปแล้วทั้งที่ host.get ยังไม่ตอบ
    releaseHosts();
    await p;
  });

  it('ใส่ effective/effectiveSource ถูกต้อง และไม่แตะ available', async () => {
    api({ hosts: HOSTS, items: ITEMS });
    const hosts = await zabbix.getHosts(200, { effective: true });
    const by = Object.fromEntries(hosts.map((h) => [h.name, h]));
    expect([by['agent-ok'].effective, by['agent-ok'].effectiveSource]).toEqual(['up', 'agent']);
    expect([by['agent-bad'].effective, by['agent-bad'].effectiveSource]).toEqual(['down', 'agent']);
    expect([by['ping-up'].effective, by['ping-up'].effectiveSource]).toEqual(['up', 'icmp']);
    expect([by['ping-down'].effective, by['ping-down'].effectiveSource]).toEqual(['down', 'icmp']);
    expect([by['ping-stale'].effective, by['ping-stale'].effectiveSource]).toEqual(['unknown', 'none']);
    expect([by['no-item'].effective, by['no-item'].effectiveSource]).toEqual(['unknown', 'none']);
    expect(hosts.map((h) => h.available)).toEqual([1, 2, 0, 0, 0, 0]);
  });

  it('ป้าย status สอดคล้องกับ effective (🟢 / 🔴 / ❓) เพื่อให้ผู้ใช้ status เดิมเห็นผลที่ถูก', async () => {
    api({ hosts: HOSTS, items: ITEMS });
    const by = Object.fromEntries((await zabbix.getHosts(200, { effective: true })).map((h) => [h.name, h]));
    expect(by['ping-up'].status).toBe('🟢 ออนไลน์');
    expect(by['ping-down'].status).toBe('🔴 ออฟไลน์');
    expect(by['no-item'].status).toBe('❓ ไม่ทราบ');
  });

  it('item ของ host ที่ไม่ได้อยู่ในรายการ host.get ถูกเมิน', async () => {
    api({ hosts: [rawHost(3, 'ping-up', 0)], items: [item(3, 1, 10), item(99, 0, 10)] });
    const hosts = await zabbix.getHosts(200, { effective: true });
    expect(hosts).toHaveLength(1);
    expect(hosts[0].effective).toBe('up');
  });

  it('item.get ล้ม → getHosts ไม่ throw; host ที่มี agent ยังตัดสินได้, host ICMP-only เป็น unknown; warn ครั้งเดียวต่อช่วงที่ล้ม', async () => {
    api({ hosts: HOSTS, items: [], itemsError: Object.assign(new Error('timeout'), { code: 'ECONNABORTED' }) });
    const first = await zabbix.getHosts(200, { effective: true });
    const second = await zabbix.getHosts(200, { effective: true });
    const by = Object.fromEntries(first.map((h) => [h.name, h]));
    expect(by['agent-ok'].effective).toBe('up');
    expect(by['agent-bad'].effective).toBe('down');
    expect(by['ping-up'].effective).toBe('unknown');
    expect(second).toHaveLength(6);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(String(logger.warn.mock.calls[0][0])).toMatch(/icmpping/);
  });

  it('หลังกลับมาสำเร็จ แล้วล้มอีก จะ warn ใหม่ (ไม่ถูกกลบถาวร)', async () => {
    const err = Object.assign(new Error('timeout'), { code: 'ECONNABORTED' });
    api({ hosts: HOSTS, items: [], itemsError: err });
    await zabbix.getHosts(200, { effective: true });
    api({ hosts: HOSTS, items: ITEMS });
    await zabbix.getHosts(200, { effective: true });
    api({ hosts: HOSTS, items: [], itemsError: err });
    await zabbix.getHosts(200, { effective: true });
    expect(logger.warn).toHaveBeenCalledTimes(2);
  });

  it('host.get ล้ม → getHosts ล้มเหมือนเดิม (ไม่กลบความผิดพลาดหลัก)', async () => {
    axios.post.mockImplementation(async (_u, body) => { if (body.method === 'host.get') throw new Error('host.get down'); return { data: { result: [] } }; });
    await expect(zabbix.getHosts(200, { effective: true })).rejects.toThrow('host.get down');
  });

  it('agent ขัดกับ icmpping → ใช้ agent และ warn ครั้งเดียวต่อ host โดยระบุลำดับ ไม่ใส่ชื่อ/รหัส host', async () => {
    const hosts = [rawHost(1, 'secret-name-A', 1), rawHost(2, 'secret-name-B', 1)];
    api({ hosts, items: [item(1, 0, 30), item(2, 0, 30)] });
    const a = await zabbix.getHosts(200, { effective: true });
    await zabbix.getHosts(200, { effective: true });
    expect(a.map((h) => h.effective)).toEqual(['up', 'up']);
    expect(logger.warn).toHaveBeenCalledTimes(2);                    // 2 host × ครั้งเดียว (รอบที่สองไม่ซ้ำ)
    const msgs = logger.warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(msgs).toMatch(/#1/);
    expect(msgs).toMatch(/#2/);
    expect(msgs).not.toMatch(/secret-name/);
    expect(msgs).not.toMatch(/192\.0\.2/);
  });
});
