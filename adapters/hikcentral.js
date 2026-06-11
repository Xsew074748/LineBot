'use strict';
const BaseMonitorAdapter = require('./base');
const hikService         = require('../services/hikcentral');
const logger             = require('../services/logger');

class HikCentralAdapter extends BaseMonitorAdapter {
  async testConnection() {
    try {
      const r = await hikService.healthCheck();
      return { ok: r.ok, message: r.error || 'เชื่อมต่อ HikCentral สำเร็จ' };
    } catch (err) {
      logger.error('HikCentralAdapter.testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  // แสดงเฉพาะกล้องที่ offline เป็น problem
  // HikCentral formatCameras() แปลง offlineTime เป็น string แล้ว ใช้เวลา fetch แทน
  async getProblems() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const raw = await hikService.getCameras(1, 1000);
      return raw
        .filter((c) => !c.online)
        .map((c) => ({
          source:    'hikcentral',
          device:    c.name,
          zone:      c.location !== 'N/A' ? c.location : 'ไม่ระบุ',
          type:      'camera',
          status:    'problem',
          timestamp: now,
          ip:        null,
          severity:  3,
        }));
    } catch (err) {
      logger.error('HikCentralAdapter.getProblems', err);
      throw err;
    }
  }

  async getDevices() {
    try {
      const raw = await hikService.getCameras(1, 1000);
      return raw.map((c) => ({
        device: c.name,
        zone:   c.location !== 'N/A' ? c.location : 'ไม่ระบุ',
        type:   'camera',
        status: c.online ? 'up' : 'down',
        ip:     null,
      }));
    } catch (err) {
      logger.error('HikCentralAdapter.getDevices', err);
      throw err;
    }
  }
}

module.exports = HikCentralAdapter;
