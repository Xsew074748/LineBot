'use strict';
// index.js เปิดเซิร์ฟเวอร์ตอน require จึงทดสอบพฤติกรรมตรงๆ ไม่ได้ — ตรวจรูปแบบซอร์สของจุดที่ต้องใช้ effective
// (แบบเดียวกับ tests/offline-camera-cache.test.js และ push-targets.test.js)

const fs = require('fs');
const path = require('path');
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
const index = read('index.js');
const zabbixSvc = read('services/zabbix.js');
const adapter = read('adapters/zabbix.js');
const mcp = read('mcp-server/index.js');

describe('index.js — host / summary / วิเคราะห์ ใช้ effective', () => {
  it('คำสั่ง host ขอ getHosts(50, { effective: true })', () => {
    expect(index).toMatch(/zabbix\.getHosts\(50,\s*\{\s*effective:\s*true\s*\}\)/);
  });

  it('วิเคราะห์ host (gatherAnalyzeContext) ขอ getHosts(200, { effective: true })', () => {
    expect(index).toMatch(/zabbix\.getHosts\(200,\s*\{\s*effective:\s*true\s*\}\)/);
  });

  it('ข้อความบริบท summary ใช้ countView ไม่นับ available === 1 เอง', () => {
    expect(index).toMatch(/countView\(z\.hosts\)/);
    expect(index).not.toMatch(/z\.hosts\?\.filter\(\(h2\) => h2\.available === 1\)/);
  });
});

describe('services/zabbix.js — getSummary และ getHosts', () => {
  it('getSummary ขอ getHosts แบบ effective', () => {
    expect(zabbixSvc).toMatch(/getHosts\(200,\s*\{\s*effective:\s*true\s*\}\)/);
  });

  it('getHosts รับ opts และ export ตัวรีเซ็ตสถานะ log สำหรับเทสต์', () => {
    expect(zabbixSvc).toMatch(/async function getHosts\(limit = 100, opts = \{\}\)/);
    expect(zabbixSvc).toMatch(/_resetEffectiveLogState/);
  });
});

describe('adapters/zabbix.js และ mcp-server', () => {
  it('getDevices ไม่ใช้ available === 1 ? up : down อีก', () => {
    expect(adapter).not.toMatch(/h\.available === 1 \? 'up' : 'down'/);
    expect(adapter).toMatch(/getHosts\(200,\s*\{\s*effective:\s*true\s*\}\)/);
  });

  it('mcp get_status_summary นับ unknown แยก (ไม่ให้ up + down < total เงียบๆ)', () => {
    expect(mcp).toMatch(/const unknown = devices\.filter\(d => d\.status === 'unknown'\)\.length;/);
    expect(mcp).toMatch(/summary\.total\.unknown \+= unknown;/);
  });
});
