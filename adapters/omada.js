'use strict';
const BaseMonitorAdapter = require('./base');
const omadaService      = require('../services/omada');
const logger            = require('../services/logger');

class OmadaAdapter extends BaseMonitorAdapter {
  async testConnection() {
    try {
      const r = await omadaService.healthCheck();
      return { ok: r.ok, message: r.error || 'เชื่อมต่อ Omada สำเร็จ' };
    } catch (err) {
      logger.error('OmadaAdapter.testConnection', err);
      return { ok: false, message: err.message };
    }
  }

  // Omada alerts ไม่มี Unix timestamp ให้แปลงกลับ — ใช้เวลา fetch แทน
  async getProblems() {
    try {
      const now = Math.floor(Date.now() / 1000);
      const raw = await omadaService.getAlerts();
      return raw.map((e) => ({
        source:    'omada',
        device:    e.name,
        zone:      'ไม่ระบุ',
        type:      'ap',
        status:    'problem',
        timestamp: now,
        ip:        e.ip || null,
        severity:  e.level.includes('วิกฤต') ? 5 : 2,
      }));
    } catch (err) {
      logger.error('OmadaAdapter.getProblems', err);
      throw err;
    }
  }

  async getDevices() {
    try {
      const raw = await omadaService.getAPs();
      return raw.map((ap) => ({
        device: ap.name,
        zone:   'ไม่ระบุ',
        type:   'ap',
        status: ap.isProblem ? 'down' : 'up',
        ip:     ap.ip || null,
      }));
    } catch (err) {
      logger.error('OmadaAdapter.getDevices', err);
      throw err;
    }
  }
}

module.exports = OmadaAdapter;
