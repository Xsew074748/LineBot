'use strict';
// สถานะ host ของ Zabbix 3 แบบ (ค่า available ของ main interface — ดู computeAvailable ใน services/zabbix.js):
//   1 = ปกติ · 2 = ผิดปกติจริง (Zabbix ตรวจแล้วไม่ตอบ) · 0/อื่นๆ = ไม่ทราบสถานะ (Zabbix ยังไม่ยืนยัน)
// "ไม่ทราบ" ≠ "ดับ": เช่น host ที่ตรวจด้วย ICMP อย่างเดียว ไม่มี agent เลยค้างที่ 0 ถาวร
// จุดนี้เป็นนิยามกลางของ /stats, การ์ด LINE และข้อความบริบท AI — อย่านับ available !== 1 เป็นออฟไลน์เองที่อื่น

function classifyHost(h) {
  const a = h ? h.available : undefined;
  if (a === 1) return 'up';
  if (a === 2) return 'unavailable';
  return 'unknown';
}

function countHostStatus(hosts) {
  const c = { total: 0, up: 0, unavailable: 0, unknown: 0 };
  if (!Array.isArray(hosts)) return c;
  for (const h of hosts) {
    c.total += 1;
    c[classifyHost(h)] += 1;
  }
  return c;
}

const MAX_OFFLINE_NAMES = 10;

// ข้อความบริบทที่ส่งให้ AI วิเคราะห์ (คำสั่ง "host"): ออฟไลน์ = เฉพาะ available=2 ส่วนไม่ทราบสถานะบอกแยกและห้ามตีความว่าดับ
function buildHostContextText(hosts) {
  const list = Array.isArray(hosts) ? hosts : [];
  const c = countHostStatus(list);
  let text = `Host ทั้งหมด ${c.total} เครื่อง ออนไลน์ ${c.up} ออฟไลน์ ${c.unavailable}`;
  if (c.unavailable > 0) {
    const names = list.filter((h) => classifyHost(h) === 'unavailable').slice(0, MAX_OFFLINE_NAMES).map((h) => h.name);
    text += `: ${names.join(', ')}`;
  }
  if (c.unknown > 0) {
    text += ` · ไม่ทราบสถานะ ${c.unknown} เครื่อง (Zabbix ยังไม่ยืนยันสถานะ ไม่ได้แปลว่าดับ)`;
  }
  return text;
}

module.exports = { classifyHost, countHostStatus, buildHostContextText };
