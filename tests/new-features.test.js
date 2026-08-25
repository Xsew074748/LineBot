'use strict';
// Unit Tests สำหรับ 5 ฟีเจอร์ใหม่: Switch/Gateway, Client details, Region names,
// Host metrics, Switch ports — รัน: npm test

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
  apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

jest.mock('axios');
const axios = require('axios');

// axios.post ใช้ตรงใน zabbix.js (ไม่ผ่าน .create())
axios.post = jest.fn();

// omada.js และ hikcentral.js เรียก axios.create() คนละครั้งตอน module load
// mockImplementationOnce 2 อัน — ตามลำดับ require ด้านล่าง (omada ก่อน hikcentral)
const omadaHttpMock = { get: jest.fn(), post: jest.fn() };
const hikHttpMock   = { get: jest.fn(), post: jest.fn() };
axios.create = jest.fn()
  .mockImplementationOnce(() => omadaHttpMock)
  .mockImplementationOnce(() => hikHttpMock);

const omada      = require('../services/omada');
const hikcentral = require('../services/hikcentral');
const zabbix     = require('../services/zabbix');
const fmt        = require('../services/formatter');

function resetHttpMocks() {
  omadaHttpMock.get.mockReset();
  omadaHttpMock.post.mockReset();
  hikHttpMock.get.mockReset();
  hikHttpMock.post.mockReset();
  axios.post.mockReset();
}

// ── Omada: token helper — ทุก request ต้อง fetch token ก่อน ────────────────────
function mockOmadaToken() {
  omadaHttpMock.post.mockImplementation((url) => {
    if (String(url).includes('/authorize/token')) {
      return Promise.resolve({ data: { errorCode: 0, result: { accessToken: 'tok', expiresIn: 7200 } } });
    }
    return Promise.reject(new Error('unexpected omada POST ' + url));
  });
}

describe('omada.getAPs()', () => {
  beforeEach(() => { resetHttpMocks(); mockOmadaToken(); });

  it('คืน { aps, switches, gateways, all } แยกตาม type ถูกต้อง', async () => {
    omadaHttpMock.get.mockResolvedValue({
      data: {
        errorCode: 0,
        result: {
          data: [
            { name: 'AP01', ip: '192.168.1.10', status: 1, mac: 'AA-BB-CC-DD-EE-01', model: 'EAP', type: 'ap' },
            { name: 'SW01', ip: '192.168.1.2',  status: 1, mac: 'AA-BB-CC-DD-EE-02', model: 'SG',  type: 'switch' },
            { name: 'GW01', ip: '192.168.1.1',  status: 0, mac: 'AA-BB-CC-DD-EE-03', model: 'ER',  type: 'gateway' },
          ],
          totalRows: 3,
        },
      },
    });

    const result = await omada.getAPs();
    expect(result.aps).toHaveLength(1);
    expect(result.switches).toHaveLength(1);
    expect(result.gateways).toHaveLength(1);
    expect(result.all).toHaveLength(3);
    expect(result.aps[0].status).toBe('up');
    expect(result.gateways[0].status).toBe('down');
  });

  it('วนดึงทุกหน้าจนครบเมื่อ devices เกิน 1 หน้า (regression F-8)', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      name: `AP${i}`, ip: '192.168.1.' + i, status: 1, mac: 'M' + i, model: 'EAP', type: 'ap',
    }));
    const page2 = [{ name: 'AP100', ip: '192.168.1.200', status: 1, mac: 'M100', model: 'EAP', type: 'ap' }];

    let callCount = 0;
    omadaHttpMock.get.mockImplementation(() => {
      callCount++;
      const data = callCount === 1 ? page1 : page2;
      return Promise.resolve({ data: { errorCode: 0, result: { data, totalRows: 101 } } });
    });

    const result = await omada.getAPs();
    expect(callCount).toBe(2); // หน้าแรกเต็ม 100 → ต้องไปหน้าสอง
    expect(result.all).toHaveLength(101);
  });

  it('ไม่ throw เมื่อไม่มี switch/gateway เลย (edge case)', async () => {
    omadaHttpMock.get.mockResolvedValue({
      data: { errorCode: 0, result: { data: [{ name: 'AP01', ip: '1.1.1.1', status: 1, mac: 'M', model: 'EAP', type: 'ap' }], totalRows: 1 } },
    });
    const result = await omada.getAPs();
    expect(result.switches).toEqual([]);
    expect(result.gateways).toEqual([]);
  });
});

