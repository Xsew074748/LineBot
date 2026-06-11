'use strict';
require('dotenv').config();
const axios  = require('axios');
const logger = require('./logger');

const BASE_URL = process.env.ZABBIX_URL || '';
const API_TOKEN = process.env.ZABBIX_API_TOKEN || '';

// ── Priority label ─────────────────────────────────────────────────────────────
const PRIORITY = {
  0: { label: 'ไม่ระบุ', icon: '⚪' },
  1: { label: 'ข้อมูล',  icon: '🔵' },
  2: { label: 'คำเตือน', icon: '🟡' },
  3: { label: 'ปานกลาง', icon: '🟠' },
  4: { label: 'สูง',     icon: '🔴' },
  5: { label: 'วิกฤต',  icon: '🟣' },
};

// ── ยิง JSON-RPC ไปที่ Zabbix ─────────────────────────────────────────────────
// Zabbix 7.x: auth ย้ายออกจาก JSON body มาเป็น HTTP header "Authorization: Bearer"
// apiinfo.version เป็น public method — ห้ามส่ง auth header เด็ดขาด (จะได้ [-32600])
async function rpc(method, params, { auth = true } = {}) {
  const start = Date.now();
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers['Authorization'] = `Bearer ${API_TOKEN}`;

    const resp = await axios.post(
      BASE_URL,
      { jsonrpc: '2.0', method, params, id: 1 },
      { headers, timeout: 10_000 }
    );
    logger.apiCall('Zabbix', method, Date.now() - start);

    if (resp.data.error) {
      throw new Error(`Zabbix API Error [${resp.data.error.code}]: ${resp.data.error.data}`);
    }
    return resp.data.result;
  } catch (err) {
    logger.apiCall('Zabbix', method, Date.now() - start, false);
    throw err;
  }
}

// ── ดึง Alert ที่กำลัง Active (เรียงใหม่ → เก่า) ─────────────────────────────
async function getProblems(limit = 200) {
  const triggers = await rpc('trigger.get', {
    only_true: 1,
    active: 1,
    skipDependent: 1,
    monitored: 1,
    filter: { value: '1' },
    selectHosts: ['hostid', 'host', 'name'],
    output: ['triggerid', 'description', 'priority', 'lastchange', 'comments'],
    sortfield: 'lastchange',
    sortorder: 'DESC',
    limit,
  });

  return (triggers || []).map((t) => {
    const ts = parseInt(t.lastchange, 10);
    const p  = parseInt(t.priority, 10);
    return {
      id:            t.triggerid,
      description:   t.description,
      priority:      p,
      priorityLabel: PRIORITY[p]?.label || 'N/A',
      priorityIcon:  PRIORITY[p]?.icon  || '❓',
      host:          t.hosts?.[0]?.name || 'Unknown',
      lastChange:    ts ? new Date(ts * 1000).toLocaleString('th-TH') : 'N/A',
      lastchangeTs:  ts || 0,
      comments:      t.comments || '',
    };
  });
}

// ── ดึง Host ทั้งหมด พร้อมสถานะ ───────────────────────────────────────────────
async function getHosts(limit = 100) {
  const hosts = await rpc('host.get', {
    output: ['hostid', 'host', 'name', 'status', 'available'],
    selectGroups: ['groupid', 'name'],
    selectInterfaces: ['ip'],
    monitored_hosts: 1,
    sortfield: 'name',
    limit,
  });

  const AVAIL = { 0: '❓ ไม่ทราบ', 1: '🟢 ออนไลน์', 2: '🔴 ออฟไลน์' };
  return (hosts || []).map((h) => ({
    id:        h.hostid,
    name:      h.name || h.host,
    available: parseInt(h.available, 10),
    status:    AVAIL[parseInt(h.available, 10)] || '❓',
    groups:    h.groups?.map((g) => g.name).join(', ') || '',
    // ไม่แสดง IP เต็มใน LINE ใช้ชื่อ host แทน (ตาม Security requirement)
  }));
}

// ── ดึง Host ใน Group "Camera" ────────────────────────────────────────────────
async function getCameras() {
  const hosts = await rpc('host.get', {
    output: ['hostid', 'host', 'name', 'available'],
    selectGroups: ['name'],
    groupids: await getCameraGroupIds(),
    monitored_hosts: 1,
    sortfield: 'name',
  });

  const AVAIL = { 0: '❓ ไม่ทราบ', 1: '🟢 ออนไลน์', 2: '🔴 ออฟไลน์' };
  return (hosts || []).map((h) => ({
    id:        h.hostid,
    name:      h.name || h.host,
    available: parseInt(h.available, 10),
    status:    AVAIL[parseInt(h.available, 10)] || '❓',
    groups:    h.groups?.map((g) => g.name).join(', ') || '',
  }));
}

// หา groupid ที่ชื่อมีคำว่า camera, กล้อง, cctv, nvr, dvr
async function getCameraGroupIds() {
  const groups = await rpc('hostgroup.get', {
    output: ['groupid', 'name'],
    search: { name: 'camera' }, // Zabbix search แบบ case-insensitive
  });
  const keywords = ['camera', 'กล้อง', 'cctv', 'nvr', 'dvr', 'ipcam'];
  const filtered = (groups || []).filter((g) =>
    keywords.some((kw) => g.name.toLowerCase().includes(kw))
  );
  return filtered.map((g) => g.groupid);
}

