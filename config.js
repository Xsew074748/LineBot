'use strict';
require('dotenv').config();

// ── Plugin System ──────────────────────────────────────────────────────────────
// เพิ่ม/ปิด Monitor ได้โดยเปลี่ยน enabled: true/false เท่านั้น
// ไม่ต้องแก้ไขโค้ดในไฟล์อื่น
const MONITORS = {
  zabbix: {
    enabled: true,
    name: 'Zabbix',
    type: 'zabbix',
    adapterModule: './adapters/zabbix',
    // ตรวจสอบว่ามี env ที่จำเป็นครบไหม
    requiredEnv: ['ZABBIX_URL', 'ZABBIX_API_TOKEN'],
  },
  omada: {
    enabled: true,
    name: 'Omada WiFi',
    type: 'omada',
    adapterModule: './adapters/omada',
    requiredEnv: ['OMADA_URL', 'OMADA_USERNAME', 'OMADA_PASSWORD', 'OMADA_SITE_ID'],
  },
  hikcentral: {
    enabled: true, // เปิดเมื่อพร้อม: ตั้งค่า HIKCENTRAL_* ใน .env แล้วเปลี่ยนเป็น true
    name: 'HikCentral',
    type: 'hikcentral',
    adapterModule: './adapters/hikcentral',
    requiredEnv: ['HIKCENTRAL_URL', 'HIKCENTRAL_CLIENT_ID', 'HIKCENTRAL_CLIENT_SECRET'],
  },
};

// ── โหลดเฉพาะ Monitor ที่ enabled: true ──────────────────────────────────────
// ตรวจสอบ env vars ที่จำเป็นด้วย เพื่อให้รู้ทันทีว่าตั้งค่าผิด
function getEnabledMonitors() {
  const enabled = {};
  for (const [key, cfg] of Object.entries(MONITORS)) {
    if (!cfg.enabled) continue;

    // ตรวจสอบว่ามี env vars ครบไหม
    const missing = cfg.requiredEnv.filter((v) => !process.env[v]);
    if (missing.length > 0) {
      console.warn(
        `[Config] Monitor "${cfg.name}" enabled แต่ขาด env vars: ${missing.join(', ')} — ข้ามไป`
      );
      continue;
    }
    enabled[key] = cfg;
  }
  return enabled;
}

// ── สร้าง adapter instances สำหรับ Monitor ที่ enabled ────────────────────────
// คืน array ของ { key, name, adapter } — ใช้ผ่าน 3 เมธอดกลาง (testConnection/getProblems/getDevices)
// ถ้า adapter โหลดไม่ได้ → warning แล้วข้ามไป ไม่ทำให้ตัวอื่นพัง
function getAdapters() {
  const enabled  = getEnabledMonitors();
  const adapters = [];
  for (const [key, cfg] of Object.entries(enabled)) {
    if (!cfg.adapterModule) continue;
    try {
      const AdapterClass = require(cfg.adapterModule);
      adapters.push({ key, name: cfg.name, adapter: new AdapterClass() });
    } catch (err) {
      console.warn(`[Config] โหลด adapter "${cfg.name}" ไม่ได้: ${err.message}`);
    }
  }
  return adapters;
}

// ── LINE Config ────────────────────────────────────────────────────────────────
const LINE_CONFIG = {
  channelSecret: process.env.LINE_CHANNEL_SECRET,
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
};

// ── Server Config ──────────────────────────────────────────────────────────────
const SERVER_CONFIG = {
  port: parseInt(process.env.PORT || '3000', 10),
};

// ── Rate Limit Config ──────────────────────────────────────────────────────────
const RATE_LIMIT = {
  perUser: 10,       // Request สูงสุดต่อ user ต่อนาที
  windowMs: 60_000,  // 1 นาที
};

// ── Correlation Config ─────────────────────────────────────────────────────────
// ปรับค่าเกณฑ์การ correlate ได้ที่นี่
const CORRELATION_CONFIG = {
  lookbackSec:   300, // ดูย้อนหลัง 5 นาที
  timeWindowSec: 120, // alert ห่างกันไม่เกิน 2 นาที ถือว่าเกิดพร้อมกัน
};

// ── Roles ──────────────────────────────────────────────────────────────────────
const ROLES = {
  ADMIN: 'ADMIN',
  IT_STAFF: 'IT_STAFF',
  VIEWER: 'VIEWER',
  PENDING: 'PENDING', // รออนุมัติจาก admin
};

// สิทธิ์ของแต่ละ role (เรียงจากสูงสุดไปต่ำสุด)
const ROLE_HIERARCHY = [ROLES.ADMIN, ROLES.IT_STAFF, ROLES.VIEWER, ROLES.PENDING];

// คำสั่งที่ต้องการ role ขั้นต่ำ
// ── AI Config ──────────────────────────────────────────────────────────────────
const AI_CONFIG = {
  allowedRoles: [ROLES.ADMIN, ROLES.IT_STAFF],
  dailyQuota:   parseInt(process.env.AI_DAILY_QUOTA || '20', 10),
};

// Rate limit เข้มงวดสำหรับ pending user (กัน spam ระหว่างรออนุมัติ)
const PENDING_RATE_LIMIT = {
  perUser:  3,
  windowMs: 60_000,
};

const COMMAND_PERMISSIONS = {
  adduser:    ROLES.ADMIN,
  removeuser: ROLES.ADMIN,
  listuser:   ROLES.ADMIN,
  approve:    ROLES.ADMIN,
  pending:    ROLES.ADMIN,
  config:     ROLES.ADMIN,
  // คำสั่งทั่วไป: IT_STAFF ขึ้นไป
  alert: ROLES.IT_STAFF,
  host: ROLES.IT_STAFF,
  กล้อง: ROLES.IT_STAFF,
  'กล้องดับ': ROLES.IT_STAFF,
  wifi: ROLES.IT_STAFF,
  client: ROLES.IT_STAFF,
  ประวัติ: ROLES.IT_STAFF,
  // คำสั่งดูทั่วไป: VIEWER ขึ้นไป
  ทั้งหมด: ROLES.VIEWER,
  สรุป: ROLES.VIEWER,
  status: ROLES.VIEWER,
  help: ROLES.VIEWER,
  // Cross-system correlation
  cross: ROLES.IT_STAFF,
};

module.exports = {
  MONITORS,
  getEnabledMonitors,
  getAdapters,
  CORRELATION_CONFIG,
  LINE_CONFIG,
  SERVER_CONFIG,
  RATE_LIMIT,
  PENDING_RATE_LIMIT,
  AI_CONFIG,
  ROLES,
  ROLE_HIERARCHY,
  COMMAND_PERMISSIONS,
};