describe('omada.getClients()', () => {
  beforeEach(() => { resetHttpMocks(); mockOmadaToken(); });

  it('คืน { total, wireless, wired, clients[] } พร้อม field fallback', async () => {
    omadaHttpMock.get.mockResolvedValue({
      data: {
        errorCode: 0,
        result: {
          data: [
            { name: 'Phone', ip: '192.168.2.1', mac: 'AA-01', ssid: 'CorpWiFi', apName: 'AP01', signalLevel: 90, trafficDown: 100, trafficUp: 50, wireless: true },
            { hostName: 'PC-01', mac: 'AA-02', wireless: false }, // ไม่มี name → fallback hostName, ไม่มี traffic
          ],
          totalRows: 2,
        },
      },
    });

    const result = await omada.getClients();
    expect(result.total).toBe(2);
    expect(result.wireless).toBe(1);
    expect(result.wired).toBe(1);
    expect(result.clients[0].name).toBe('Phone');
    expect(result.clients[0].traffic).toEqual({ down: 100, up: 50 });
    expect(result.clients[1].name).toBe('PC-01'); // fallback จาก hostName
    expect(result.clients[1].traffic).toBeNull();
  });

  it('total = 0 ไม่ throw และคืน array ว่าง (edge case)', async () => {
    omadaHttpMock.get.mockResolvedValue({
      data: { errorCode: 0, result: { data: [], totalRows: 0 } },
    });
    const result = await omada.getClients();
    expect(result.total).toBe(0);
    expect(result.clients).toEqual([]);
  });

  it('คืน unavailable:true เมื่อ API ล้มเหลว (ไม่ throw ทำให้ client/summary พัง)', async () => {
    omadaHttpMock.get.mockRejectedValue(new Error('network down'));
    const result = await omada.getClients();
    expect(result.unavailable).toBe(true);
    expect(result.clients).toEqual([]);
  });
});

describe('omada.getSwitchPorts()', () => {
  beforeEach(() => { resetHttpMocks(); mockOmadaToken(); });

  it('map field แบบ flat (linkStatus/linkSpeed/poe ตรงระดับบนสุด)', async () => {
    omadaHttpMock.get.mockResolvedValue({
      data: {
        errorCode: 0,
        result: [
          { port: 1, name: 'Uplink', linkStatus: 1, linkSpeed: 3, poe: 1, clientMac: 'AA-BB' },
        ],
      },
    });
    const ports = await omada.getSwitchPorts('AA-BB-CC-DD-EE-FF');
    expect(ports[0]).toEqual({ portId: 1, name: 'Uplink', status: 'up', speed: '1G', poeStatus: 'on', clientMac: 'AA-BB' });
  });

  it('map field แบบซ้อน portStatus.{linkStatus,linkSpeed,poe} (controller รุ่นอื่น)', async () => {
    omadaHttpMock.get.mockResolvedValue({
      data: {
        errorCode: 0,
        result: [
          { portId: 5, profileName: 'Port5', portStatus: { linkStatus: 0, linkSpeed: 0 }, deviceMac: null },
        ],
      },
    });
    const ports = await omada.getSwitchPorts('AA-BB-CC-DD-EE-FF');
    expect(ports[0].portId).toBe(5);
    expect(ports[0].name).toBe('Port5');
    expect(ports[0].status).toBe('down');
    expect(ports[0].poeStatus).toBeNull();
  });

  it('normalize MAC ทั้ง : และตัวพิมพ์เล็กเป็นรูปแบบเดียวกัน (- ตัวพิมพ์ใหญ่) ก่อนยิง request', async () => {
    omadaHttpMock.get.mockResolvedValue({ data: { errorCode: 0, result: [] } });
    await omada.getSwitchPorts('aa:bb:cc:dd:ee:ff');
    const calledPath = omadaHttpMock.get.mock.calls[0][0];
    expect(calledPath).toContain('AA-BB-CC-DD-EE-FF');
  });

  it('ไม่มี port เลยคืน array ว่าง (edge case)', async () => {
    omadaHttpMock.get.mockResolvedValue({ data: { errorCode: 0, result: [] } });
    const ports = await omada.getSwitchPorts('AA-BB-CC-DD-EE-FF');
    expect(ports).toEqual([]);
  });
});

