'use strict';

// ── ข้อมูลคงที่ ────────────────────────────────────────────────────────────────
const BUILDINGS   = ['A', 'B', 'C', 'D', 'E'];
const FLOORS      = [1, 2, 3, 4, 5];
const AP_MODELS   = ['EAP670', 'EAP660 HD', 'EAP650', 'EAP615-Wall', 'EAP225'];
const EVENT_TYPES = ['videoLoss', 'motionDetect', 'diskFull', 'networkAnomaly', 'hardwareFault'];

// ── ข้อมูลใน Memory ────────────────────────────────────────────────────────────
let cameras = [];
let aps     = [];

// ── สร้างกล้อง 500 ตัว (5 อาคาร × 5 ชั้น × 20 ตัว) ──────────────────────────
function buildCameras() {
  const list = [];
  let idx = 1;
  for (const b of BUILDINGS) {
    for (const f of FLOORS) {
      for (let c = 1; c <= 20; c++) {
        const id = String(idx).padStart(3, '0');
        list.push({
          cameraId:    `CAM-${id}`,
          cameraName:  `CAM-${id}`,
          areaName:    `อาคาร ${b} ชั้น ${f}`,
          building:    b,
          floor:       f,
          ip:          `172.16.${(b.charCodeAt(0) - 65) * 10 + f}.${c}`,
          online:      true,
          offlineTime: null,
        });
        idx++;
      }
    }
  }
  return list;
}

// ── สร้าง AP 50 ตัว (5 อาคาร × 5 ชั้น × 2 ตัว) ───────────────────────────────
function buildAPs() {
  const list = [];
  let idx = 1;
  for (const b of BUILDINGS) {
    for (const f of FLOORS) {
      for (let a = 1; a <= 2; a++) {
        const id  = String(idx).padStart(3, '0');
        const hex = idx.toString(16).padStart(6, '0');
        list.push({
          name:      `AP-${id}`,
          mac:       `A8:9C:ED:${hex.slice(0,2).toUpperCase()}:${hex.slice(2,4).toUpperCase()}:${hex.slice(4,6).toUpperCase()}`,
          ip:        `10.${b.charCodeAt(0) - 64}.${f}.${a * 10}`,
          status:    0,                          // 0=online, 1=offline (Omada convention)
          clientNum: ((idx * 7 + 13) % 25) + 1, // 1–25 (deterministic)
          model:     AP_MODELS[(idx - 1) % AP_MODELS.length],
          building:  `อาคาร ${b}`,
          floor:     `ชั้น ${f}`,
        });
        idx++;
      }
    }
  }
  return list;
}

// ── จำนวนกล้อง offline ต่ออาคาร (รวม 100 ตัว) ────────────────────────────────
// กระจายไม่เท่ากันเพื่อให้ดูสมจริง
const OFFLINE_DIST = { A: 30, B: 15, C: 25, D: 20, E: 10 };

// AP 5 ตัว: ตัวสุดท้ายของแต่ละอาคาร (AP-010, AP-020, AP-030, AP-040, AP-050)
const INIT_OFFLINE_AP_IDX = [9, 19, 29, 39, 49];

// ── reset ทุกอย่างกลับค่าเริ่มต้น ─────────────────────────────────────────────
function reset() {
  cameras = buildCameras();
  aps     = buildAPs();

  // สุ่มกล้อง offline ตามสัดส่วนแต่ละอาคาร เวลาดับสุ่มในช่วง 1–720 นาที (12 ชม.)
  for (const [building, count] of Object.entries(OFFLINE_DIST)) {
    const pool = cameras.filter(c => c.building === building);
    // สลับ array แบบ Fisher-Yates เพื่อสุ่มเลือกกล้อง
    for (let i = pool.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [pool[i], pool[j]] = [pool[j], pool[i]];
    }
    pool.slice(0, count).forEach(cam => {
      cam.online      = false;
      cam.offlineTime = Date.now() - (Math.floor(Math.random() * 720) + 1) * 60_000;
    });
  }

  // กำหนด AP offline เริ่มต้น
  INIT_OFFLINE_AP_IDX.forEach((i) => {
    aps[i].status    = 1;
    aps[i].clientNum = 0;
  });
}

reset(); // โหลดข้อมูลตั้งต้นทันที

module.exports = {
  getCameras:  () => cameras,
  getAPs:      () => aps,
  reset,
  BUILDINGS,
  EVENT_TYPES,
};
