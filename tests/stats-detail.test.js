'use strict';
// Unit Tests สำหรับ services/stats-detail.js — ใช้โดย /stats/detail (Manager poll เก็บกราฟ Omada/HikCentral)
// ชุดสุดท้ายยิงผ่าน mock-lab จริง (services/omada.js + services/hikcentral.js ตัวจริง ต่อ mock ใน process เดียวกัน)

const {
  buildDetail, sumTraffic, topClients, classifyEvent, summarizeEvents, parseEventTypes, resolveWindow,
} = require('../services/stats-detail');

const NOW = 1_800_000_000;

describe('sumTraffic()', () => {
  it('รวม tx/rx ตามชื่อ field ที่รู้จัก', () => {
    expect(sumTraffic([{ time: 1, tx: 10, rx: 100 }, { time: 2, tx: 5, rx: 50 }])).toEqual({ tx: 15, rx: 150, unmapped: [] });
  });
  it('เผื่อ fallback หลายชื่อ (trafficUp/trafficDown, upload/download)', () => {
    expect(sumTraffic([{ time: 1, trafficUp: 3, trafficDown: 9 }]).rx).toBe(9);
    expect(sumTraffic([{ time: 1, upload: 4, download: 8 }]).tx).toBe(4);
  });
  it('ทุก bucket มีแค่ time → 0 (ไซต์จริงที่ไม่มี traffic ส่งมาแบบนี้)', () => {
    expect(sumTraffic([{ time: 1 }, { time: 2 }])).toEqual({ tx: 0, rx: 0, unmapped: [] });
    expect(sumTraffic(undefined)).toEqual({ tx: 0, rx: 0, unmapped: [] });
  });
  it('มี field ตัวเลขแต่ชื่อไม่รู้จัก → null + คืนเฉพาะ "ชื่อ field" ไม่คืนค่า', () => {
    const r = sumTraffic([{ time: 1, foo: 12345, bar: 6 }]);
    expect(r.tx).toBeNull();
    expect(r.unmapped).toEqual(['bar', 'foo']);
  });
});

describe('topClients()', () => {
  it('เรียงตามยอดรวม ตัดตัวที่ไม่มี traffic และจำกัด N', () => {
    const rows = [
      { mac: 'A', name: 'a', trafficDown: 100, trafficUp: 1 },
      { mac: 'B', name: 'b', trafficDown: 900, trafficUp: 50 },
      { mac: 'C', name: 'c' },
      { mac: 'D', hostName: 'd-host', trafficDown: 0, trafficUp: 0 },
    ];
    const r = topClients(rows, 2);
    expect(r.map((c) => c.mac)).toEqual(['B', 'A']);
    expect(r[0]).toMatchObject({ down: 900, up: 50 });
  });
});

describe('classifyEvent / summarizeEvents', () => {
  it('จัดหมวดจากชื่อ event', () => {
    expect(classifyEvent({ name: 'Motion Detection' })).toBe('motion');
    expect(classifyEvent({ name: 'Video Loss' })).toBe('videoLoss');
    expect(classifyEvent({ name: 'Video Tampering' })).toBe('tamper');
    expect(classifyEvent({ name: 'Disk full' })).toBe('other');
  });
  it('นับรวม + top กล้อง', () => {
    const recs = [
      { name: 'Motion', cameraId: 'C1', cameraName: 'Cam1' }, { name: 'Motion', cameraId: 'C1', cameraName: 'Cam1' },
      { name: 'Video loss', cameraId: 'C2', cameraName: 'Cam2' }, { name: 'x' },
    ];
    const r = summarizeEvents(recs, true);
    expect(r.events).toEqual({ total: 4, motion: 2, videoLoss: 1, tamper: 0, other: 1, truncated: true });
    expect(r.topCameras[0]).toEqual({ id: 'C1', name: 'Cam1', count: 2 });
  });
});

