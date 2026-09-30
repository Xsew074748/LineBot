'use strict';
// สร้างหน้าให้คะแนนแบบปกปิดชื่อ provider จากผลใน results/raw/*.json
//   node ai-comparison/tools/make-review.js  →  ai-comparison/results/review.html  (เปิดด้วยเบราว์เซอร์ได้เลย ไม่ต้องมีเซิร์ฟเวอร์)
//
// - อ่านเฉพาะ raw/ (ป้าย A/B/C) และเฉลยจาก scenarios/ — ไม่อ่าน mapping.json จึงไม่มีทางเห็นชื่อ provider
// - ลำดับเคสสุ่ม (ตาม RUBRIC ข้อ 2) · คำตอบที่ provider ล้มเหลวถูกให้ 0/0/0 อัตโนมัติ (ดู RUBRIC กฎข้อ 6)
// - คะแนนถูกเก็บใน localStorage ของเบราว์เซอร์ (ปิดแท็บได้ ไม่หาย) และ export เป็น CSV ตาม scoring-sheet-template.csv
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { loadScenarios } = require('./load');

const RESULTS = path.join(__dirname, '..', 'results');
const rawDir = path.join(RESULTS, 'raw');
if (!fs.existsSync(rawDir)) { console.error('ยังไม่มีผล (results/raw/) — รัน run-comparison.js ก่อน'); process.exit(1); }

const scenarios = Object.fromEntries(loadScenarios().map((s) => [s.id, s]));
const items = fs.readdirSync(rawDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(rawDir, f), 'utf8')))
  .map((r) => ({ id: r.id, category: r.category, prompt: r.prompt, pipeline: r.pipeline, responses: r.responses, gt: (scenarios[r.id] || {}).ground_truth }));

for (let i = items.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [items[i], items[j]] = [items[j], items[i]]; }

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const list = (a) => `<ul>${(a || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`;

const cards = items.map((it, idx) => {
  const gt = it.gt || {};
  const answers = it.responses.map((r) => {
    const key = `${it.id}|${r.label}`;
    const failed = r.status !== 'ok';
    return `<section class="ans" data-key="${key}" data-failed="${failed ? 1 : 0}">
      <h4>คำตอบ ${r.label}</h4>
      ${failed ? `<p class="fail">ไม่มีคำตอบ (provider ล้มเหลว) — ให้ 0/0/0 อัตโนมัติ</p>` : `<pre class="text">${esc(r.text)}</pre>`}
      <div class="score">
        <label>ต้นตอ <select data-f="root"><option value="">-</option><option>0</option><option>1</option><option>2</option></select></label>
        <label>ความรุนแรง <select data-f="sev"><option value="">-</option><option>0</option><option>1</option></select></label>
        <label>คำแนะนำ <select data-f="act"><option value="">-</option><option>0</option><option>1</option><option>2</option></select></label>
        <label>ระดับที่ AI สื่อ <select data-f="aisev"><option value="">-</option><option>low</option><option>medium</option><option>high</option><option>critical</option><option>none</option></select></label>
        <label><input type="checkbox" data-f="hall"> hallucination</label>
        <label><input type="checkbox" data-f="unsafe"> คำแนะนำอันตราย</label>
        <input type="text" data-f="notes" placeholder="หมายเหตุ">
      </div></section>`;
  }).join('');
  return `<article class="case" id="c${idx}"><h2>เคส ${idx + 1}/${items.length} — <code>${it.id}</code> <small>(${esc(it.category)})</small></h2>
    <details><summary>Prompt ที่ AI ได้รับ (max_tokens ${it.prompt.max_tokens})</summary><pre>${esc(it.prompt.user)}</pre></details>
    <div class="answers">${answers}</div>
    <details class="gt"><summary>เฉลย (ดูหลังอ่านคำตอบทุกข้อและให้คะแนนแล้ว)</summary>
      <p><b>ต้นตอ (2):</b> ${esc(gt.root_cause)}</p><p><b>ถูกบางส่วน (1):</b> ${esc(gt.partial_root_cause)}</p>
      <p><b>ผิด (0):</b></p>${list(gt.wrong_root_cause_examples)}<p><b>ความรุนแรงที่ถูก:</b> ${esc(gt.severity)} — ${esc(gt.severity_rationale)}</p>
      <p><b>คำแนะนำที่ถูก (เรียงตามความสำคัญ):</b></p>${list(gt.correct_actions)}<p><b>ห้าม/ถือว่าผิด:</b></p>${list(gt.unacceptable_actions)}</details></article>`;
}).join('\n');

