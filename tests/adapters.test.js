'use strict';
// Unit tests สำหรับ adapter layer — ตรวจสอบว่า adapter แปลง response เป็น normalized format ถูกต้อง
// รัน: npm test

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
  apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

// ── Mock services ที่ adapter ใช้ ──────────────────────────────────────────────
jest.mock('../services/zabbix', () => ({
  healthCheck: jest.fn(),
  getProblems: jest.fn(),
  getHosts:    jest.fn(),
}));

jest.mock('../services/omada', () => ({
  healthCheck: jest.fn(),
  getAlerts:   jest.fn(),
  getAPs:      jest.fn(),
}));

jest.mock('../services/hikcentral', () => ({
  healthCheck: jest.fn(),
  getCameras:  jest.fn(),
}));

const ZabbixAdapter     = require('../adapters/zabbix');
const OmadaAdapter      = require('../adapters/omada');
const HikCentralAdapter = require('../adapters/hikcentral');

const zabbixSvc  = require('../services/zabbix');
const omadaSvc   = require('../services/omada');
const hikSvc     = require('../services/hikcentral');

// ── ZabbixAdapter ──────────────────────────────────────────────────────────────
describe('ZabbixAdapter', () => {
  let adapter;
  beforeEach(() => {
    adapter = new ZabbixAdapter();
    jest.clearAllMocks();
  });

  // ── testConnection ─────────────────────────────────────────────────────────
  describe('testConnection()', () => {
    it('คืน { ok: true } เมื่อ Zabbix ตอบสนอง', async () => {
      zabbixSvc.healthCheck.mockResolvedValue({ ok: true, name: 'Zabbix' });
      const r = await adapter.testConnection();
      expect(r.ok).toBe(true);
      expect(typeof r.message).toBe('string');
    });

    it('คืน { ok: false, message } เมื่อ Zabbix ไม่ตอบสนอง', async () => {
      zabbixSvc.healthCheck.mockResolvedValue({ ok: false, name: 'Zabbix', error: 'Connection refused' });
      const r = await adapter.testConnection();
      expect(r.ok).toBe(false);
      expect(r.message).toBe('Connection refused');
    });

    it('คืน { ok: false } เมื่อ healthCheck โยน error', async () => {
      zabbixSvc.healthCheck.mockRejectedValue(new Error('Network timeout'));
      const r = await adapter.testConnection();
      expect(r.ok).toBe(false);
    });
  });

  // ── getProblems ────────────────────────────────────────────────────────────
  describe('getProblems()', () => {
    const mockProblems = [
      {
        id: '100', description: 'Camera offline',
        priority: 4, priorityLabel: 'สูง', priorityIcon: '🔴',
        host: 'CAM-BLD-A-01', lastChange: '11/06/2569 10:30:00',
        lastchangeTs: 1749600000, comments: '',
      },
      {
        id: '200', description: 'Server unreachable',
        priority: 2, priorityLabel: 'คำเตือน', priorityIcon: '🟡',
        host: 'SRV-CORE-01', lastChange: '11/06/2569 09:00:00',
        lastchangeTs: 1749594000, comments: '',
      },
    ];

    it('คืน array ของ normalized problems', async () => {
      zabbixSvc.getProblems.mockResolvedValue(mockProblems);
      const result = await adapter.getProblems();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(2);
    });

    it('มี field ครบตาม normalized format', async () => {
      zabbixSvc.getProblems.mockResolvedValue([mockProblems[0]]);
      const [item] = await adapter.getProblems();
      expect(item).toHaveProperty('source',    'zabbix');
      expect(item).toHaveProperty('device',    'CAM-BLD-A-01');
      expect(item).toHaveProperty('zone');
      expect(item).toHaveProperty('type');
      expect(item).toHaveProperty('status',    'problem');
      expect(item).toHaveProperty('timestamp', 1749600000);
      expect(item).toHaveProperty('ip',        null);
      expect(item).toHaveProperty('severity',  4);
    });

    it('ตรวจจับ type "camera" จากชื่อ host ที่ขึ้นต้นด้วย CAM', async () => {
      zabbixSvc.getProblems.mockResolvedValue([mockProblems[0]]);
      const [item] = await adapter.getProblems();
      expect(item.type).toBe('camera');
    });

    it('ตรวจจับ type "host" จากชื่อ SRV-CORE-01', async () => {
      zabbixSvc.getProblems.mockResolvedValue([mockProblems[1]]);
      const [item] = await adapter.getProblems();
      expect(item.type).toBe('host');
    });

    it('คืน array เปล่าเมื่อไม่มี problem', async () => {
      zabbixSvc.getProblems.mockResolvedValue([]);
      const result = await adapter.getProblems();
      expect(result).toHaveLength(0);
    });

    it('โยน error ถ้า service ล้มเหลว (เพื่อให้ caller ใช้ Promise.allSettled)', async () => {
      zabbixSvc.getProblems.mockRejectedValue(new Error('Zabbix down'));
      await expect(adapter.getProblems()).rejects.toThrow('Zabbix down');
    });
  });

  // ── getDevices ─────────────────────────────────────────────────────────────
  describe('getDevices()', () => {
    const mockHosts = [
      { id: '1', name: 'CAM-BLD-A-01', available: 2, status: '🔴 ออฟไลน์', groups: 'Camera, Floor A' },
      { id: '2', name: 'SRV-CORE-01',  available: 1, status: '🟢 ออนไลน์',  groups: 'Servers' },
      { id: '3', name: 'SW-CORE-01',   available: 1, status: '🟢 ออนไลน์',  groups: 'Network, Switch' },
    ];

    it('คืน array ของ normalized devices', async () => {
      zabbixSvc.getHosts.mockResolvedValue(mockHosts);
      const result = await adapter.getDevices();
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(3);
    });

    it('มี field ครบตาม normalized format', async () => {
      zabbixSvc.getHosts.mockResolvedValue([mockHosts[0]]);
      const [item] = await adapter.getDevices();
      expect(item).toHaveProperty('device', 'CAM-BLD-A-01');
      expect(item).toHaveProperty('zone');
      expect(item).toHaveProperty('type',   'camera');
      expect(item).toHaveProperty('status', 'down');
      expect(item).toHaveProperty('ip',     null);
    });

    it('แปลง available=1 → status "up"', async () => {
      zabbixSvc.getHosts.mockResolvedValue([mockHosts[1]]);
      const [item] = await adapter.getDevices();
      expect(item.status).toBe('up');
    });

    it('แปลง available=2 → status "down"', async () => {
      zabbixSvc.getHosts.mockResolvedValue([mockHosts[0]]);
      const [item] = await adapter.getDevices();
      expect(item.status).toBe('down');
    });

    it('ตรวจจับ type "camera" จาก groups "Camera, Floor A"', async () => {
      zabbixSvc.getHosts.mockResolvedValue([mockHosts[0]]);
      const [item] = await adapter.getDevices();
      expect(item.type).toBe('camera');
    });

    it('ตรวจจับ type "switch" จาก groups "Network, Switch"', async () => {
      zabbixSvc.getHosts.mockResolvedValue([mockHosts[2]]);
      const [item] = await adapter.getDevices();
      expect(item.type).toBe('switch');
    });

    it('ตรวจจับ type "host" จาก groups "Servers"', async () => {
      zabbixSvc.getHosts.mockResolvedValue([mockHosts[1]]);
      const [item] = await adapter.getDevices();
      expect(item.type).toBe('host');
    });
  });
});

