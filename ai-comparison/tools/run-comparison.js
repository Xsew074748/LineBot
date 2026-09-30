'use strict';
// รันการเปรียบเทียบ AI 3 เจ้า: mock-lab → บอทดึงข้อมูลจริง → ประกอบ prompt แบบบอทจริง → ส่ง Claude/Gemini/GPT → บันทึกผลแบบปกปิดชื่อ
//
//   node ai-comparison/tools/run-comparison.js --dry-run                      # ประกอบ prompt ทุกเคส ไม่เรียก AI (ไม่เสียเงิน)
//   node ai-comparison/tools/run-comparison.js --cases NET-01,CAS-02          # รันเฉพาะบางเคสกับ AI จริง
//   node ai-comparison/tools/run-comparison.js --confirm-full                 # รันครบทุกเคส (เสียเงิน — ต้องยืนยันด้วยธงนี้)
//   ตัวเลือก: --providers claude,gemini,openai  --force (รันซ้ำเคสที่มีผลแล้ว)  --show (พิมพ์ prompt ทุกเคส)
//
// ผลลัพธ์ (อยู่ใน ai-comparison/results/ ซึ่งอยู่ใน .gitignore):
//   raw/<CASE>.json      prompt + คำตอบที่ติดป้าย A/B/C (ไม่มีชื่อ provider)
//   mapping.json         ป้าย↔provider ต่อเคส + ข้อผิดพลาด (ห้ามเปิดจนให้คะแนนเสร็จ)
// จากนั้นรัน tools/make-review.js เพื่อสร้างหน้าให้คะแนน
process.env.TZ = process.env.TZ || 'Asia/Bangkok'; // ให้ toLocaleString('th-TH') ตรงกับที่บอทจริงแสดง (เวลาไทย)

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const yaml = require('js-yaml');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const AIC = path.join(__dirname, '..');
const RESULTS = path.join(AIC, 'results');
const { loadScenarios } = require('./load');
const { createApp, loadConfig } = require(path.join(ROOT, 'mock-lab', 'server'));
const { loadScenarioFile } = require(path.join(ROOT, 'mock-lab', 'lib', 'scenario'));
const { loadBot, derive, checkDrift } = require('./bot-context');

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : null; };

const PROVIDERS = ['claude', 'gemini', 'openai'];
const pipeline = yaml.safeLoad(fs.readFileSync(path.join(AIC, 'pipeline.yaml'), 'utf8'));

function modelOf(name) {
  if (name === 'gemini') return require(path.join(ROOT, 'services', 'ai-providers', 'gemini')).MODEL;
  const src = fs.readFileSync(path.join(ROOT, 'services', 'ai-providers', `${name}.js`), 'utf8');
  return (src.match(/const MODEL = '([^']+)'/) || [])[1] || '?';
}