describe('zabbix.getHostMetrics()', () => {
  beforeEach(() => { resetHttpMocks(); });

  it('คืน { cpu, memory, disk } โดย memory แปลงเป็น % used (100 - pavailable)', async () => {
    axios.post.mockImplementation((url, body) => {
      if (body.method === 'item.get') {
        return Promise.resolve({ data: { result: [
          { itemid: '1', key_: 'system.cpu.util', lastvalue: '12.5', lastclock: '1753940000', value_type: '0' },
          { itemid: '2', key_: 'vm.memory.size[pavailable]', lastvalue: '20', lastclock: '1753940000', value_type: '0' },
          { itemid: '3', key_: 'vfs.fs.size[/,pused]', lastvalue: '55', lastclock: '1753940000', value_type: '0' },
        ] } });
      }
      if (body.method === 'history.get') {
        return Promise.resolve({ data: { result: [] } }); // ว่าง → fallback ไปใช้ lastvalue
      }
      return Promise.reject(new Error('unexpected method ' + body.method));
    });

    const metrics = await zabbix.getHostMetrics('100');
    expect(metrics.cpu.percent).toBe(12.5);
    expect(metrics.memory.percent).toBe(80); // 100 - 20
    expect(metrics.disk.percent).toBe(55);
  });

  it('host ไม่มี item CPU/RAM/Disk เลย → คืน null ทั้งหมด ไม่ throw (edge case)', async () => {
    axios.post.mockImplementation((url, body) => {
      if (body.method === 'item.get') return Promise.resolve({ data: { result: [] } });
      return Promise.reject(new Error('unexpected method ' + body.method));
    });

    const metrics = await zabbix.getHostMetrics('999999');
    expect(metrics).toEqual({ cpu: null, memory: null, disk: null });
  });
});

describe('zabbix.getHosts() — available มาจาก interfaces[0] (host-level available ถูก Zabbix เลิกคืนแล้ว)', () => {
  beforeEach(() => { resetHttpMocks(); });

  it('host มี interfaces[0].available = 1 → นับเป็น up (available=1)', async () => {
    axios.post.mockResolvedValue({ data: { result: [
      { hostid: '1', host: 'srv01', name: 'srv01', status: '0', interfaces: [{ ip: '10.0.0.1', available: '1' }] },
    ] } });
    const hosts = await zabbix.getHosts();
    expect(hosts[0].available).toBe(1);
  });

  it('host มี interfaces[0].available = 2 → นับเป็น down (available=2)', async () => {
    axios.post.mockResolvedValue({ data: { result: [
      { hostid: '2', host: 'srv02', name: 'srv02', status: '0', interfaces: [{ ip: '10.0.0.2', available: '2' }] },
    ] } });
    const hosts = await zabbix.getHosts();
    expect(hosts[0].available).toBe(2);
  });

  it('host ไม่มี interfaces เลย → fallback ใช้ status (monitored=0 → available=1)', async () => {
    axios.post.mockResolvedValue({ data: { result: [
      { hostid: '3', host: 'srv03', name: 'srv03', status: '0', interfaces: [] },
    ] } });
    const hosts = await zabbix.getHosts();
    expect(hosts[0].available).toBe(1);
  });
});

