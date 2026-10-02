'use strict';
// เลือกผู้รับ alert จาก Zabbix webhook — แยกออกจาก index.js เพื่อ unit test ได้
//
// ใช้ allow-list ตาม role เท่านั้น (config.APPROVED_ROLES / IT_ROLES):
//   severity >= 4 (high/disaster) → ทุกคนที่อนุมัติแล้ว (ADMIN, IT_STAFF, VIEWER)
//   severity <  4 หรือไม่ใช่ตัวเลข → เฉพาะ ADMIN, IT_STAFF
// PENDING, role ว่าง, พิมพ์เล็ก/พิมพ์ผิด และ role ที่ไม่รู้จักทุกแบบ ไม่ได้รับ (fail closed)
const { APPROVED_ROLES, IT_ROLES, ALERT_BROADCAST_MIN_SEVERITY } = require('../config');

function selectAlertRecipients(users, severity) {
  if (!Array.isArray(users)) return [];
  const broadcast = Number.isFinite(severity) && severity >= ALERT_BROADCAST_MIN_SEVERITY;
  const allowed = broadcast ? APPROVED_ROLES : IT_ROLES;
  return users.filter((u) => u && typeof u.id === 'string' && u.id !== '' && typeof u.role === 'string' && allowed.includes(u.role));
}

// deps: { listUsers, send(to, message), logger } — คืนฟังก์ชัน push(text, severity, flex) → { recipients, sent, failed }
// ล้มเหลวรายคนไม่ทำให้คนอื่นไม่ได้รับ
function createAlertPusher({ listUsers, send, logger }) {
  return async function pushToUsers(text, severity, flex = null) {
    let message = null;
    if (flex) message = { type: 'flex', altText: '🚨 แจ้งเตือนระบบ', contents: flex };
    else if (text) message = { type: 'text', text };

    const targets = selectAlertRecipients(listUsers(), severity);
    const result = { recipients: targets.length, sent: 0, failed: 0 };
    if (!message) return result;

    for (const user of targets) {
      try {
        await send(user.id, message);
        result.sent++;
      } catch (err) {
        result.failed++;
        logger.error(`pushToUsers: userId=${user.id}`, err);
      }
    }
    return result;
  };
}

module.exports = { selectAlertRecipients, createAlertPusher };