// ── OmadaAdapter ───────────────────────────────────────────────────────────────
describe('OmadaAdapter', () => {
  let adapter;
  beforeEach(() => {
    adapter = new OmadaAdapter();
    jest.clearAllMocks();
  });

  describe('testConnection()', () => {
    it('คืน { ok: true } เมื่อ login สำเร็จ', async () => {
      omadaSvc.healthCheck.mockResolvedValue({ ok: true, name: 'Omada WiFi' });
      const r = await adapter.testConnection();
      expect(r.ok).toBe(true);
    });

    it('คืน { ok: false } เมื่อ login ล้มเหลว', async () => {
      omadaSvc.healthCheck.mockResolvedValue({ ok: false, name: 'Omada WiFi', error: 'Invalid credentials' });
      const r = await adapter.testConnection();
      expect(r.ok).toBe(false);
      expect(r.message).toBe('Invalid credentials');
    });
  });

  describe('getProblems()', () => {
    it('แปลง Omada alerts เป็น normalized problems', async () => {
      omadaSvc.getAlerts.mockResolvedValue([
        { name: 'AP-Floor-1', time: '11/06/2569 10:00:00', level: '🔴 วิกฤต' },
        { name: 'AP-Floor-2', time: '11/06/2569 09:00:00', level: '⚠️ เตือน' },
      ]);
      const result = await adapter.getProblems();
      expect(result).toHaveLength(2);
      expect(result[0].source).toBe('omada');
      expect(result[0].type).toBe('ap');
      expect(result[0].status).toBe('problem');
      expect(result[0].severity).toBe(5); // วิกฤต
      expect(result[1].severity).toBe(2); // เตือน
    });
  });

  describe('getDevices()', () => {
    it('แปลง Omada APs เป็น normalized devices', async () => {
      omadaSvc.getAPs.mockResolvedValue([
        { name: 'AP-Floor-1', mac: 'AA:BB:CC:DD:EE:01', status: '🟢 เชื่อมต่อ',     clients: 12, model: 'EAP660' },
        { name: 'AP-Floor-2', mac: 'AA:BB:CC:DD:EE:02', status: '🔴 ไม่เชื่อมต่อ', clients: 0,  model: 'EAP670' },
      ]);
      const result = await adapter.getDevices();
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('ap');
      expect(result[0].status).toBe('up');
      expect(result[1].status).toBe('down');
    });
  });
});

