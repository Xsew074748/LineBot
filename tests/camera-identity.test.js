'use strict';
// dedup กล้องด้วย index code (ภายใน HikCentral) + จับคู่ข้ามระบบแบบรหัสก่อน/ชื่อเป็น fallback
// ตัวระบุต้องมี prefix ระบบ (hostid ของ Zabbix กับ index code ของ HikCentral เป็นเลขเหมือนกันได้)

const fs = require('fs');
const path = require('path');
const { normalizeName, idKey, dedupeSameSystem, mergeSystems } = require('../services/camera-identity');
const { buildStats } = require('../services/stats');
const { summarize } = require('../services/daily-summary');

const zc = (id, name, extra = {}) => ({ id: String(id), name, available: 1, interfaces: [], ...extra });
const hc = (id, name, online = true, extra = {}) => ({ id: String(id), name, online, location: 'L', ...extra });

describe('normalizeName() / idKey()', () => {
  it('ตัดช่องว่างหัวท้าย + ตัวพิมพ์เล็ก; ชื่อว่าง/N/A/unknown ไม่ใช้เทียบ (null)', () => {
    expect(normalizeName('  HQ-CAM-001 ')).toBe('hq-cam-001');
    for (const v of ['', '  ', 'N/A', 'n/a', 'unknown', null, undefined]) expect(normalizeName(v)).toBeNull();
  });
  it('key มี prefix ระบบ: hostid 123 ของ Zabbix ≠ index code 123 ของ HikCentral', () => {
    expect(idKey({ id: '123' }, 'zabbix')).toBe('zbx:123');
    expect(idKey({ id: '123' }, 'hikcentral')).toBe('hik:123');
    expect(idKey({ id: 123 }, 'hikcentral')).toBe('hik:123');
    expect(idKey({ id: ' 123 ' }, 'hikcentral')).toBe('hik:123');
    for (const bad of [{}, { id: '' }, { id: null }, null, undefined]) expect(idKey(bad, 'hikcentral')).toBeNull();
    expect(idKey({ id: '1' }, 'omada')).toBeNull();
  });
});

describe('dedupeSameSystem()', () => {
  it('index code เดียวกัน = กล้องตัวเดียว (เก็บตัวแรก คงลำดับ)', () => {
    const list = [hc(1, 'A'), hc(2, 'B'), hc(1, 'A (dup จาก pagination)'), hc(3, 'C')];
    expect(dedupeSameSystem(list, 'hikcentral').map((c) => c.id)).toEqual(['1', '2', '3']);
    expect(dedupeSameSystem(list, 'hikcentral')[0].name).toBe('A');
  });
  it('ชื่อซ้ำแต่ index code ต่าง = คนละตัว ไม่รวมผิด', () => {
    const out = dedupeSameSystem([hc(1, 'Lobby'), hc(2, 'Lobby'), hc(3, 'lobby ')], 'hikcentral');
    expect(out.map((c) => c.id)).toEqual(['1', '2', '3']);
  });
  it('ไม่มี id → ซ้ำเมื่อชื่อ normalize เหมือนกัน (fallback ภายในระบบ)', () => {
    const out = dedupeSameSystem([{ name: 'Gate' }, { name: ' gate ' }, { name: 'Dock' }], 'hikcentral');
    expect(out.map((c) => c.name)).toEqual(['Gate', 'Dock']);
  });
  it('ไม่มีทั้ง id และชื่อที่ใช้ได้ → เก็บไว้ทุกตัว (ระบุไม่ได้ ห้ามรวมมั่ว)', () => {
    const out = dedupeSameSystem([{ name: 'N/A' }, { name: '' }, { name: 'N/A' }], 'hikcentral');
    expect(out).toHaveLength(3);
  });
  it('input ผิดรูป ไม่ crash และไม่แก้ array เดิม', () => {
    expect(dedupeSameSystem(undefined, 'hikcentral')).toEqual([]);
    expect(dedupeSameSystem([null, undefined, hc(1, 'A')], 'hikcentral')).toHaveLength(1);
    const src = [hc(1, 'A'), hc(1, 'A')];
    dedupeSameSystem(src, 'hikcentral');
    expect(src).toHaveLength(2);
  });
});