describe('hikcentral.getRegions() + region cache', () => {
  beforeEach(() => { resetHttpMocks(); });

  it('วนดึงทุกหน้าจนครบและ map indexCode/name ถูกต้อง', async () => {
    let page = 0;
    hikHttpMock.post.mockImplementation((url) => {
      expect(url).toContain('/regions');
      page++;
      if (page === 1) {
        return Promise.resolve({ data: { code: '0', data: { list: [
          { indexCode: '1', name: 'อาคาร A' }, { indexCode: '2', name: 'อาคาร B' },
        ], total: 3 } } });
      }
      return Promise.resolve({ data: { code: '0', data: { list: [{ indexCode: '3', name: 'อาคาร C' }], total: 3 } } });
    });

    const regions = await hikcentral.getRegions(2); // pageSize=2 → บังคับ 2 หน้า
    expect(page).toBe(2);
    expect(regions).toEqual([
      { indexCode: '1', name: 'อาคาร A', parentIndexCode: null },
      { indexCode: '2', name: 'อาคาร B', parentIndexCode: null },
      { indexCode: '3', name: 'อาคาร C', parentIndexCode: null },
    ]);
  });

  it('cache TTL ทำงาน — ไม่ยิง regions ซ้ำภายใน TTL แต่ยิงใหม่หลังหมดอายุ', async () => {
    const regionsList = [{ indexCode: '10', name: 'ไซต์ทดสอบ' }];
    const camerasList = [{ cameraIndexCode: 'c1', cameraName: 'CAM-1', regionIndexCode: '10', status: 1 }];

    let regionCalls = 0;
    hikHttpMock.post.mockImplementation((url) => {
      if (String(url).includes('/regions')) {
        regionCalls++;
        return Promise.resolve({ data: { code: '0', data: { list: regionsList, total: 1 } } });
      }
      if (String(url).includes('/cameras')) {
        return Promise.resolve({ data: { code: '0', data: { list: camerasList, total: 1 } } });
      }
      return Promise.reject(new Error('unexpected url ' + url));
    });

    const t0 = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(t0);

    const first = await hikcentral.getCameras();
    expect(regionCalls).toBe(1);
    expect(first[0].location).toBe('ไซต์ทดสอบ'); // แปล indexCode → ชื่อจริงแล้ว

    nowSpy.mockReturnValue(t0 + 60_000); // +1 นาที ยังอยู่ใน TTL (10 นาที)
    await hikcentral.getCameras();
    expect(regionCalls).toBe(1); // cache hit — ไม่ยิงซ้ำ

    nowSpy.mockReturnValue(t0 + 11 * 60_000); // +11 นาที เกิน TTL
    await hikcentral.getCameras();
    expect(regionCalls).toBe(2); // cache หมดอายุ → ยิงใหม่

    nowSpy.mockRestore();
  });
});

describe('formatter render — ไม่ throw กับข้อมูลปกติและ edge case', () => {
  it('buildClients render ได้ทั้งกรณีมีข้อมูลและว่าง', () => {
    const withData = fmt.buildClients(
      [{ name: 'Phone', ip: '192.168.1.1', mac: 'AA', ssid: 'WiFi', ap: 'AP01', signal: 90, traffic: { down: 100, up: 50 }, wireless: true }],
      { total: 1, wireless: 1, wired: 0 },
      {}
    );
    expect(withData.type).toBe('bubble');

    const empty = fmt.buildClients([], { total: 0, wireless: 0, wired: 0 }, {});
    expect(empty.type).toBe('bubble');
    expect(() => JSON.stringify(empty)).not.toThrow();
  });

  it('buildHostMetrics render ได้ทั้งกรณีมี metric ครบและไม่มีเลย', () => {
    const withData = fmt.buildHostMetrics('SRV-01', '192.168.1.1', {
      cpu: { percent: 45, updatedAt: '31/7/2569' },
      memory: { percent: 80, updatedAt: '31/7/2569' },
      disk: { percent: 55, updatedAt: '31/7/2569' },
    });
    expect(withData.type).toBe('bubble');

    const empty = fmt.buildHostMetrics('SRV-EMPTY', null, { cpu: null, memory: null, disk: null });
    expect(empty.type).toBe('bubble');
    expect(() => JSON.stringify(empty)).not.toThrow();
  });

  it('buildSwitchPorts render ได้ทั้งกรณีมี port และไม่มี port เลย', () => {
    const ports = [{ portId: 1, name: 'Uplink', status: 'up', speed: '1G', poeStatus: 'on', clientMac: 'AA' }];
    const withData = fmt.buildSwitchPorts('SW-01', ports, { page: 1, totalPages: 1 }, ports, {});
    expect(withData.type).toBe('bubble');

    const empty = fmt.buildSwitchPorts('SW-EMPTY', [], { page: 1, totalPages: 1 }, [], {});
    expect(empty.type).toBe('bubble');
    expect(() => JSON.stringify(empty)).not.toThrow();
  });
});
