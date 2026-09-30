'use strict';
// ตรวจว่า pipeline ของชุดเปรียบเทียบ AI ยังประกอบ prompt ได้ครบทุกเคสจาก mock-lab ผ่านบอทจริง (ไม่เรียก AI — --dry-run)
// และ drift check ของ prompt/context ที่ตัด/คัดลอกมาจาก index.js ยังตรงกับซอร์สจริง
const { execFileSync } = require('child_process');
const path = require('path');
const { checkDrift } = require('../ai-comparison/tools/bot-context');
const { loadScenarios } = require('../ai-comparison/tools/load');
const yaml = require('js-yaml');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');

describe('ai-comparison pipeline', () => {
  test('drift check: template/สูตร context ที่เขียนซ้ำยังตรงกับ index.js', () => {
    expect(checkDrift()).toEqual([]);
  });

  test('pipeline.yaml ครบทุกเคส และทุกไฟล์สถานการณ์มีจริง', () => {
    const pipe = yaml.safeLoad(fs.readFileSync(path.join(ROOT, 'ai-comparison', 'pipeline.yaml'), 'utf8'));
    for (const s of loadScenarios()) {
      expect(pipe[s.id]).toBeDefined();
      expect(fs.existsSync(path.join(ROOT, 'mock-lab', 'scenarios', pipe[s.id].scenario))).toBe(true);
    }
    expect(Object.keys(pipe)).toHaveLength(loadScenarios().length);
  });

  test('--dry-run: ประกอบ prompt ได้ครบ 34 เคส (mock-lab → บอทจริง → prompt) และไม่เรียก AI', () => {
    const out = execFileSync(process.execPath, [path.join(ROOT, 'ai-comparison', 'tools', 'run-comparison.js'), '--dry-run'], { cwd: ROOT, timeout: 240000, env: { ...process.env, ANTHROPIC_API_KEY: '', GEMINI_API_KEY: '', OPENAI_API_KEY: '' } }).toString();
    const ok = out.split('\n').filter((l) => /✓ ประกอบ prompt ได้/.test(l));
    expect(ok).toHaveLength(34);
    expect(out).not.toMatch(/✗/);
  }, 260000);
});