describe('parseEventTypes / resolveWindow', () => {
  it('parse เฉพาะจำนวนเต็ม', () => {
    expect(parseEventTypes('131330, 131331,abc,,-5,1.5')).toEqual([131330, 131331]);
    expect(parseEventTypes(undefined)).toEqual([]);
  });
  it('หน้าต่าง: ไม่ส่ง/ผิดรูปแบบ → 5 นาที, ย้อนไกลเกิน → จำกัด 1 ชม., อนาคต → 5 นาที', () => {
    expect(resolveWindow(null, NOW).windowSec).toBe(300);
    expect(resolveWindow('abc', NOW).windowSec).toBe(300);
    expect(resolveWindow(NOW - 99999, NOW).windowSec).toBe(3600);
    expect(resolveWindow(NOW + 500, NOW).windowSec).toBe(300);
    expect(resolveWindow(NOW - 600, NOW)).toEqual({ sinceSec: NOW - 600, windowSec: 600 });
  });
});

describe('buildDetail() — dependency ปลอม', () => {
  const omadaOk = () => ({
    getClientOverview: jest.fn().mockResolvedValue({
      stat: { total: 5, wireless: 3, wired: 2, num2g: 1, num5g: 2, num6g: 0, numGuest: 1 },
      clients: [{ mac: 'A', name: 'a', trafficDown: 10, trafficUp: 5 }],
    }),
    getDashboardOverview: jest.fn().mockResolvedValue({ totalPorts: 24, availablePorts: 20, powerConsumption: 38 }),
    getTrafficActivities: jest.fn().mockResolvedValue({
      apTrafficActivities: [{ time: 1, tx: 1, rx: 2 }], switchTrafficActivities: [{ time: 1 }],
    }),
  });
  const hikOk = (records = [{ name: 'Motion', cameraId: 'C1', cameraName: 'Cam1' }], truncated = false) => ({
    getEventRecords: jest.fn().mockResolvedValue({ records, truncated }),
  });

  it('shape ครบเมื่อทุกอย่างปกติ และส่งหน้าต่างเวลาเข้า upstream ถูก', async () => {
    const omada = omadaOk(); const hik = hikOk();
    const d = await buildDetail({ monitorKeys: ['omada', 'hikcentral'], omada, hikcentral: hik, since: NOW - 600, eventTypes: [1], now: NOW });
    expect(d.partial).toBeUndefined();
    expect(d.windowSec).toBe(600);
    expect(d.omada.clients).toMatchObject({ total: 5, wireless: 3, guest: 1 });
    expect(d.omada.overview.powerConsumption).toBe(38);
    expect(d.omada.traffic).toMatchObject({ apTx: 1, apRx: 2, swTx: 0, swRx: 0 });
    expect(d.omada.topClients).toHaveLength(1);
    expect(d.hikcentral.events.total).toBe(1);
    expect(omada.getTrafficActivities).toHaveBeenCalledWith(NOW - 600, NOW);
    expect(hik.getEventRecords).toHaveBeenCalledWith({ startMs: (NOW - 600) * 1000, endMs: NOW * 1000, eventTypes: [1] });
  });

  it('eventsSince แยกจาก since: traffic ใช้ since, event ใช้ eventsSince', async () => {
    const omada = omadaOk(); const hik = hikOk();
    const d = await buildDetail({ monitorKeys: ['omada', 'hikcentral'], omada, hikcentral: hik, since: NOW - 300, eventsSince: NOW - 1800, eventTypes: [1], now: NOW });
    expect(omada.getTrafficActivities).toHaveBeenCalledWith(NOW - 300, NOW);
    expect(hik.getEventRecords).toHaveBeenCalledWith({ startMs: (NOW - 1800) * 1000, endMs: NOW * 1000, eventTypes: [1] });
    expect(d.windowSec).toBe(300);
    expect(d.hikcentral.windowSec).toBe(1800);
  });

  it('section เดียวพัง → section อื่นยังอยู่ + partial', async () => {
    const omada = omadaOk();
    omada.getTrafficActivities.mockRejectedValue(new Error('boom'));
    const d = await buildDetail({ monitorKeys: ['omada'], omada, now: NOW });
    expect(d.partial).toBe(true);
    expect(d.failed).toEqual(['omada']);
    expect(d.omada.traffic).toBeNull();
    expect(d.omada.clients.total).toBe(5);
  });

  it('HikCentral timeout → events null + failed แต่ Omada ไม่กระทบ', async () => {
    const hik = { getEventRecords: jest.fn(() => new Promise(() => {})) };
    const d = await buildDetail({ monitorKeys: ['omada', 'hikcentral'], omada: omadaOk(), hikcentral: hik, eventTypes: [1], hikTimeoutMs: 20, now: NOW });
    expect(d.hikcentral.events).toBeNull();
    expect(d.hikcentral.eventsUnavailable).toBe('fetch-failed');
    expect(d.failed).toEqual(['hikcentral']);
    expect(d.omada.clients).not.toBeNull();
  });

  it('ไม่ได้ตั้ง eventTypes → ไม่ยิง HikCentral และไม่ถือเป็น failed', async () => {
    const hik = hikOk();
    const d = await buildDetail({ monitorKeys: ['hikcentral'], hikcentral: hik, eventTypes: [], now: NOW });
    expect(hik.getEventRecords).not.toHaveBeenCalled();
    expect(d.hikcentral.eventsUnavailable).toBe('event-types-not-configured');
    expect(d.partial).toBeUndefined();
  });

  it('ไม่มี monitor ใดเลย → มีแค่ metadata', async () => {
    const d = await buildDetail({ monitorKeys: [], now: NOW });
    expect(d.omada).toBeUndefined();
    expect(d.hikcentral).toBeUndefined();
  });
});