describe('mergeSystems()', () => {
  it('ไม่ทับกัน → ได้ครบทุกตัวตามลำดับเดิม (Zabbix ก่อน HikCentral) และเป็น object ตัวเดิม (ผลที่ผู้ใช้เห็นไม่เปลี่ยน)', () => {
    const z = [zc(10001, 'Z-1'), zc(10002, 'Z-2')];
    const h = [hc(1, 'H-1'), hc(2, 'H-2', false)];
    const out = mergeSystems({ zabbix: z, hikcentral: h });
    expect(out).toHaveLength(4);
    expect(out.map((c) => c.name)).toEqual(['Z-1', 'Z-2', 'H-1', 'H-2']);
    out.forEach((c, i) => expect(c).toBe([...z, ...h][i]));
  });

  it('ชื่อเดียวกันทั้งสองระบบ (ไม่สนตัวพิมพ์/ช่องว่าง) → นับครั้งเดียว และคงชื่อ/ข้อมูลฝั่ง Zabbix', () => {
    const z = [zc(10001, 'HQ-CAM-001', { available: 2 })];
    const h = [hc(7, ' hq-cam-001 '), hc(8, 'HQ-CAM-002')];
    const out = mergeSystems({ zabbix: z, hikcentral: h });
    expect(out.map((c) => c.name)).toEqual(['HQ-CAM-001', 'HQ-CAM-002']);
    expect(out[0].available).toBe(2); // ตัวของ Zabbix (สถานะ offline) ไม่ถูกแทนด้วยของ Hik
  });

  it('จับคู่ 1:1 — Zabbix ตัวเดียวตัด Hik ที่ชื่อตรงได้ตัวเดียว (Hik ที่ชื่อซ้ำรหัสต่างอีกตัวคือคนละกล้อง)', () => {
    const out = mergeSystems({ zabbix: [zc(1, 'Lobby')], hikcentral: [hc(51, 'Lobby'), hc(52, 'Lobby')] });
    expect(out).toHaveLength(2);
    expect(out.map((c) => c.id)).toEqual(['1', '52']); // zbx 1 + hik 52 (hik 51 ถูกตัดเป็นตัวเดียวกับ Zabbix)
  });

  it('ตัวผูกด้วยรหัส (hikIndexCode บนกล้อง Zabbix) มาก่อนชื่อ: ตัด Hik ตามรหัสแม้ชื่อต่างกัน และไม่ตัดตัวอื่นที่ชื่อตรง', () => {
    const z = [zc(10001, 'Entrance-A', { hikIndexCode: '51' })];
    const h = [hc(51, 'ทางเข้า A'), hc(52, 'Entrance-A')];
    const out = mergeSystems({ zabbix: z, hikcentral: h });
    // hik 51 ถูกตัดด้วยรหัส; hik 52 ชื่อตรงกับ Zabbix แต่ Zabbix ตัวนั้นผูกด้วยรหัสแล้ว จึงไม่ถูกตัดซ้ำด้วยชื่อ
    expect(out.map((c) => `${c.id}:${c.name}`)).toEqual(['10001:Entrance-A', '52:Entrance-A']);
  });

  it('prefix กันชน: hostid ของ Zabbix เท่ากับ index code ของ Hik ไม่ทำให้รวมผิด', () => {
    const out = mergeSystems({ zabbix: [zc(123, 'Zabbix cam')], hikcentral: [hc(123, 'Hik cam')] });
    expect(out.map((c) => c.name)).toEqual(['Zabbix cam', 'Hik cam']);
  });

  it('ชื่อ N/A/ว่างไม่ถูกใช้จับคู่ข้ามระบบ', () => {
    const out = mergeSystems({ zabbix: [zc(1, 'N/A')], hikcentral: [hc(2, 'N/A')] });
    expect(out).toHaveLength(2);
  });

  it('ซ้ำภายในระบบเดียว (pagination) ถูกตัดก่อนรวมทั้งสองฝั่ง', () => {
    const out = mergeSystems({ zabbix: [zc(1, 'A'), zc(1, 'A')], hikcentral: [hc(5, 'B'), hc(5, 'B')] });
    expect(out.map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('ฝั่งใดฝั่งหนึ่งว่าง/ไม่ส่งมา ก็ได้อีกฝั่งครบ; ไม่แก้ input', () => {
    expect(mergeSystems({ hikcentral: [hc(1, 'A')] })).toHaveLength(1);
    expect(mergeSystems({ zabbix: [zc(1, 'A')] })).toHaveLength(1);
    expect(mergeSystems()).toEqual([]);
    const z = [zc(1, 'X')]; const h = [hc(2, 'X')];
    const zs = JSON.stringify(z); const hs = JSON.stringify(h);
    mergeSystems({ zabbix: z, hikcentral: h });
    expect(JSON.stringify(z)).toBe(zs);
    expect(JSON.stringify(h)).toBe(hs);
  });
});

describe('buildStats() — จำนวนกล้องไม่นับซ้ำ', () => {
  const zabbixWith = (cameras) => ({ getProblems: async () => [], getHosts: async () => [], getCameras: async () => cameras });
  const hikWith = (cameras) => ({ getCameras: async () => cameras });

  it('กล้องตัวเดียวในสองระบบนับครั้งเดียว (เดิมนับ 2)', async () => {
    const stats = await buildStats({
      monitorKeys: ['zabbix', 'hikcentral'],
      zabbix: zabbixWith([zc(1, 'CAM-1', { available: 1 }), zc(2, 'CAM-2', { available: 2 })]),
      hikcentral: hikWith([hc(11, 'cam-1'), hc(12, 'CAM-3', false)]),
    });
    expect(stats.devices.cameras).toEqual({ total: 3, up: 1, down: 2 });
  });

  it('ไม่ทับกัน (เหมือนข้อมูลจริงตอนนี้ 68 + 5) → ผลรวมเท่าเดิม', async () => {
    const z = Array.from({ length: 5 }, (_, i) => zc(10000 + i, `Z-${i}`));
    const h = Array.from({ length: 68 }, (_, i) => hc(100 + i, `H-${i}`, i % 7 !== 0));
    const stats = await buildStats({ monitorKeys: ['zabbix', 'hikcentral'], zabbix: zabbixWith(z), hikcentral: hikWith(h) });
    expect(stats.devices.cameras.total).toBe(73);
    expect(stats.devices.cameras.down).toBe(h.filter((c) => !c.online).length);
  });

  it('Hik เดียวที่ชื่อซ้ำรหัสต่างยังนับทั้งสองตัว', async () => {
    const stats = await buildStats({ monitorKeys: ['hikcentral'], hikcentral: hikWith([hc(1, 'Lobby'), hc(2, 'Lobby')]) });
    expect(stats.devices.cameras.total).toBe(2);
  });
});

describe('daily-summary summarize() — dedup กล้อง HikCentral', () => {
  const base = { startSec: 1_000, zabbix: { ok: true, value: { events: [], active: [] } }, omada: null };
  const names = (s) => s.ongoing.map((i) => i.name);

  it('กล้อง Hik ชื่อซ้ำรหัสต่าง → แสดงทั้งคู่ (เดิมรวมเหลือตัวเดียว = นับขาด)', () => {
    const s = summarize({ ...base, hikcentral: { ok: true, value: [hc(1, 'Lobby', false), hc(2, 'Lobby', false)] } });
    expect(names(s)).toEqual(['Lobby', 'Lobby']);
    expect(s.total).toBe(2);
  });
  it('index code ซ้ำ (pagination) → แสดงครั้งเดียว', () => {
    const s = summarize({ ...base, hikcentral: { ok: true, value: [hc(1, 'A', false), hc(1, 'A', false), hc(2, 'B', false)] } });
    expect(names(s)).toEqual(['A', 'B']);
  });
  it('ไม่มีรหัสเลย: ชื่อซ้ำถูกรวม (fallback ภายใน Hik)', () => {
    const s = summarize({ ...base, hikcentral: { ok: true, value: [{ name: 'Gate' }, { name: 'gate ' }, { name: 'Dock' }] } });
    expect(names(s)).toEqual(['Gate', 'Dock']);
  });
  it('ซ้ำกับที่ Zabbix รายงานแล้ว (ชื่อ) ถูกตัดแบบ 1:1 — พฤติกรรมเดิมยังอยู่', () => {
    const s = summarize({
      ...base,
      zabbix: { ok: true, value: { events: [{ host: 'CAM-1', name: 'ICMP down', resolved: false }], active: [] } },
      hikcentral: { ok: true, value: [hc(1, 'cam-1', false), hc(2, 'CAM-1', false), hc(3, 'CAM-9', false)] },
    });
    // Zabbix 1 รายการ ตัด Hik 'cam-1' ได้ 1 ตัว; 'CAM-1' อีกตัว (รหัสต่าง) ยังแสดง
    expect(s.ongoing.map((i) => `${i.source}:${i.name}`)).toEqual(['Zabbix:CAM-1', 'HikCentral:CAM-1', 'HikCentral:CAM-9']);
  });
  it('ซ้ำกับอุปกรณ์ Omada ที่ชื่อเดียวกัน ยังถูกตัด (พฤติกรรมเดิม)', () => {
    const s = summarize({
      ...base,
      omada: { ok: true, value: [{ name: 'DEV-1', type: 'ap' }] },
      hikcentral: { ok: true, value: [hc(1, 'DEV-1', false)] },
    });
    expect(s.ongoing.map((i) => i.source)).toEqual(['Omada']);
  });
});

describe('index.js wiring (static guard)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  it('getAllCameras รวมกล้องผ่าน cameraIdentity.mergeSystems ไม่ใช่ flatMap ตรงๆ', () => {
    const fn = src.slice(src.indexOf('async function getAllCameras'), src.indexOf('async function getCamerasWithCache'));
    expect(fn).toMatch(/cameraIdentity\.mergeSystems\(/);
    expect(fn).not.toMatch(/flatMap/);
  });
});

// ── HikCentral service ผ่าน mock-lab: pagination ที่หน้าซ้อนกัน ───────────────────────────
describe('hikcentral.getCameras() — หน้าซ้อนกัน (กล้องถูกเพิ่ม/ลบระหว่างไล่หน้า)', () => {
  let server; let base; let hik; let holder;
  const setFault = (mode) => fetch(`${base}/mock/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'hikcentral', mode }) });

  beforeAll(async () => {
    const { createApp } = require('../mock-lab/server');
    const created = createApp({ scenarioFile: '01-baseline-office.yaml' });
    holder = created.holder;
    // ให้มีกล้องรวมพอดี 1,000 ตัว (3 หน้าที่ pageSize 500): หน้า 2 ที่เริ่มเร็วไป 1 ตัวทำให้ "นับรวมที่ซ้ำ" ถึง total ก่อนครบ
    const have = holder.state.inHik().length;
    for (let i = 0; i < 1000 - have; i++) holder.state.upsert({ name: `BULK-${String(i).padStart(4, '0')}`, kind: 'camera' });
    await new Promise((r) => { server = created.app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
    Object.assign(process.env, { HIKCENTRAL_URL: base, HIKCENTRAL_APP_KEY: 'mock-app-key', HIKCENTRAL_APP_SECRET: 'mock-app-secret' });
    jest.resetModules();
    hik = require('../services/hikcentral');
  });
  afterAll(async () => { await setFault('ok'); await new Promise((r) => server.close(r)); });

  it('ปกติ: ได้ 1,000 ตัว ไม่ซ้ำ', async () => {
    const cams = await hik.getCameras(1, 1000);
    expect(cams).toHaveLength(1000);
    expect(new Set(cams.map((c) => c.id)).size).toBe(1000);
  });

  it('หน้าซ้อนกัน (overlap): ยังได้ครบ 1,000 ตัวไม่ซ้ำ และไม่ตกหล่นตัวท้าย (เดิมหยุดเร็วเกินไปเพราะนับตัวซ้ำเข้า total)', async () => {
    await setFault('overlap');
    const cams = await hik.getCameras(1, 1000);
    const ids = cams.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);       // ไม่มี index code ซ้ำ
    expect(ids).toHaveLength(1000);                    // ครบ ไม่หายตัวท้าย
    const expected = holder.state.inHik().map((c) => c.name);
    expect(new Set(ids)).toEqual(new Set(expected));
  });

  it('ชื่อที่แสดงยังมาจาก HikCentral เหมือนเดิม (location/name/online ไม่เปลี่ยน)', async () => {
    await setFault('ok');
    const cams = await hik.getCameras(1, 1000);
    expect(cams[0]).toEqual(expect.objectContaining({ id: expect.any(String), name: expect.any(String), online: expect.any(Boolean), location: expect.any(String) }));
  });
});
