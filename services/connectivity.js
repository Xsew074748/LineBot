'use strict';
// สถานะการเชื่อมต่อ "ระบบมอนิเตอร์ที่ออฟฟิศ" (Zabbix / Omada / HikCentral)
//
// ที่มา: ผลของการเรียก API ที่มีอยู่แล้ว (จุดเดียวกับที่ log [API]) — ไม่เพิ่มการเรียกเครือข่ายใหม่
// "ล้ม" ในที่นี้ = ติดต่อระบบไม่ถึง (timeout / refused / unreachable / ไม่มี response) เท่านั้น
//   ระบบที่ตอบกลับมาแล้ว (401/500 หรือ error ของ API เอง) = ติดต่อถึง ไม่ใช่ปัญหาการเชื่อมต่อ
//
// สถานะ (นับเฉพาะระบบที่เปิดใช้ ดู setEnabled):
//   ok          ไม่มีระบบใดล้มต่อเนื่อง
//   degraded    บางระบบล้ม หรือล้มครบทุกระบบแต่ยังไม่ถึงเกณฑ์เวลา
//   unreachable ทุกระบบที่เปิดใช้ล้มต่อเนื่อง >= เกณฑ์ (CONNECTIVITY_UNREACHABLE_MIN นาที, ค่าเริ่มต้น 10)
//               → มักแปลว่าเครื่องบอทอยู่นอก LAN ออฟฟิศ (เส้นทางเครือข่าย ไม่ใช่ตัวระบบใดระบบหนึ่ง)
// since / minutes: unreachable = ตั้งแต่ระบบ "สุดท้าย" เริ่มล้ม (ทุกระบบล้มมาตั้งแต่ตอนนั้น); degraded = ตั้งแต่ระบบที่ล้มเก่าสุด
//
// ผลลัพธ์ไม่มี IP / hostname / URL / ข้อความ error — มีแค่ชื่อระบบมาตรฐาน ตัวเลข และเวลา
// ข้อจำกัด: ระยะเวลานับด้วยนาฬิกาจริง จึงรวมช่วงที่เครื่องหลับ (ตื่นแล้วเรียก API ใหม่ทันทีก็รีเซ็ต/ยืนยันสถานะ)

const SYSTEMS = ['zabbix', 'omada', 'hikcentral'];
const DEFAULT_UNREACHABLE_MIN = 10;
const MIN_MS = 60_000;

const NETWORK_CODES = new Set([
  'ECONNABORTED', 'ETIMEDOUT', 'ECONNREFUSED', 'EHOSTUNREACH', 'ENETUNREACH', 'ENOTFOUND', 'ECONNRESET', 'EAI_AGAIN', 'EPIPE',
]);

// true เมื่อ error แปลว่า "ติดต่อระบบไม่ถึง"; มี response = ติดต่อถึง
function isUnreachableError(err) {
  if (!err || typeof err !== 'object') return false;
  if (err.name === 'CircuitOpenError') return true;
  if (typeof err.code === 'string' && NETWORK_CODES.has(err.code)) return true;
  if (err.isAxiosError && !err.response) return true;
  return false;
}

// CONNECTIVITY_UNREACHABLE_MIN: จำนวนเต็ม 1–1440 ไม่งั้นใช้ค่าเริ่มต้น
function loadThresholdMin(env = process.env) {
  const raw = env.CONNECTIVITY_UNREACHABLE_MIN;
  if (raw === undefined || String(raw).trim() === '') return DEFAULT_UNREACHABLE_MIN;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 1440 ? n : DEFAULT_UNREACHABLE_MIN;
}

function createConnectivity({ now = Date.now, thresholdMin = loadThresholdMin() } = {}) {
  const states = new Map();          // system → { lastOkAt, failingSince }
  let enabled = new Set();

  function stateOf(system) {
    if (!states.has(system)) states.set(system, { lastOkAt: null, failingSince: null });
    return states.get(system);
  }

  function setEnabled(list) {
    enabled = new Set((Array.isArray(list) ? list : []).map((s) => String(s).toLowerCase()).filter((s) => SYSTEMS.includes(s)));
  }

  // ok=true หรือ error ที่แปลว่าติดต่อถึงแล้ว → รีเซ็ตสตรีค; ติดต่อไม่ถึง → เริ่ม/ต่อสตรีค (เก็บเวลาเริ่มไว้ ไม่ขยับ)
  function record(system, ok, err) {
    const key = String(system || '').toLowerCase();
    if (!SYSTEMS.includes(key)) return;
    const s = stateOf(key);
    const at = now();
    if (ok || !isUnreachableError(err)) {
      s.lastOkAt = at;
      s.failingSince = null;
    } else if (s.failingSince === null) {
      s.failingSince = at;
    }
  }

  const minutesSince = (at, since) => Math.max(0, Math.floor((at - since) / MIN_MS));

  function snapshot() {
    const at = now();
    const list = SYSTEMS.filter((s) => enabled.has(s));
    const systems = {};
    const failing = [];
    for (const name of list) {
      const st = states.get(name);
      const isFailing = !!st && st.failingSince !== null;
      systems[name] = {
        ok: !isFailing,
        lastOkAgoSec: st && st.lastOkAt !== null ? Math.max(0, Math.round((at - st.lastOkAt) / 1000)) : null,
        failingMinutes: isFailing ? minutesSince(at, st.failingSince) : 0,
      };
      if (isFailing) failing.push(name);
    }
    const base = { thresholdMin, failing, systems };
    if (failing.length === 0) return { state: 'ok', since: null, minutes: 0, ...base };

    const sinceList = failing.map((n) => states.get(n).failingSince);
    const allFailing = failing.length === list.length;
    if (allFailing) {
      const latestStart = Math.max(...sinceList);              // ระบบสุดท้ายที่เริ่มล้ม
      if (at - latestStart >= thresholdMin * MIN_MS) {
        return { state: 'unreachable', since: new Date(latestStart).toISOString(), minutes: minutesSince(at, latestStart), ...base };
      }
    }
    const earliest = Math.min(...sinceList);
    return { state: 'degraded', since: new Date(earliest).toISOString(), minutes: minutesSince(at, earliest), ...base };
  }

  // สำหรับ /health (เปิดสาธารณะผ่าน tunnel): เฉพาะสถานะรวม ไม่มีรายระบบ
  function publicView() {
    const s = snapshot();
    return { state: s.state, since: s.since, minutes: s.minutes };
  }

  return { record, setEnabled, snapshot, publicView };
}

const instance = createConnectivity();

module.exports = {
  SYSTEMS, DEFAULT_UNREACHABLE_MIN, isUnreachableError, loadThresholdMin, createConnectivity,
  record: instance.record, setEnabled: instance.setEnabled, snapshot: instance.snapshot, publicView: instance.publicView,
};
