'use strict';
// สร้างข้อมูลสรุปสำหรับ endpoint /stats — ให้ NetGuard Manager poll เก็บสถิติ
// เป็น pure function รับ dependency เข้ามา (ไม่ผูกกับ index.js) เพื่อ unit test ได้ง่าย

const DEFAULT_TIMEOUT_MS = 4000; // เผื่อ overhead ให้ตอบทันภายใน 5 วินาทีตามที่กำหนด

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error('stats: timeout')), ms);
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

function countUpDown(items, isUp) {
  const up = items.filter(isUp).length;
  return { total: items.length, up, down: items.length - up };
}

function processProblemCounts(problems) {
  const counts = { total: problems.length, disaster: 0, high: 0, average: 0, warning: 0 };
  for (const p of problems) {
    if      (p.priority === 5) counts.disaster++;
    else if (p.priority === 4) counts.high++;
    else if (p.priority === 3) counts.average++;
    else if (p.priority === 2) counts.warning++;
  }
  return counts;
}

// deps:
//   monitorKeys — array ชื่อ monitor ที่ enabled เช่น ['zabbix','omada','hikcentral']
//   zabbix, omada, hikcentral — service module หรือ null ถ้าไม่ได้เปิดใช้งาน
//   timeoutMs — จำกัดเวลาต่อ monitor call กัน manager รอนาน
//
// ติดตามความสำเร็จ/ล้มเหลวแยกราย "monitor" (ไม่ใช่รายชนิดข้อมูล) — zabbix มีทั้ง
// problems/hosts/cameras ถ้าตัวใดตัวหนึ่ง timeout/fail ถือว่า zabbix เป็น partial
async function buildStats({ monitorKeys = [], zabbix = null, omada = null, hikcentral = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const jobs = {};
  if (zabbix)     jobs.problems    = withTimeout(zabbix.getProblems(200), timeoutMs);
  if (zabbix)     jobs.hosts       = withTimeout(zabbix.getHosts(200), timeoutMs);
  if (zabbix)     jobs.zCameras    = withTimeout(zabbix.getCameras(), timeoutMs);
  if (omada)      jobs.aps         = withTimeout(omada.getAPs(), timeoutMs);
  if (hikcentral) jobs.hikCameras  = withTimeout(hikcentral.getCameras(1, 1000), timeoutMs);

  const keys    = Object.keys(jobs);
  const settled = await Promise.allSettled(keys.map((k) => jobs[k]));
  const results = {};
  keys.forEach((k, i) => { results[k] = settled[i]; });

  const ok  = (key) => results[key] && results[key].status === 'fulfilled';
  const val = (key, fallback) => (ok(key) ? results[key].value : fallback);

  const failed = new Set();
  if (zabbix     && !(ok('problems') && ok('hosts') && ok('zCameras'))) failed.add('zabbix');
  if (omada      && !ok('aps'))                                        failed.add('omada');
  if (hikcentral && !ok('hikCameras'))                                 failed.add('hikcentral');

  const stats = {
    ok: true,
    timestamp: new Date().toISOString(),
    monitors: monitorKeys,
  };

  if (zabbix) {
    stats.problems = processProblemCounts(val('problems', []));

    stats.devices = stats.devices || {};
    stats.devices.hosts = countUpDown(val('hosts', []), (h) => h.available === 1);
  }

  if (omada) {
    const apsData = val('aps', {});
    stats.devices = stats.devices || {};
    stats.devices.aps      = countUpDown(apsData.aps || [],      (d) => d.status === 'up');
    stats.devices.switches = countUpDown(apsData.switches || [], (d) => d.status === 'up');
  }

  if (zabbix || hikcentral) {
    const cams = [...val('zCameras', []), ...val('hikCameras', [])];
    stats.devices = stats.devices || {};
    stats.devices.cameras = countUpDown(cams, (c) => (c.available !== undefined ? c.available === 1 : c.online === true));
  }

  if (failed.size > 0) {
    stats.partial = true;
    stats.failed  = [...failed];
  }

  return stats;
}

module.exports = { buildStats };
