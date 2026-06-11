'use strict';
// Unit tests สำหรับ services/correlate.js
// รัน: npm test

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
  apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

const { correlate } = require('../services/correlate');

// opts ที่ทำให้ lookback = ไม่มีกำหนด (รับทุก timestamp ที่ส่งมา)
// ใช้ 1 ปี = 31536000 วินาที เพื่อให้ test ทุก case ผ่าน timestamp check
const WIDE_OPTS = { lookbackSec: 31_536_000, timeWindowSec: 120 };

// สร้าง alert จำลองแบบสั้น
function mkAlert(overrides = {}) {
  return {
    source:    'test',
    device:    'DEV-001',
    zone:      'อาคาร A',
    type:      'camera',
    status:    'problem',
    timestamp: Math.floor(Date.now() / 1000),
    ip:        null,
    severity:  3,
    ...overrides,
  };
}

// ── กรณีที่ 1: หลายชนิดดับพร้อมกัน → high confidence ──────────────────────────
describe('Multi-type alerts in same zone', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('camera + ap + switch ในโซนเดียว timestamp ห่าง < 120s → high confidence', () => {
    const alerts = [
      mkAlert({ device: 'CAM-001', type: 'camera', zone: 'อาคาร A', timestamp: NOW }),
      mkAlert({ device: 'AP-001',  type: 'ap',     zone: 'อาคาร A', timestamp: NOW + 30 }),
      mkAlert({ device: 'SW-001',  type: 'switch', zone: 'อาคาร A', timestamp: NOW + 60 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('high');
    expect(groups[0].hasInfraDevice).toBe(true);
    expect(groups[0].types).toContain('camera');
    expect(groups[0].types).toContain('ap');
    expect(groups[0].types).toContain('switch');
    expect(groups[0].zone).toBe('อาคาร A');
    expect(groups[0].devices).toHaveLength(3);
  });

  it('camera + ap (ไม่มี switch) → high confidence เพราะ multi-type', () => {
    const alerts = [
      mkAlert({ device: 'CAM-001', type: 'camera', zone: 'Zone-B', timestamp: NOW }),
      mkAlert({ device: 'AP-001',  type: 'ap',     zone: 'Zone-B', timestamp: NOW + 50 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('high');
    expect(groups[0].hasInfraDevice).toBe(false);
  });

  it('host อยู่คนเดียวในกลุ่ม + camera → high confidence (infra device)', () => {
    const alerts = [
      mkAlert({ device: 'SRV-001', type: 'host',   zone: 'Zone-C', timestamp: NOW }),
      mkAlert({ device: 'CAM-001', type: 'camera', zone: 'Zone-C', timestamp: NOW + 10 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups[0].confidence).toBe('high');
    expect(groups[0].hasInfraDevice).toBe(true);
  });

  it('เรียงกลุ่ม high ก่อน medium', () => {
    const alerts = [
      // Medium group in zone X (same type, camera only)
      mkAlert({ device: 'CAM-X1', type: 'camera', zone: 'Zone-X', timestamp: NOW }),
      mkAlert({ device: 'CAM-X2', type: 'camera', zone: 'Zone-X', timestamp: NOW + 10 }),
      // High group in zone Y (multi-type)
      mkAlert({ device: 'CAM-Y1', type: 'camera', zone: 'Zone-Y', timestamp: NOW }),
      mkAlert({ device: 'AP-Y1',  type: 'ap',     zone: 'Zone-Y', timestamp: NOW + 20 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(2);
    expect(groups[0].confidence).toBe('high');   // high ก่อน
    expect(groups[1].confidence).toBe('medium');
  });
});

// ── กรณีที่ 2: ชนิดเดียว → medium confidence ──────────────────────────────────
describe('Single-type alerts', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('camera หลายตัวในโซนเดียว → medium confidence', () => {
    const alerts = [
      mkAlert({ device: 'CAM-001', type: 'camera', zone: 'Zone-D', timestamp: NOW }),
      mkAlert({ device: 'CAM-002', type: 'camera', zone: 'Zone-D', timestamp: NOW + 30 }),
      mkAlert({ device: 'CAM-003', type: 'camera', zone: 'Zone-D', timestamp: NOW + 60 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(1);
    expect(groups[0].confidence).toBe('medium');
    expect(groups[0].hasInfraDevice).toBe(false);
    expect(groups[0].devices).toHaveLength(3);
  });

  it('ap หลายตัวในโซนเดียว → medium confidence', () => {
    const alerts = [
      mkAlert({ device: 'AP-001', type: 'ap', zone: 'Zone-E', timestamp: NOW }),
      mkAlert({ device: 'AP-002', type: 'ap', zone: 'Zone-E', timestamp: NOW + 45 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups[0].confidence).toBe('medium');
  });
});

// ── กรณีที่ 3: ไม่มีอะไรดับ → [] ──────────────────────────────────────────────
describe('No active problems', () => {
  it('array เปล่า → คืน []', () => {
    expect(correlate([], WIDE_OPTS)).toEqual([]);
  });

  it('status=up ทั้งหมด → คืน []', () => {
    const alerts = [
      mkAlert({ status: 'up',   zone: 'Zone-F' }),
      mkAlert({ status: 'up',   zone: 'Zone-F' }),
    ];
    expect(correlate(alerts, WIDE_OPTS)).toEqual([]);
  });

  it('device คนเดียวในโซน → ไม่สร้างกลุ่ม (ต้องมีอย่างน้อย 2)', () => {
    const alerts = [mkAlert({ zone: 'Zone-G' })];
    expect(correlate(alerts, WIDE_OPTS)).toEqual([]);
  });

  it('null/undefined input → คืน []', () => {
    expect(correlate(null,      WIDE_OPTS)).toEqual([]);
    expect(correlate(undefined, WIDE_OPTS)).toEqual([]);
  });
});

// ── กรณีที่ 4: คนละโซน → แยกกลุ่ม ────────────────────────────────────────────
describe('Different zones create separate groups', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('alert ในโซนต่างกัน → สร้างกลุ่มแยก', () => {
    const alerts = [
      mkAlert({ device: 'CAM-1', zone: 'Zone-H', timestamp: NOW }),
      mkAlert({ device: 'CAM-2', zone: 'Zone-H', timestamp: NOW + 10 }),
      mkAlert({ device: 'CAM-3', zone: 'Zone-I', timestamp: NOW }),
      mkAlert({ device: 'CAM-4', zone: 'Zone-I', timestamp: NOW + 10 }),
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(2);
    const zones = groups.map((g) => g.zone).sort();
    expect(zones).toEqual(['Zone-H', 'Zone-I']);
  });
});

// ── กรณีที่ 5: timestamp เกิน timeWindow → คนละกลุ่ม ──────────────────────────
describe('Timestamp window separation', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('alert ห่าง > 120s ในโซนเดียวกัน → คนละกลุ่ม', () => {
    const alerts = [
      mkAlert({ device: 'CAM-1', zone: 'Zone-J', timestamp: NOW }),
      mkAlert({ device: 'CAM-2', zone: 'Zone-J', timestamp: NOW + 30 }),   // กลุ่ม 1
      mkAlert({ device: 'CAM-3', zone: 'Zone-J', timestamp: NOW + 250 }),  // กลุ่ม 2 (250s > 120s)
      mkAlert({ device: 'CAM-4', zone: 'Zone-J', timestamp: NOW + 270 }),  // กลุ่ม 2
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(2);
    expect(groups[0].devices).toHaveLength(2);
    expect(groups[1].devices).toHaveLength(2);
  });

  it('alert ห่างพอดี 120s → ยังอยู่กลุ่มเดียวกัน (boundary)', () => {
    const alerts = [
      mkAlert({ device: 'CAM-1', zone: 'Zone-K', timestamp: NOW }),
      mkAlert({ device: 'CAM-2', zone: 'Zone-K', timestamp: NOW + 120 }), // เท่ากัน = ยังผ่าน
    ];
    const groups = correlate(alerts, WIDE_OPTS);
    expect(groups).toHaveLength(1);
    expect(groups[0].devices).toHaveLength(2);
  });
});

// ── กรณีที่ 6: lookback filter ─────────────────────────────────────────────────
describe('Lookback time filter', () => {
  it('alert เก่าเกินกว่า lookback → ไม่ถูกรวม', () => {
    const OLD = Math.floor(Date.now() / 1000) - 600; // 10 นาทีที่แล้ว
    const NOW2 = Math.floor(Date.now() / 1000);
    const alerts = [
      mkAlert({ device: 'CAM-1', zone: 'Zone-L', timestamp: OLD  }),  // เก่าเกิน 5 นาที
      mkAlert({ device: 'CAM-2', zone: 'Zone-L', timestamp: NOW2 }),  // ล่าสุด
    ];
    // lookbackSec=300 จะตัด OLD ออก → เหลือ device เดียว → ไม่สร้างกลุ่ม
    const groups = correlate(alerts, { lookbackSec: 300, timeWindowSec: 120 });
    expect(groups).toHaveLength(0);
  });
});

// ── กรณีที่ 7: ตรวจ output structure ─────────────────────────────────────────
describe('Output structure', () => {
  const NOW = Math.floor(Date.now() / 1000);

  it('group มี field ครบตาม spec', () => {
    const alerts = [
      mkAlert({ device: 'CAM-1', type: 'camera', zone: 'Zone-M', source: 'hikcentral', timestamp: NOW,      severity: 3 }),
      mkAlert({ device: 'AP-1',  type: 'ap',     zone: 'Zone-M', source: 'omada',      timestamp: NOW + 40, severity: 2 }),
    ];
    const [g] = correlate(alerts, WIDE_OPTS);
    expect(g).toHaveProperty('zone',           'Zone-M');
    expect(g).toHaveProperty('devices');
    expect(g).toHaveProperty('types');
    expect(g).toHaveProperty('startTime',      NOW);
    expect(g).toHaveProperty('confidence');
    expect(g).toHaveProperty('hasInfraDevice', false);

    expect(g.devices[0]).toHaveProperty('device');
    expect(g.devices[0]).toHaveProperty('type');
    expect(g.devices[0]).toHaveProperty('source');
    expect(g.devices[0]).toHaveProperty('timestamp');
    expect(g.devices[0]).toHaveProperty('severity');
  });

  it('startTime เท่ากับ timestamp ของ alert ที่เก่าสุดในกลุ่ม', () => {
    const alerts = [
      mkAlert({ device: 'AP-1',  zone: 'Zone-N', timestamp: NOW + 50 }), // เกิดหลัง
      mkAlert({ device: 'CAM-1', zone: 'Zone-N', timestamp: NOW }),       // เกิดก่อน
    ];
    const [g] = correlate(alerts, WIDE_OPTS);
    expect(g.startTime).toBe(NOW); // ต้องเป็นของที่เก่าสุด
  });
});