// ── HikCentralAdapter ──────────────────────────────────────────────────────────
describe('HikCentralAdapter', () => {
  let adapter;
  beforeEach(() => {
    adapter = new HikCentralAdapter();
    jest.clearAllMocks();
  });

  describe('testConnection()', () => {
    it('คืน { ok: true } เมื่อ login สำเร็จ', async () => {
      hikSvc.healthCheck.mockResolvedValue({ ok: true, name: 'HikCentral' });
      const r = await adapter.testConnection();
      expect(r.ok).toBe(true);
    });
  });

  describe('getProblems()', () => {
    it('แสดงเฉพาะกล้องที่ offline', async () => {
      hikSvc.getCameras.mockResolvedValue([
        { id: '1', name: 'CAM-A-01', location: 'อาคาร A ชั้น 1', status: '🟢 ออนไลน์', online: true,  offlineSince: null, duration: '' },
        { id: '2', name: 'CAM-A-02', location: 'อาคาร A ชั้น 2', status: '🔴 ออฟไลน์', online: false, offlineSince: '11/06/2569 08:00:00', duration: '2 ชม. 30 นาที' },
      ]);
      const result = await adapter.getProblems();
      expect(result).toHaveLength(1);
      expect(result[0].source).toBe('hikcentral');
      expect(result[0].device).toBe('CAM-A-02');
      expect(result[0].type).toBe('camera');
      expect(result[0].status).toBe('problem');
      expect(result[0].severity).toBe(3);
      expect(result[0].zone).toBe('อาคาร A ชั้น 2');
    });

    it('คืน array เปล่าเมื่อทุกกล้อง online', async () => {
      hikSvc.getCameras.mockResolvedValue([
        { id: '1', name: 'CAM-A-01', location: 'อาคาร A', online: true, offlineSince: null, duration: '' },
      ]);
      const result = await adapter.getProblems();
      expect(result).toHaveLength(0);
    });
  });

  describe('getDevices()', () => {
    it('แปลงกล้องทั้งหมดเป็น normalized devices', async () => {
      hikSvc.getCameras.mockResolvedValue([
        { id: '1', name: 'CAM-A-01', location: 'อาคาร A', online: true,  offlineSince: null, duration: '' },
        { id: '2', name: 'CAM-B-01', location: 'N/A',     online: false, offlineSince: 'xxx', duration: '1 ชม.' },
      ]);
      const result = await adapter.getDevices();
      expect(result).toHaveLength(2);
      expect(result[0].type).toBe('camera');
      expect(result[0].status).toBe('up');
      expect(result[1].status).toBe('down');
      expect(result[1].zone).toBe('ไม่ระบุ'); // N/A → ไม่ระบุ
    });
  });
});

// ── BaseMonitorAdapter ─────────────────────────────────────────────────────────
describe('BaseMonitorAdapter', () => {
  const BaseMonitorAdapter = require('../adapters/base');

  it('โยน Error เมื่อเรียก testConnection โดยตรง', async () => {
    const base = new BaseMonitorAdapter();
    await expect(base.testConnection()).rejects.toThrow('ต้อง implement');
  });

  it('โยน Error เมื่อเรียก getProblems โดยตรง', async () => {
    const base = new BaseMonitorAdapter();
    await expect(base.getProblems()).rejects.toThrow('ต้อง implement');
  });

  it('โยน Error เมื่อเรียก getDevices โดยตรง', async () => {
    const base = new BaseMonitorAdapter();
    await expect(base.getDevices()).rejects.toThrow('ต้อง implement');
  });
});
