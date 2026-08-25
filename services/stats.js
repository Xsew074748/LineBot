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
//   zabbix, omada — service module หรือ null ถ้าไม่ได้เปิดใช้งาน
//   getCameras — async function คืน array กล้อง (รวมจากทุก monitor) หรือ null ถ้าไม่มีกล้องเลย
//   timeoutMs — จำกัดเวลาต่อ monitor call กัน manager รอนาน
async function buildStats({ monitorKeys = [], zabbix = null, omada = null, getCameras = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const [problemsR, hostsR, apsR, camsR] = await Promise.allSettled([
    zabbix     ? withTimeout(zabbix.getProblems(200), timeoutMs) : Promise.resolve(null),
    zabbix     ? withTimeout(zabbix.getHosts(200), timeoutMs)    : Promise.resolve(null),
    omada      ? withTimeout(omada.getAPs(), timeoutMs)          : Promise.resolve(null),
    getCameras ? withTimeout(getCameras(), timeoutMs)            : Promise.resolve(null),
  ]);

  const stats = {
    ok: true,
    timestamp: new Date().toISOString(),
    monitors: monitorKeys,
  };

  if (zabbix) {
    const problems = problemsR.status === 'fulfilled' && problemsR.value ? problemsR.value : [];
    stats.problems = processProblemCounts(problems);

    const hosts = hostsR.status === 'fulfilled' && hostsR.value ? hostsR.value : [];
    stats.devices = stats.devices || {};
    stats.devices.hosts = countUpDown(hosts, (h) => h.available === 1);
  }

  if (omada) {
    const aps      = (apsR.status === 'fulfilled' && apsR.value?.aps)      || [];
    const switches = (apsR.status === 'fulfilled' && apsR.value?.switches) || [];
    stats.devices = stats.devices || {};
    stats.devices.aps      = countUpDown(aps,      (d) => d.status === 'up');
    stats.devices.switches = countUpDown(switches, (d) => d.status === 'up');
  }

  if (getCameras) {
    const cams = (camsR.status === 'fulfilled' && camsR.value) || [];
    stats.devices = stats.devices || {};
    stats.devices.cameras = countUpDown(cams, (c) => (c.available !== undefined ? c.available === 1 : c.online === true));
  }

  return stats;
}

module.exports = { buildStats };
