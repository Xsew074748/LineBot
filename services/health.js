'use strict';
// GET /health — Docker HEALTHCHECK และ tunnel ใช้ ตอบ 200 เสมอเมื่อ process ยังตอบได้
// connectivity เป็นข้อมูลเสริม (state / since / minutes) — "บอทไม่ได้ตาย แค่มองไม่เห็นออฟฟิศ" จึงห้ามเปลี่ยน HTTP status
// (ถ้าตอบ 5xx ตามสถานะนี้ Docker จะมองว่า container unhealthy ทั้งที่บอทปกติ) ไม่มี IP/hostname ในฟิลด์ใดๆ

function createHealthHandler({ getMonitorsLoaded, getAiProvider, getConnectivity }) {
  return function healthHandler(req, res) {
    let connectivity = null;
    try { connectivity = getConnectivity ? getConnectivity() : null; } catch { connectivity = null; }
    res.json({
      status: 'ok',
      service: 'IT Monitor Bot',
      monitorsLoaded: getMonitorsLoaded(),
      aiProvider: getAiProvider(),
      connectivity,
    });
  };
}

module.exports = { createHealthHandler };
