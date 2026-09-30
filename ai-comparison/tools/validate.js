'use strict';
// ตรวจความถูกต้องของ scenario ทั้งหมด (ไม่เรียก AI) — รัน: node ai-comparison/tools/validate.js
//   1) โครงสร้าง/ฟิลด์ครบ 2) id ไม่ซ้ำ + ตรงกับหมวดของไฟล์ 3) ความสอดคล้องของ correlation group กับกฎใน correlate.js
//   4) สรุปการกระจายหมวด/ระดับความรุนแรง 5) drift check: template ที่คัดลอกไว้ยังตรงกับซอร์สจริงของบอท (อ่านอย่างเดียว)
const fs = require('fs');
const path = require('path');
const { loadScenarios } = require('./load');
const { renderPrompt, SYSTEM_PROMPT, CORRELATION_SYSTEM_PROMPT } = require('./render-prompt');

const ROOT = path.join(__dirname, '..', '..');
const errors = [];
const err = (id, msg) => errors.push(`${id}: ${msg}`);

const CATEGORIES = { '01': 'network_down', '02': 'camera_offline', '03': 'host_resource', '04': 'flapping', '05': 'cascade', '06': 'false_alarm', '07': 'conflict' };
const ID_PREFIX  = { network_down: 'NET', camera_offline: 'CAM', host_resource: 'HOST', flapping: 'FLAP', cascade: 'CAS', false_alarm: 'FAL', conflict: 'CON' };
const SEVERITIES = ['low', 'medium', 'high', 'critical'];
const REQUIRED_INPUT = {
  analyze_device: ['type', 'name', 'ip', 'status', 'apContext', 'cameraContext'],
  camera_single:  ['name', 'location', 'status', 'duration', 'offlineSince'],
  alert:          ['description', 'host', 'priorityLabel', 'lastChange', 'comments'],
  correlation:    ['group'],
  context_text:   ['topic', 'context'],
};
const REQUIRED_GT_STR  = ['root_cause', 'partial_root_cause', 'severity_rationale'];
const REQUIRED_GT_LIST = ['wrong_root_cause_examples', 'key_evidence', 'correct_actions', 'unacceptable_actions'];

const scenarios = loadScenarios();
const seen = new Set();

for (const s of scenarios) {
  const id = s.id || `(ไม่มี id ใน ${s._file})`;
  if (seen.has(s.id)) err(id, 'id ซ้ำ');
  seen.add(s.id);

  const fileCat = CATEGORIES[s._file.slice(0, 2)];
  if (s.category !== fileCat) err(id, `category "${s.category}" ไม่ตรงกับไฟล์ ${s._file} (คาด ${fileCat})`);
  if (!new RegExp(`^${ID_PREFIX[s.category]}-\\d{2}$`).test(s.id || '')) err(id, `รูปแบบ id ไม่ตรง ${ID_PREFIX[s.category]}-NN`);
  if (!s.title) err(id, 'ไม่มี title');
  if (!s.design_note) err(id, 'ไม่มี design_note');

  const req = REQUIRED_INPUT[s.prompt_kind];
  if (!req) { err(id, `prompt_kind ไม่รู้จัก: ${s.prompt_kind}`); continue; }
  for (const k of req) if (s.input == null || s.input[k] == null || s.input[k] === '') err(id, `input.${k} หายไป`);

  const gt = s.ground_truth || {};
  for (const k of REQUIRED_GT_STR) if (typeof gt[k] !== 'string' || gt[k].length < 20) err(id, `ground_truth.${k} ว่าง/สั้นเกินไป`);
  for (const k of REQUIRED_GT_LIST) if (!Array.isArray(gt[k]) || gt[k].length === 0) err(id, `ground_truth.${k} ต้องเป็น list ไม่ว่าง`);
  if (!SEVERITIES.includes(gt.severity)) err(id, `ground_truth.severity ต้องเป็น ${SEVERITIES.join('/')}`);

  if (s.prompt_kind === 'correlation' && s.input && s.input.group) {
    const g = s.input.group;
    const types = [...new Set(g.devices.map((d) => d.type))].sort();
    if (JSON.stringify([...g.types].sort()) !== JSON.stringify(types)) err(id, `group.types ไม่ตรงกับ devices (${types})`);
    const infra = g.types.includes('switch') || g.types.includes('host');
    if (g.hasInfraDevice !== infra) err(id, `hasInfraDevice ควรเป็น ${infra}`);
    // กฎ scoreConfidence ใน services/correlate.js: หลายชนิด/มี infra → high ไม่งั้น medium
    const expected = (g.types.length > 1 || infra) ? 'high' : 'medium';
    if (g.confidence !== expected) err(id, `confidence ควรเป็น ${expected} ตาม correlate.js`);
    if (g.devices.length < 2) err(id, 'ต้องมี device อย่างน้อย 2 (correlate.js ข้ามกลุ่มที่มี 1)');
  }
  if (s.prompt_kind === 'context_text' && s.input && !['host', 'wifi', 'camera', 'summary'].includes(s.input.topic)) err(id, `topic ไม่รู้จัก: ${s.input.topic}`);

  try { renderPrompt(s); } catch (e) { err(id, `render prompt ไม่ได้: ${e.message}`); }
}

