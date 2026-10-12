'use strict';
// cache กล้องออฟไลน์ของ Zabbix สำหรับคำสั่ง "กล้องดับ" (poller ดึงทุก 90 วินาที)
// ensure() คืน null เมื่อ "ไม่มีข้อมูลเลยและดึงสดไม่ได้" — ผู้เรียกต้องตอบว่าดึงข้อมูลไม่ได้
// ห้ามแปลงเป็น { total: 0 } เพราะผู้ใช้จะเข้าใจว่าไม่มีกล้องดับทั้งที่ไม่รู้สถานะ

function createOfflineCameraCache({ fetchRaw, logger, now = Date.now }) {
  let raw = null;
  let refreshedAt = 0;

  // คืน true ถ้าดึงสำเร็จ; ล้มเหลวทุกแบบคง cache เดิมไว้ (ไม่ reset) แล้วคืน false
  async function refresh() {
    try {
      raw = await fetchRaw();
      refreshedAt = now();
      logger.info(`poller: offline cameras refreshed (total=${raw.total})`);
      return true;
    } catch (err) {
      const isTimeout = err.code === 'ECONNABORTED' || /timeout/i.test(err.message);
      if (isTimeout) {
        logger.warn(`poller: Zabbix timeout — ใช้ cache เดิมต่อ (cached total=${raw?.total ?? 'none'})`);
      } else {
        logger.error('poller: offline camera refresh failed', err);
      }
      return false;
    }
  }

  // มี cache → ใช้เลย; ว่าง → ดึงสด 1 ครั้ง; ยังว่าง → null
  async function ensure() {
    if (!raw) await refresh();
    if (!raw) return null;
    return { raw, ageMin: Math.floor((now() - refreshedAt) / 60_000) };
  }

  return { refresh, ensure };
}

module.exports = { createOfflineCameraCache };