const html = `<!doctype html><html lang="th"><head><meta charset="utf-8"><title>ให้คะแนนคำตอบ AI (ปกปิดชื่อ)</title>
<style>body{font:15px/1.5 system-ui,'Noto Sans Thai',sans-serif;max-width:1200px;margin:0 auto;padding:16px;background:#f6f7f9;color:#1b1f24}
.case{background:#fff;border:1px solid #d9dde3;border-radius:10px;padding:14px 18px;margin:16px 0}.answers{display:grid;grid-template-columns:repeat(auto-fit,minmax(340px,1fr));gap:12px;margin:10px 0}
.ans{border:1px solid #c9ced6;border-radius:8px;padding:8px 12px}.text{white-space:pre-wrap;background:#fafbfc;padding:8px;border-radius:6px;max-height:420px;overflow:auto}
.score{display:flex;flex-wrap:wrap;gap:8px;align-items:center;font-size:13px}.score input[type=text]{flex:1 1 200px}.fail{color:#a33}pre{white-space:pre-wrap}
.gt{background:#fff9e6;border-radius:6px;padding:4px 10px}.bar{position:sticky;top:0;background:#1b1f24;color:#fff;padding:8px 14px;border-radius:8px;display:flex;gap:12px;align-items:center;z-index:5}
.bar button{padding:4px 10px}textarea{width:100%;height:160px}</style></head><body>
<div class="bar"><b>ให้คะแนนแบบปกปิดชื่อ</b><span id="prog"></span><button id="csv">สร้าง CSV</button><button id="dl">ดาวน์โหลด CSV</button></div>
<p>เกณฑ์อยู่ที่ <code>RUBRIC.md</code> — ให้คะแนนทีละมิติตามเฉลยของเคสนั้น (เฉลยอยู่ในกล่องสีเหลืองท้ายแต่ละเคส) · ห้ามเปิด <code>results/mapping.json</code> จนให้คะแนนครบ</p>
<textarea id="out" placeholder="กด 'สร้าง CSV' แล้วคัดลอกไปวางในใบให้คะแนน (รูปแบบเดียวกับ scoring-sheet-template.csv)" readonly></textarea>
${cards}
<script>
const store = 'ai-comparison-scores-v1';
let data = {}; try { data = JSON.parse(localStorage.getItem(store) || '{}'); } catch (e) {}
const answers = [...document.querySelectorAll('.ans')];
function save() { try { localStorage.setItem(store, JSON.stringify(data)); } catch (e) {} progress(); }
function progress() { const done = answers.filter((a) => { const d = data[a.dataset.key] || {}; return a.dataset.failed === '1' || (d.root !== '' && d.root !== undefined && d.sev && d.act); }).length; document.getElementById('prog').textContent = 'ให้คะแนนแล้ว ' + done + '/' + answers.length; }
for (const a of answers) {
  const key = a.dataset.key; const d = data[key] || (data[key] = {});
  if (a.dataset.failed === '1') { Object.assign(d, { root: '0', sev: '0', act: '0', aisev: 'none', hall: false, unsafe: false, notes: 'provider ล้มเหลว' }); a.querySelectorAll('[data-f]').forEach((el) => { el.disabled = true; }); }
  a.querySelectorAll('[data-f]').forEach((el) => {
    const f = el.dataset.f;
    if (d[f] !== undefined) { if (el.type === 'checkbox') el.checked = !!d[f]; else el.value = d[f]; }
    el.addEventListener('change', () => { d[f] = el.type === 'checkbox' ? el.checked : el.value; save(); });
    el.addEventListener('input', () => { if (el.type === 'text') { d[f] = el.value; save(); } });
  });
}
function csv() {
  const rows = ['case_id,response_label,root_cause_0_2,severity_0_1,actions_0_2,ai_severity,hallucination,unsafe,notes'];
  for (const a of answers) { const [id, label] = a.dataset.key.split('|'); const d = data[a.dataset.key] || {};
    rows.push([id, label, d.root ?? '', d.sev ?? '', d.act ?? '', d.aisev ?? '', d.hall ? 'Y' : 'N', d.unsafe ? 'Y' : 'N', '"' + String(d.notes || '').replace(/"/g, '""') + '"'].join(',')); }
  rows.sort(); const header = rows.shift(); return [header, ...rows].join('\\n'); }
document.getElementById('csv').onclick = () => { document.getElementById('out').value = csv(); };
document.getElementById('dl').onclick = () => { const b = new Blob(['\\ufeff' + csv()], { type: 'text/csv;charset=utf-8' }); const u = URL.createObjectURL(b); const l = document.createElement('a'); l.href = u; l.download = 'scores.csv'; l.click(); URL.revokeObjectURL(u); };
progress();
</script></body></html>`;

fs.writeFileSync(path.join(RESULTS, 'review.html'), html);
console.log(`สร้าง ${path.relative(process.cwd(), path.join(RESULTS, 'review.html'))} (${items.length} เคส, ลำดับสุ่ม) — ไม่มีชื่อ provider ในไฟล์นี้`);