// ── ผ่าน mock-lab จริง: service ตัวจริง + HTTP จริง ────────────────────────────────
describe('buildDetail() — ผ่าน mock-lab', () => {
  let server; let omada; let hik;

  beforeAll(async () => {
    const { createApp } = require('../mock-lab/server');
    const { app } = createApp({ scenarioFile: '01-baseline-office.yaml' });
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    const url = `http://127.0.0.1:${server.address().port}`;
    Object.assign(process.env, {
      OMADA_URL: url, OMADA_OMADAC_ID: 'mock-omadac', OMADA_SITE_ID: 'mock-site',
      OMADA_CLIENT_ID: 'mock-client', OMADA_CLIENT_SECRET: 'mock-secret',
      HIKCENTRAL_URL: url, HIKCENTRAL_APP_KEY: 'mock-app-key', HIKCENTRAL_APP_SECRET: 'mock-app-secret',
    });
    jest.resetModules();
    omada = require('../services/omada');
    hik = require('../services/hikcentral');
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('Omada: clientStat + overview + traffic ผ่าน HTTP จริง', async () => {
    const now = Math.floor(Date.now() / 1000);
    const d = await buildDetail({ monitorKeys: ['omada'], omada, since: now - 1800, now });
    expect(d.partial).toBeUndefined();
    expect(d.omada.clients.total).toBeGreaterThan(0);
    expect(d.omada.clients.wireless + d.omada.clients.wired).toBe(d.omada.clients.total);
    expect(d.omada.overview.totalPorts).not.toBeNull();
    expect(d.omada.traffic.apRx).toBeGreaterThan(0);
    expect(d.omada.topClients.length).toBeGreaterThan(0);
    expect(d.omada.topClients.length).toBeLessThanOrEqual(10);
  });

  it('HikCentral: ดึง event ตามช่วงเวลา+ชนิด และจัดหมวด', async () => {
    const now = Math.floor(Date.now() / 1000);
    const d = await buildDetail({ monitorKeys: ['hikcentral'], hikcentral: hik, since: now - 3600, eventTypes: [131330, 131331, 131332], now });
    expect(d.partial).toBeUndefined();
    expect(d.hikcentral.events.total).toBeGreaterThan(0);
    expect(d.hikcentral.events.motion).toBeGreaterThan(0);
    expect(d.hikcentral.topCameras.length).toBeGreaterThan(0);
  });

  it('HikCentral: ชนิด event ที่ระบบไม่รู้จัก → error แบบเดียวกับของจริง → failed ไม่ล้มทั้งก้อน', async () => {
    const d = await buildDetail({ monitorKeys: ['hikcentral'], hikcentral: hik, eventTypes: [1], now: Math.floor(Date.now() / 1000) });
    expect(d.failed).toEqual(['hikcentral']);
    expect(d.hikcentral.events).toBeNull();
  });
});
