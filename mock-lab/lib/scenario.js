'use strict';
// โหลดไฟล์สถานการณ์ YAML → State
//
// รูปแบบไฟล์:
//   name / description   ชื่อและคำอธิบาย
//   extends: other.yaml  (ทางเลือก) ใช้ชุดอุปกรณ์จากไฟล์อื่นเป็นฐาน แล้วเพิ่ม/ทับด้วยไฟล์นี้
//   devices: [...]       อุปกรณ์ (ชื่อซ้ำกับฐาน = ทับทั้งตัว)
//   patch: [{name, set}] แก้เฉพาะฟิลด์ของอุปกรณ์ที่มีอยู่ (เช่น สั่ง switch ดับ) ไม่ต้องคัดลอกอุปกรณ์ทั้งตัว
//   alerts: [...]        trigger ของ Zabbix ที่กำหนดเอง {host, description, priority(0-5), since, comments}
const fs = require('fs');
const path = require('path');
const { State } = require('./state');

let yaml;
try { yaml = require('js-yaml'); } catch { yaml = null; }

const SCENARIO_DIR = path.join(__dirname, '..', 'scenarios');

function parseYaml(text, label) {
  if (!yaml) throw new Error('ไม่พบ js-yaml — รัน npm install ที่ root ของโปรเจกต์ (js-yaml ติดมากับ jest)');
  const doc = (yaml.safeLoad || yaml.load).call(yaml, text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error(`${label}: ต้องเป็น object ระดับบนสุด`);
  return doc;
}

function resolveFile(file) {
  // กัน path traversal — ใช้เฉพาะชื่อไฟล์ และอ่านได้จากโฟลเดอร์ scenarios/ เท่านั้น
  const base = path.basename(String(file));
  const p = path.join(SCENARIO_DIR, base);
  if (!fs.existsSync(p)) throw new Error(`ไม่พบไฟล์สถานการณ์: ${base}`);
  return p;
}

// รวม extends ลงมาเป็นลิสต์ (ฐานก่อน) เพื่อ apply ตามลำดับ
function collect(file, chain = []) {
  const p = resolveFile(file);
  if (chain.includes(p)) throw new Error(`extends วนลูป: ${[...chain, p].map((x) => path.basename(x)).join(' → ')}`);
  const doc = parseYaml(fs.readFileSync(p, 'utf8'), path.basename(p));
  const base = doc.extends ? collect(doc.extends, [...chain, p]) : [];
  return [...base, { file: path.basename(p), doc }];
}

// generate: สร้างอุปกรณ์ชุดใหญ่จาก template  {kind, name: "HQ-CAM-{n}", from: 101, to: 116, ip: "192.168.30.{n}", ...ฟิลด์อื่นเหมือน device}
//   {n} = เลขตั้งแต่ from ถึง to (ทุกฟิลด์ที่เป็นข้อความ) · {i} = ลำดับเริ่มที่ 1
function expandGenerate(spec) {
  if (!Number.isInteger(spec.from) || !Number.isInteger(spec.to) || spec.to < spec.from) throw new Error('generate ต้องมี from/to เป็นจำนวนเต็ม (to >= from)');
  const out = [];
  for (let n = spec.from, i = 1; n <= spec.to; n++, i++) {
    const dev = {};
    for (const [k, v] of Object.entries(spec)) {
      if (k === 'from' || k === 'to') continue;
      dev[k] = typeof v === 'string' ? v.split('{n}').join(String(n)).split('{i}').join(String(i)) : v;
    }
    out.push(dev);
  }
  return out;
}

function applyDocs(docs, state) {
  for (const { file, doc } of docs) {
    for (const dev of [...(doc.devices || []), ...(doc.generate || []).flatMap(expandGenerate)]) {
      try { state.upsert(dev); } catch (e) { throw new Error(`${file}: ${e.message}`); }
    }
    for (const p of doc.patch || []) {
      try { state.patch(p.name, p.set); } catch (e) { throw new Error(`${file}: patch ${e.message}`); }
    }
    for (const a of doc.alerts || []) state.explicitAlerts.push(a);
  }
}

function fromDocs(docs, source) {
  const state = new State();
  applyDocs(docs, state);
  state.validateDependencies();
  const last = docs[docs.length - 1].doc;
  state.meta = { name: last.name || source, description: last.description || '', source };
  if (state.devices.size === 0) throw new Error('สถานการณ์นี้ไม่มีอุปกรณ์เลย');
  return state;
}

function loadScenarioFile(file) {
  return fromDocs(collect(file), path.basename(file));
}

function loadScenarioYaml(text, label = '(inline)') {
  const doc = parseYaml(text, label);
  const base = doc.extends ? collect(doc.extends) : [];
  return fromDocs([...base, { file: label, doc }], label);
}

function listScenarios() {
  return fs.readdirSync(SCENARIO_DIR).filter((f) => /\.ya?ml$/.test(f)).sort().map((file) => {
    try {
      const doc = parseYaml(fs.readFileSync(path.join(SCENARIO_DIR, file), 'utf8'), file);
      return { file, name: doc.name || file, description: doc.description || '' };
    } catch (e) { return { file, name: file, description: `(อ่านไม่ได้: ${e.message})` }; }
  });
}

module.exports = { loadScenarioFile, loadScenarioYaml, listScenarios, SCENARIO_DIR };