function shuffle(list) { // Fisher-Yates ด้วย crypto (ไม่ใช้ Math.random ให้เดาลำดับไม่ได้)
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// จัดหมวดข้อผิดพลาดแบบไม่บอกชื่อ provider (ใช้ในไฟล์ raw ที่ผู้ให้คะแนนอาจเห็น)
function errorClass(err) {
  if (err && err.isTimeout) return 'timeout';
  if (err && err.status) return `http_${err.status}`;
  return 'error';
}

async function askProvider(name, prompt) {
  const provider = require(path.join(ROOT, 'services', 'ai-providers', name));
  const t0 = Date.now();
  try {
    const text = await provider.complete({ systemPrompt: prompt.system, userPrompt: prompt.user, maxTokens: prompt.maxTokens });
    return { provider: name, ok: true, text, latency_ms: Date.now() - t0 };
  } catch (err) {
    // ข้อความ error ของ provider เก็บเฉพาะใน mapping (ไม่ใส่ key; message ผ่านการกรอง body แล้ว — ดู commit 62c52e4)
    return { provider: name, ok: false, error: `${err.message}${err.diag ? ` [${err.diag}]` : ''}`, error_class: errorClass(err), latency_ms: Date.now() - t0 };
  }
}

async function main() {
  const drift = checkDrift();
  if (drift.length) { console.error(`✗ drift: ซอร์สบอทเปลี่ยนจนตัวประกอบ prompt ไม่ตรงอีกต่อไป:\n - ${drift.join('\n - ')}`); process.exit(1); }

  let cases = loadScenarios();
  if (opt('cases')) { const want = opt('cases').split(','); cases = want.map((id) => { const c = cases.find((x) => x.id === id); if (!c) throw new Error(`ไม่พบเคส ${id}`); return c; }); }
  const dry = flag('dry-run');
  const providers = (opt('providers') ? opt('providers').split(',') : PROVIDERS);
  if (!dry && cases.length > 5 && !flag('confirm-full')) {
    console.error(`✗ จะเรียก AI จริง ${cases.length} เคส × ${providers.length} provider = ${cases.length * providers.length} ครั้ง (เสีย API credit) — เพิ่ม --confirm-full ถ้ายืนยัน หรือใช้ --cases เพื่อเลือกเฉพาะบางเคส`);
    process.exit(1);
  }

  // mock-lab ในโปรเซสเดียวกัน (พอร์ตสุ่ม) — สลับสถานการณ์ด้วย holder.state แทนการ spawn โปรเซสใหม่ทุกเคส
  // เหตุผล: เริ่มเร็ว (ไม่ต้องรอ process/พอร์ต 34 รอบ) และควบคุม state ได้ตรง; บอทยังคุยกับ mock ผ่าน HTTP จริง (loopback) เหมือนเดิม
  const mockCfg = { ...loadConfig({}), strictAuth: true };
  const mock = createApp({ scenarioFile: '01-baseline-office.yaml', config: mockCfg });
  const server = http.createServer(mock.app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;

  fs.mkdirSync(path.join(RESULTS, 'raw'), { recursive: true });
  const mapFile = path.join(RESULTS, 'mapping.json');
  const mapping = fs.existsSync(mapFile) ? JSON.parse(fs.readFileSync(mapFile, 'utf8')) : {
    runId: new Date().toISOString(), groundTruthCommit: safeGit('git log -1 --format=%h -- ai-comparison/scenarios'),
    models: Object.fromEntries(PROVIDERS.map((p) => [p, modelOf(p)])), cases: {}, errors: {},
  };

  const summary = [];
  for (const c of cases) {
    const rawFile = path.join(RESULTS, 'raw', `${c.id}.json`);
    if (!dry && fs.existsSync(rawFile) && !flag('force')) { summary.push(`${c.id}: มีผลแล้ว ข้าม (ใช้ --force เพื่อรันซ้ำ)`); continue; }
    const spec = pipeline[c.id];
    try {
      if (!spec) throw new Error(`ไม่มี ${c.id} ใน pipeline.yaml`);
      mock.holder.state = loadScenarioFile(spec.scenario);
      mock.holder.source = { file: spec.scenario };
      const bot = loadBot(base, mockCfg);
      const prompt = await derive(bot, spec, mock.holder.state);
      if (dry) {
        summary.push(`${c.id}: ✓ ประกอบ prompt ได้ (${prompt.trace.via}; max_tokens=${prompt.maxTokens})`);
        if (flag('show')) console.log(`\n══ ${c.id} — ${c.title}\n── system: ${prompt.system.split('\n')[0]}…\n── user:\n${prompt.user}\n── trace: ${JSON.stringify(prompt.trace)}\n`);
        continue;
      }
      const answers = await Promise.all(providers.map((p) => askProvider(p, prompt)));
      const labels = shuffle(providers).map((p, i) => [String.fromCharCode(65 + i), p]);
      mapping.cases[c.id] = Object.fromEntries(labels);
      mapping.errors[c.id] = Object.fromEntries(answers.filter((a) => !a.ok).map((a) => [a.provider, a.error]));
      const responses = labels.map(([label, p]) => {
        const a = answers.find((x) => x.provider === p);
        return a.ok ? { label, status: 'ok', text: a.text, latency_ms: a.latency_ms } : { label, status: 'error', error_class: a.error_class, latency_ms: a.latency_ms };
      });
      fs.writeFileSync(rawFile, JSON.stringify({ id: c.id, title: c.title, category: c.category, prompt: { system: prompt.system, user: prompt.user, max_tokens: prompt.maxTokens }, pipeline: prompt.trace, responses, ranAt: new Date().toISOString() }, null, 2));
      fs.writeFileSync(mapFile, JSON.stringify(mapping, null, 2)); // เขียนทุกเคส — run ที่ขาดกลางคันไม่เสียของที่ทำแล้ว
      summary.push(`${c.id}: ✓ ${answers.map((a) => `${a.ok ? 'ok' : 'ERR'}`).join('/')}  (${Math.max(...answers.map((a) => a.latency_ms))} ms)`);
    } catch (e) {
      summary.push(`${c.id}: ✗ ${e.message}`); // เคสเดียวล้มไม่ทำให้ทั้ง run พัง
      process.exitCode = 2;
    }
  }
  server.close();
  console.log(summary.join('\n'));
  if (!dry) console.log(`\nผลอยู่ที่ ${path.relative(ROOT, RESULTS)}/ (raw/, mapping.json) — อย่าเปิด mapping.json จนให้คะแนนเสร็จ; สร้างหน้าให้คะแนนด้วย make-review.js`);
}

function safeGit(cmd) { try { return execSync(cmd, { cwd: ROOT }).toString().trim(); } catch { return null; } }

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
