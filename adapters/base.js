'use strict';

class BaseMonitorAdapter {
  // เช็คการเชื่อมต่อ ใช้ตอนทดสอบใน Setup UI
  // → คืน { ok: boolean, message: string }
  async testConnection() {
    throw new Error(`${this.constructor.name} ต้อง implement testConnection()`);
  }

  // ดึงปัญหา/alert ปัจจุบัน
  // → คืน array ของ { source, device, zone, type, status, timestamp, ip, severity }
  async getProblems() {
    throw new Error(`${this.constructor.name} ต้อง implement getProblems()`);
  }

  // ดึงรายการอุปกรณ์ทั้งหมด
  // → คืน array ของ { device, zone, type, status, ip }
  async getDevices() {
    throw new Error(`${this.constructor.name} ต้อง implement getDevices()`);
  }
}

module.exports = BaseMonitorAdapter;
