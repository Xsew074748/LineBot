'use strict';
// Guard ระดับซอร์ส: ห้ามส่ง error object ดิบ หรือต่อ err.message/err.stack/${err} ลงข้อความ log
// ในโค้ด production (index.js, services/, adapters/, routes/, middleware/) — ต้องผ่าน safeError()/safeMessage()
// เหตุผล: error ของ axios/net มีที่อยู่ปลายทาง (connect ECONNREFUSED <IP>:พอร์ต) ซึ่งห้ามลงไฟล์ log
// (logger ปิดบังซ้ำอีกชั้น แต่ call-site ต้องไม่พึ่งชั้นเดียว)

const path = require('path');
const { scanSource, scanProject } = require('./helpers/logger-callsites');

const ROOT = path.join(__dirname, '..');

// ข้อยกเว้นต้องมีเหตุผลรายจุด: { file, reason } (อนุญาตทั้งไฟล์สำหรับ call ที่ตรงเงื่อนไข)
const ALLOW = [];

describe('scanner (ตัวสแกนเอง)', () => {
  const hit = (code) => scanSource(code)[0];

  test('จับ error ดิบเป็นอาร์กิวเมนต์', () => {
    expect(hit("logger.error('x', err);").rawErrorArg).toBe(true);
    expect(hit("logger.error('x', error);").rawErrorArg).toBe(true);
    expect(hit("logger.error('x', e)").rawErrorArg).toBe(true);
    expect(hit("logger.error(\n  'x',\n  err\n);").rawErrorArg).toBe(true);
    expect(hit("deps.logger.warn('x', lastErr)").rawErrorArg).toBe(true);
  });

  test('จับ err.message / err.stack / ${err} ในข้อความ', () => {
    expect(hit('logger.warn(`ล้มเหลว: ${err.message}`)').messageInterp).toBe(true);
    expect(hit("logger.warn('ล้มเหลว: ' + err.message)").messageInterp).toBe(true);
    expect(hit('logger.warn(`x ${err && err.message}`)').messageInterp).toBe(true);
    expect(hit('logger.warn(`x ${err.stack}`)').messageInterp).toBe(true);
    expect(hit('logger.warn(`x ${error}`)').messageInterp).toBe(true);
    expect(hit('logger.warn(`x ${err.code || err.message}`)').messageInterp).toBe(true);
  });

  test('ไม่จับรูปแบบที่ปลอดภัย', () => {
    for (const code of [
      "logger.error('x', safeError(err));",
      'logger.warn(`x ${safeMessage(err)}`);',
      'logger.warn(`x ${describeSendError(err)}`);',
      "logger.warn('x', { count: 1 });",
      "logger.info('ข้อความธรรมดา');",
      'logger.warn(`x ${result.message}`);',
      "logger.error('x', null);",
    ]) {
      const h = hit(code);
      expect({ code, raw: h.rawErrorArg, msg: h.messageInterp }).toEqual({ code, raw: false, msg: false });
    }
  });

  test('อ่านอาร์กิวเมนต์ได้ถูกแม้มีวงเล็บ/คอมมา/template ซ้อนใน', () => {
    const h = hit("logger.error(`a ${fn(1, 2)} b ${x ? 'y' : 'z'}`, safeError(err));");
    expect(h.rawErrorArg).toBe(false);
    expect(h.messageInterp).toBe(false);
    const g = hit("logger.error(`a ${fn(1, 2)}`, err);");
    expect(g.rawErrorArg).toBe(true);
  });
});

describe('production code', () => {
  const hits = scanProject(ROOT);

  test('สแกนเจอ logger call จำนวนมากพอ (กันสแกนเนอร์พังแบบเงียบ)', () => {
    expect(hits.length).toBeGreaterThan(80);
  });

  const allowed = (h) => ALLOW.some((a) => a.file === h.file);
  const bad = hits.filter((h) => (h.rawErrorArg || h.messageInterp) && !allowed(h));

  test('ไม่มีจุดที่ส่ง error ดิบเข้า logger', () => {
    const list = bad.filter((h) => h.rawErrorArg).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(list).toEqual([]);
  });

  test('ไม่มีจุดที่ต่อ err.message / err.stack / ${err} ลงข้อความ log', () => {
    const list = bad.filter((h) => h.messageInterp).map((h) => `${h.file}:${h.line}  ${h.text}`);
    expect(list).toEqual([]);
  });

  test('รายการยกเว้นทุกข้อมีเหตุผล และยังมีจุดจริงรองรับ (ไม่ค้างเป็นขยะ)', () => {
    for (const a of ALLOW) {
      expect(typeof a.reason).toBe('string');
      expect(a.reason.length).toBeGreaterThan(20);
      expect(hits.some((h) => h.file === a.file && (h.rawErrorArg || h.messageInterp))).toBe(true);
    }
  });
});

describe('ไม่ข้าม logger', () => {
  const fs = require('fs');
  const { productionFiles } = require('./helpers/logger-callsites');
  test('โค้ด production ไม่เรียก console.* ตรงๆ (ยกเว้น services/logger.js) — ไม่งั้นข้ามการปิดบังของ logger', () => {
    const offenders = [];
    for (const f of productionFiles(ROOT)) {
      const rel = path.relative(ROOT, f).split(path.sep).join('/');
      if (rel === 'services/logger.js') continue;
      const lines = fs.readFileSync(f, 'utf8').split('\n');
      lines.forEach((l, i) => { if (/\bconsole\.(log|info|warn|error|debug)\s*\(/.test(l) && !/^\s*(\/\/|\*)/.test(l)) offenders.push(`${rel}:${i + 1}`); });
    }
    expect(offenders).toEqual([]);
  });
});