// ── Duration formatter ──────────────────────────────────────────────────────────
function formatDuration(seconds) {
  if (seconds < 60)    return `${seconds}วิ`;
  if (seconds < 3600)  return `${Math.floor(seconds / 60)}น.`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (seconds < 86400) return m ? `${h}ช. ${m}น.` : `${h}ช.`;
  const d  = Math.floor(seconds / 86400);
  const hh = Math.floor((seconds % 86400) / 3600);
  return hh ? `${d}วัน ${hh}ช.` : `${d}วัน`;
}

const CAMERA_PAGE_SIZE = 10;
const CAMERA_MASS_FAIL = 30;

// ── ดึง offline cameras ทั้งหมดจาก Zabbix (ใช้ใน background poller) ──────────
// คืน { allOffline, total, groups, clockMap }
async function fetchOfflineCamerasRaw() {
  const groupIds = await getCameraGroupIds();
  if (!groupIds.length) return { allOffline: [], total: 0, groups: [], clockMap: {} };

  // host.get กรอง available=2 ที่ server — ไม่ดึง host ทั้งหมดมากรองเอง
  const allOffline = await rpc('host.get', {
    output: ['hostid', 'host', 'name'],
    groupids: groupIds,
    filter: { available: '2' },
    selectInterfaces: ['ip', 'type', 'main'],
    selectInventory: ['location'],
    monitored_hosts: 1,
    sortfield: 'name',
  });

  const total = allOffline.length;

  // จัดกลุ่มตามตำแหน่ง (ไม่ต้อง API เพิ่ม)
  const locMap = {};
  for (const h of allOffline) {
    const loc      = h.inventory?.location || 'ไม่ระบุตำแหน่ง';
    const building = loc.split(/[,/\n]/)[0].trim() || loc;
    locMap[building] = (locMap[building] || 0) + 1;
  }
  const groups = Object.entries(locMap)
    .map(([location, count]) => ({ location, count }))
    .sort((a, b) => b.count - a.count);

  // ดึง clock จาก problem.get เฉพาะเมื่อจำนวน ≤ MASS_FAIL (ไม่ส่ง 2000 hostid)
  const clockMap = {};
  if (total > 0 && total <= CAMERA_MASS_FAIL) {
    try {
      const probs = await rpc('problem.get', {
        hostids: allOffline.map((h) => h.hostid),
        output: ['clock', 'name'],
        selectHosts: ['hostid'],
        recent: false,
        suppressed: false,
        sortfield: 'clock',
        sortorder: 'DESC',
        limit: Math.min(total * 3, 300),
      });
      for (const p of (probs || [])) {
        for (const h of (p.hosts || [])) {
          if (!clockMap[h.hostid]) clockMap[h.hostid] = parseInt(p.clock, 10);
        }
      }
    } catch { /* ถ้า problem.get ไม่ตอบ แสดง N/A */ }
  }

  return { allOffline, total, groups, clockMap };
}

// ── แบ่งหน้าจาก raw data ที่แคชไว้ (ไม่เรียก API) ────────────────────────────
// คืน { cameras, total, groups, page, pageSize, totalPages }
function pageOfflineCameras(page = 1, raw) {
  const { allOffline = [], total = 0, groups = [], clockMap = {} } = raw;

  if (total > CAMERA_MASS_FAIL) {
    return { cameras: [], total, groups, page: 1, pageSize: CAMERA_PAGE_SIZE, totalPages: 0 };
  }

  const totalPages = Math.ceil(total / CAMERA_PAGE_SIZE) || 1;
  const safePage   = Math.min(Math.max(page, 1), totalPages);
  const paged      = allOffline.slice((safePage - 1) * CAMERA_PAGE_SIZE, safePage * CAMERA_PAGE_SIZE);
  const now        = Math.floor(Date.now() / 1000);

  const cameras = paged.map((h) => {
    const iface   = (h.interfaces || []).find((i) => i.main === '1') || h.interfaces?.[0] || {};
    const clock   = clockMap[h.hostid] || null;
    const durSec  = clock ? now - clock : null;
    return {
      name:         h.name || h.host,
      location:     h.inventory?.location || '',
      ip:           iface.ip || 'N/A',
      offlineSince: clock ? new Date(clock * 1000).toLocaleString('th-TH') : 'N/A',
      duration:     durSec !== null ? formatDuration(durSec) : 'N/A',
    };
  });

  return { cameras, total, groups, page: safePage, pageSize: CAMERA_PAGE_SIZE, totalPages };
}

// ── ดึงข้อมูลทั้งหมดพร้อมกัน (ใช้ใน summary) ────────────────────────────────
async function getSummary() {
  const [problems, hosts] = await Promise.all([getProblems(20), getHosts(200)]);
  const cameras = hosts.filter((h) =>
    h.groups.toLowerCase().includes('camera') ||
    h.groups.toLowerCase().includes('กล้อง') ||
    h.groups.toLowerCase().includes('cctv')
  );
  return { problems, hosts, cameras };
}

// ── Health Check ───────────────────────────────────────────────────────────────
async function healthCheck() {
  try {
    await rpc('apiinfo.version', {}, { auth: false });
    return { ok: true, name: 'Zabbix' };
  } catch (err) {
    return { ok: false, name: 'Zabbix', error: err.message };
  }
}

module.exports = { getProblems, getHosts, getCameras, getSummary, healthCheck, fetchOfflineCamerasRaw, pageOfflineCameras };
