'use strict';
// โหลด scenario ทั้งหมดจาก ../scenarios/*.yaml (เรียงตามชื่อไฟล์) — ใช้ js-yaml ที่ติดมากับ node_modules ของโปรเจกต์
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const DIR = path.join(__dirname, '..', 'scenarios');

function loadScenarios() {
  return fs.readdirSync(DIR).filter((f) => f.endsWith('.yaml')).sort().flatMap((file) => {
    const list = yaml.safeLoad(fs.readFileSync(path.join(DIR, file), 'utf8'));
    if (!Array.isArray(list)) throw new Error(`${file}: ต้องเป็น list ของเคส`);
    return list.map((s) => ({ ...s, _file: file }));
  });
}

module.exports = { loadScenarios, DIR };
