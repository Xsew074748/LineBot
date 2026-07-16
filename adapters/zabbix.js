'use strict';
const BaseMonitorAdapter = require('./base');
const zabbixService     = require('../services/zabbix');
const logger            = require('../services/logger');

// ── helpers ────────────────────────────────────────────────────────────────────

// เดียวกับ extractZone ใน index.js — แยก zone จากชื่อ host
function extractZone(hostName) {
  return hostName.replace(/\d+$/g, '').split(/[-_\s]+/).filter(Boolean).slice(0, 2).join('-')
    || hostName.slice(0, 8);
}

// ตรวจจับประเภทอุปกรณ์จากชื่อ host (ใช้กับ problems — ไม่มี group info)
function typeFromName(name) {
  const n = (name || '').toLowerCase();
  if (/cam|camera|cctv|nvr|dvr|ipcam/.test(n))        return 'camera';
  if (/\bap\b|wifi|wireless|wlan|accesspoint/.test(n)) return 'ap';
  if (/sw\d|switch/.test(n))                           return 'switch';
  return 'host';
}

// ตรวจจับประเภทอุปกรณ์จาก group names (ใช้กับ devices — มี group info)
function typeFromGroups(groups) {
  const g = (groups || '').toLowerCase();
  if (/camera|กล้อง|cctv|nvr|dvr|ipcam/.test(g))    return 'camera';
  if (/\bap\b|access.?point|wifi|wireless/.test(g))   return 'ap';
  if (/switch/.test(g))                               return 'switch';
  return 'host';
}

// ── ZabbixAdapter ──────────────────────────────────────────────────────────────

class ZabbixAdapter extends BaseMonitorAdapter {
  async testConnection() {
    try {
      const r = await zabbixService.healthCheck();
      return { ok: r.ok, message: r.error || 'เชื่อมต่อ Zabbix สำเร็จ' };
    } catch (err) {
      logger.error('ZabbixAdapter.testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  async getProblems() {
    try {
      const raw = await zabbixService.getProblems(200);
      return raw.map((p) => ({
        source:    'zabbix',
        device:    p.host,
        zone:      extractZone(p.host),
        type:      typeFromName(p.host),
        status:    'problem',
        timestamp: p.lastchangeTs,
        ip:        p.interfaces?.[0]?.ip || null,
        severity:  p.priority,
      }));
    } catch (err) {
      logger.error('ZabbixAdapter.getProblems', err);
      throw err;
    }
  }

  async getDevices() {
    try {
      const raw = await zabbixService.getHosts(200);
      return raw.map((h) => ({
        device: h.name,
        zone:   extractZone(h.name),
        type:   typeFromGroups(h.groups),
        status: h.available === 1 ? 'up' : 'down',
        ip:     h.interfaces?.[0]?.ip || null,
      }));
    } catch (err) {
      logger.error('ZabbixAdapter.getDevices', err);
      throw err;
    }
  }
}

module.exports = ZabbixAdapter;
