'use strict';
const logger = require('./logger');

// ── Defaults (override ผ่าน opts หรือส่ง config.CORRELATION_CONFIG มา) ─────────
const DEFAULT_LOOKBACK_SEC    = 300;
const DEFAULT_TIME_WINDOW_SEC = 120;

function extractTypes(members) {
  return [...new Set(members.map((m) => m.type))];
}

// 4. คะแนน confidence ตามชนิดอุปกรณ์ในกลุ่ม
//    high: device หลายชนิด หรือมี switch/host (บ่งชี้ปัญหาโครงสร้าง)
//    medium: device ชนิดเดียวล้วน ไม่มี infra
function scoreConfidence(types, hasInfraDevice) {
  const multiType = types.length > 1;
  if (multiType && hasInfraDevice) return 'high'; // แน่นอนที่สุด
  if (multiType)                   return 'high'; // หลายชนิด → infra ร่วม
  if (hasInfraDevice)              return 'high'; // switch/host ลง → infra ร่วม
  return 'medium';                               // ชนิดเดียว อาจเป็นเหตุบังเอิญ
}

/**
 * correlate(alerts, opts)
 *
 * รับ normalized alerts จาก adapter ทุกตัวรวมกัน แล้วหากลุ่ม
 * ที่น่าจะมีต้นเหตุร่วมกัน
 *
 * @param {Array}  alerts - { source, device, zone, type, status, timestamp, severity }
 * @param {Object} opts   - { lookbackSec, timeWindowSec }
 * @returns {Array}       - { zone, devices[], types[], startTime, confidence, hasInfraDevice }
 */
function correlate(alerts, opts = {}) {
  const lookbackSec   = opts.lookbackSec   ?? DEFAULT_LOOKBACK_SEC;
  const timeWindowSec = opts.timeWindowSec ?? DEFAULT_TIME_WINDOW_SEC;

  if (!Array.isArray(alerts) || alerts.length === 0) return [];

  try {
    const now    = Math.floor(Date.now() / 1000);
    const cutoff = now - lookbackSec;

    // 1. กรองเฉพาะ active problems ในช่วง lookback
    const recent = alerts.filter((a) =>
      (a.status === 'down' || a.status === 'problem') &&
      typeof a.timestamp === 'number' && a.timestamp >= cutoff
    );

    if (!recent.length) return [];

    // 2. จัดกลุ่มตาม zone (ข้ามโซน "ไม่ระบุ" — ไม่มีข้อมูลพอจะ correlate)
    const byZone = {};
    for (const a of recent) {
      const z = (a.zone && a.zone !== 'ไม่ระบุ') ? a.zone : '(ไม่ระบุ)';
      (byZone[z] = byZone[z] || []).push(a);
    }

    const groups = [];

    // 3. Anchor-based clustering ภายในแต่ละ zone
    //    anchor = alert ที่เก่าสุดในกลุ่ม; alert ที่ห่างจาก anchor ≤ timeWindowSec
    //    → ถือเป็นกลุ่มเดียวกัน
    for (const [zone, zoneAlerts] of Object.entries(byZone)) {
      const sorted = zoneAlerts.slice().sort((a, b) => a.timestamp - b.timestamp);
      const used   = new Array(sorted.length).fill(false);

      for (let i = 0; i < sorted.length; i++) {
        if (used[i]) continue;
        const anchor  = sorted[i];
        const members = [anchor];
        used[i] = true;

        for (let j = i + 1; j < sorted.length; j++) {
          if (!used[j] && sorted[j].timestamp - anchor.timestamp <= timeWindowSec) {
            members.push(sorted[j]);
            used[j] = true;
          }
        }

        if (members.length < 2) continue; // ต้องมีอย่างน้อย 2 device

        const types          = extractTypes(members);
        const hasInfraDevice = types.includes('switch') || types.includes('host');
        const confidence     = scoreConfidence(types, hasInfraDevice);

        groups.push({
          zone,
          devices: members.map((m) => ({
            device:    m.device,
            type:      m.type,
            source:    m.source,
            timestamp: m.timestamp,
            severity:  m.severity,
          })),
          types,
          startTime:      anchor.timestamp,
          confidence,
          hasInfraDevice,
        });
      }
    }

    // เรียง: high confidence ก่อน จากนั้นเรียงตามจำนวน device (มาก → น้อย)
    return groups.sort((a, b) => {
      if (a.confidence !== b.confidence) return a.confidence === 'high' ? -1 : 1;
      return b.devices.length - a.devices.length;
    });

  } catch (err) {
    logger.error('correlate: unexpected error', err);
    return [];
  }
}

module.exports = { correlate };