// ── drift check: template ที่คัดลอกไว้ตรงกับซอร์สของบอทหรือไม่ (อ่านอย่างเดียว) ──
const aiSrc  = fs.readFileSync(path.join(ROOT, 'services', 'ai.js'), 'utf8');
const idxSrc = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
const extract = (src, name) => { const m = src.match(new RegExp('const ' + name + ' = `([\\s\\S]*?)`;')); return m && m[1]; };
if (extract(aiSrc, 'SYSTEM_PROMPT') !== SYSTEM_PROMPT) errors.push('drift: SYSTEM_PROMPT ต่างจาก services/ai.js');
if (extract(aiSrc, 'CORRELATION_SYSTEM_PROMPT') !== CORRELATION_SYSTEM_PROMPT) errors.push('drift: CORRELATION_SYSTEM_PROMPT ต่างจาก services/ai.js');
const mustContain = [
  [aiSrc,  'วิเคราะห์ Alert นี้:'], [aiSrc, 'return ask(prompt, 600);'], [aiSrc, 'callAI(CORRELATION_SYSTEM_PROMPT, prompt, 600)'],
  [aiSrc,  'ข้อมูลความผิดปกติแบบกลุ่ม:'], [aiSrc, 'ความมั่นใจของระบบ:'],
  [idxSrc, 'คุณเป็น Network Engineer วิเคราะห์ปัญหาของ'], [idxSrc, 'ai.chat(prompt, null, 800)'],
  [idxSrc, 'วิเคราะห์ปัญหากล้อง CCTV รายตัว บอกสาเหตุที่น่าจะเป็นและวิธีแก้ไข:'],
  [idxSrc, 'วิเคราะห์สถานะ Host ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:'],
  [idxSrc, 'วิเคราะห์สถานะ WiFi AP ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:'],
  [idxSrc, 'วิเคราะห์ปัญหากล้อง CCTV ต่อไปนี้ บอกสาเหตุที่เป็นไปได้ วิธีแก้ไข และวิธีป้องกัน:'],
  [idxSrc, 'วิเคราะห์ภาพรวมระบบ IT ต่อไปนี้ บอกสถานการณ์ปัจจุบันและคำแนะนำ:'],
];
for (const [src, needle] of mustContain) if (!src.includes(needle)) errors.push(`drift: ไม่พบข้อความ template ในซอร์สบอท: "${needle}"`);

// ── สรุป ──
const count = (key) => scenarios.reduce((m, s) => { const k = key(s); m[k] = (m[k] || 0) + 1; return m; }, {});
console.log(`เคสทั้งหมด: ${scenarios.length}`);
console.log('ตามหมวด      :', JSON.stringify(count((s) => s.category)));
console.log('ตามความรุนแรง :', JSON.stringify(count((s) => s.ground_truth && s.ground_truth.severity)));
console.log('ตามชนิด prompt:', JSON.stringify(count((s) => s.prompt_kind)));
const cross = {};
for (const s of scenarios) { const sev = s.ground_truth && s.ground_truth.severity; cross[s.category] = cross[s.category] || {}; cross[s.category][sev] = (cross[s.category][sev] || 0) + 1; }
console.log('หมวด × ความรุนแรง:'); for (const [c, v] of Object.entries(cross)) console.log('  ' + c.padEnd(15), JSON.stringify(v));

if (errors.length) { console.error(`\n✗ พบปัญหา ${errors.length} ข้อ:\n - ` + errors.join('\n - ')); process.exit(1); }
console.log('\n✓ ผ่านการตรวจทั้งหมด (โครงสร้าง, id, correlation, drift ของ template)');
