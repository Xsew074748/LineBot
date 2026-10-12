'use strict';
// ปิดบังที่อยู่เครือข่ายในข้อความ log — error ของ axios/net มักมีปลายทางอยู่ในข้อความและ stack
// (เช่น "connect ECONNREFUSED 10.1.2.3:4100", "getaddrinfo ENOTFOUND <host>", URL ที่เรียก)
// ปิด: IPv4/IPv6 (พร้อมพอร์ตที่ตามหลัง), URL ทั้งก้อน, hostname ที่ตามหลังรหัส DNS error,
//      ชื่อเครื่องท้าย .local/.lan/.internal ฯลฯ, ค่า Host:/DNS: ในข้อความ certificate
// คง: รหัส error (ECONNREFUSED/ETIMEDOUT/ENOTFOUND ...), เฟรม stack (path:บรรทัด:คอลัมน์), เวลา, เลขเวอร์ชัน
// ยกเว้นโดยตั้งใจ: 127.0.0.1 และ ::1 (loopback ไม่บอกอะไรเกี่ยวกับออฟฟิศ และ log ภายในใช้ตรวจ health)
// ห้าม throw — ใช้ในทางเดินของ logger

const redact = require('./redact');

// ไม่จับเลขที่เป็นส่วนหนึ่งของเลขยาวกว่า (1.2.3.4.5) — ท้าย IP ห้ามมีตัวเลขหรือ ".ตัวเลข" ต่อ
const IPV4 = /(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?::\d{1,5})?(?!\d|\.\d)/g;
const IPV6_BRACKET = /\[[0-9a-f:.]*:[0-9a-f:.]*\](?::\d{1,5})?/gi;
const IPV6_COMPRESSED = /(?<![\w:])(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?::(?:[0-9a-f]{1,4}(?::[0-9a-f]{1,4}){0,6})?(?![\w:])/gi;
const IPV6_FULL = /(?<![\w:])(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}(?![\w:])/gi;
// ตัวอักษร [ ] อยู่ใน URL ได้ (IPv6 literal และ "token=[redacted]" ที่ redact ใส่มาก่อน)
const URL_RE = /\b(?!file:)[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>)]*[^\s"'`<>).,;]/gi;
const DNS_FAIL = /\b(ENOTFOUND|EAI_AGAIN|EAI_NODATA|EAI_FAIL|EAI_NONAME)(\s+)(?!<)[^\s,;)"'`]+/g;
const CERT_HOST = /\b(Host|Hostname|DNS|servername):\s*(?!<)[^\s,;)"'`]+/gi;
const INTERNAL_NAME = /\b(?:[a-z0-9_-]+\.)+(?:local|lan|internal|corp|home|intranet|localdomain|office)\b\.?/gi;

const LOOPBACK_V4 = '127.0.0.1';

function scrubNetwork(input) {
  let out;
  try { out = typeof input === 'string' ? input : (input instanceof Error ? `${input.message}` : String(input ?? '')); } catch { return ''; }
  try {
    out = out
      .replace(URL_RE, '<url>')
      .replace(IPV6_BRACKET, '<ip>')
      .replace(IPV4, (m) => (m === LOOPBACK_V4 || m.startsWith(`${LOOPBACK_V4}:`) ? m : '<ip>'))
      .replace(IPV6_FULL, '<ip>')
      .replace(IPV6_COMPRESSED, (m) => (m === '::1' ? m : '<ip>'))
      .replace(DNS_FAIL, '$1$2<host>')
      .replace(CERT_HOST, '$1: <host>')
      .replace(INTERNAL_NAME, '<host>');
  } catch { /* คืนเท่าที่ปิดได้ — ห้าม throw */ }
  return out;
}

// ที่อยู่เครือข่าย + redact เดิม (Bearer/token/secret/LINE userId)
function scrubForLog(input) {
  return redact(scrubNetwork(input));
}

module.exports = { scrubNetwork, scrubForLog };
