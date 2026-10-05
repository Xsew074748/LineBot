'use strict';
// แจ้งเตือน Temperature Alarm จาก HikCentral: config (ค่าเริ่มต้นปลอดภัย/ค่าผิดรูปแบบ), evaluate (ไม่ย้อนส่ง, กันซ้ำ, cooldown, รวมข้อความ),
// ข้อความ (ไม่มีอุณหภูมิ/URL รูป), state (พัง→เริ่มใหม่, atomic), checker (DRYRUN, ดึงไม่ได้/breaker เปิด/ส่งไม่ถึง → state ไม่เปลี่ยน),
// และ service จริงผ่าน mock-lab (record รูปแบบจริง ไม่เอา URL รูป ไม่ให้ AppKey หลุดใน error)

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConfig, evaluate, queryWindow, renderMessage, fmtTime, createChecker, fileStore, normalizeState, freshState,
  OVERLAP_MS, MAX_WINDOW_MS, SEEN_MAX, MAX_SHOWN,
} = require('../services/hik-temp-alarm');
const { createAlertPusher } = require('../services/push-targets');

const P = 'HIKCENTRAL_TEMP_ALARM_';
const NOW = Date.parse('2026-09-17T10:00:00+07:00');
const MIN = 60_000;
const SINCE = NOW - 60 * MIN; // เริ่มทำงานก่อน "ตอนนี้" 1 ชม.
const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });
const baseEnv = (extra = {}) => ({ [`${P}ENABLED`]: 'true', [`${P}CAMERAS`]: '1086,1087,1088,1089', ...extra });
const cfgOf = (extra = {}) => loadConfig(baseEnv(extra));
const ev = (id, cam, minutesAgo, type = 192517) => ({ id, type, cameraId: cam, startMs: NOW - minutesAgo * MIN });
const logText = (logger) => ['info', 'warn', 'error'].flatMap((k) => logger[k].mock.calls.map((c) => c.join(' '))).join('\n');

// ── config ──────────────────────────────────────────────────────────────────────
describe('loadConfig()', () => {
  it('ค่าเริ่มต้นปลอดภัย: ปิด, DRYRUN, types=192517, ไม่มีกล้อง, 60 วินาที, cooldown 10, severity 3', () => {
    expect(loadConfig({})).toMatchObject({
      enabled: false, active: false, dryRun: true, types: [192517], cameras: [], intervalSec: 60, lookbackMin: 30, cooldownMin: 10, severity: 3, warnings: [],
    });
  });
  it('เปิดแล้วต้องมีกล้อง: ENABLED=true แต่ไม่มี CAMERAS → ไม่ทำงาน + เตือน', () => {
    const c = loadConfig({ [`${P}ENABLED`]: 'true' });
    expect(c).toMatchObject({ enabled: true, active: false });
    expect(c.warnings.join(' ')).toMatch(/CAMERAS/);
  });
  it('เปิดครบ: active และอ่านกล้อง/ชนิดได้', () => {
    expect(cfgOf({ [`${P}TYPES`]: '192517, 131330' })).toMatchObject({ active: true, cameras: ['1086', '1087', '1088', '1089'], types: [192517, 131330] });
  });
  it('ENABLED อ่านเฉพาะ "true" (พิมพ์เล็ก/ใหญ่ได้); ค่าอื่นทั้งหมด = ปิด', () => {
    for (const v of ['TRUE', ' true ']) expect(cfgOf({ [`${P}ENABLED`]: v }).enabled).toBe(true);
    for (const v of ['1', 'yes', 'on', '', 'false']) expect(cfgOf({ [`${P}ENABLED`]: v }).enabled).toBe(false);
  });
  it('DRYRUN ปลอดภัยไว้ก่อน: ส่งจริงเมื่อตั้ง "false" ชัดเจนเท่านั้น; พิมพ์ผิด/ว่าง = ยัง dry-run (พิมพ์ผิดมีเตือน)', () => {
    expect(cfgOf({ [`${P}DRYRUN`]: 'false' }).dryRun).toBe(false);
    expect(cfgOf({ [`${P}DRYRUN`]: 'FALSE' }).dryRun).toBe(false);
    for (const v of [undefined, '', 'true', '0', 'no', 'fasle']) expect(cfgOf(v === undefined ? {} : { [`${P}DRYRUN`]: v }).dryRun).toBe(true);
    expect(cfgOf({ [`${P}DRYRUN`]: 'fasle' }).warnings.join(' ')).toMatch(/DRYRUN/);
  });
  it('TYPES ผิดรูปแบบ: ข้ามค่าเสีย + เตือน; ใช้ไม่ได้เลย → default; ซ้ำถูกตัด', () => {
    const a = cfgOf({ [`${P}TYPES`]: '192517,abc,-5,0,1.5,192517' });
    expect(a.types).toEqual([192517]);
    expect(a.warnings.join(' ')).toMatch(/TYPES/);
    const b = cfgOf({ [`${P}TYPES`]: 'x,y' });
    expect(b.types).toEqual([192517]);
    expect(b.warnings.join(' ')).toMatch(/ค่าเริ่มต้น/);
  });
  it('CAMERAS: รหัสผิดรูปแบบ (ช่องว่าง/อักขระพิเศษ/ยาวเกิน) ถูกข้าม + เตือน, ซ้ำถูกตัด, ไม่เกิน 50', () => {
    const c = cfgOf({ [`${P}CAMERAS`]: '1088, 1088,a b,<x>,' + 'z'.repeat(65) + ',1086' });
    expect(c.cameras).toEqual(['1088', '1086']);
    expect(c.warnings.join(' ')).toMatch(/CAMERAS/);
    const many = Array.from({ length: 80 }, (_, i) => `c${i}`).join(',');
    expect(cfgOf({ [`${P}CAMERAS`]: many }).cameras).toHaveLength(50);
  });
  it('LOOKBACK_MIN ปรับได้ (1–1440, ค่าเริ่มต้น 30); นอกช่วง/ไม่ใช่จำนวนเต็ม → 30', () => {
    expect(cfgOf({ [`${P}LOOKBACK_MIN`]: '10' }).lookbackMin).toBe(10);
    expect(cfgOf({ [`${P}LOOKBACK_MIN`]: '1440' }).lookbackMin).toBe(1440);
    for (const bad of ['0', '-5', '1441', 'abc', '1.5', '', ' ']) expect(cfgOf({ [`${P}LOOKBACK_MIN`]: bad }).lookbackMin).toBe(30);
  });
  it('ตัวเลขนอกช่วง/ไม่ใช่ตัวเลข → ใช้ค่าเริ่มต้น (ไม่ crash ไม่เป็น 0/NaN)', () => {
    const c = cfgOf({ [`${P}INTERVAL_SEC`]: '5', [`${P}COOLDOWN_MIN`]: '-1', [`${P}SEVERITY`]: '9' });
    expect(c).toMatchObject({ intervalSec: 60, cooldownMin: 10, severity: 3 });
    expect(cfgOf({ [`${P}INTERVAL_SEC`]: 'abc', [`${P}COOLDOWN_MIN`]: '1.5', [`${P}SEVERITY`]: 'x' })).toMatchObject({ intervalSec: 60, cooldownMin: 10, severity: 3 });
    expect(cfgOf({ [`${P}COOLDOWN_MIN`]: '0', [`${P}SEVERITY`]: '4', [`${P}INTERVAL_SEC`]: '30' })).toMatchObject({ cooldownMin: 0, severity: 4, intervalSec: 30 });
  });
});

// ── evaluate ────────────────────────────────────────────────────────────────────
describe('evaluate()', () => {
  const cfg = cfgOf();
  const state0 = () => freshState(SINCE);

  it('ไม่ย้อนส่ง: เหตุการณ์ที่เกิดก่อนเวลาเริ่มทำงาน (sinceMs) ไม่แจ้งเลย แม้ยังไม่เคยเห็น', () => {
    const r = evaluate(state0(), [ev('old1', '1088', 90), ev('old2', '1088', 61)], cfg, NOW);
    expect(r.actions).toEqual([]);
    expect(r.fresh).toBe(0);
  });
  it('เหตุการณ์ที่เกิดหลังเริ่มทำงาน → แจ้ง 1 ข้อความ และ watermark เลื่อนตาม', () => {
    const r = evaluate(state0(), [ev('e1', '1088', 5)], cfg, NOW);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: 'alert', total: 1, extra: 0, suppressed: 0 });
    expect(r.state.watermarkMs).toBe(NOW - 5 * MIN);
    expect(r.state.seen).toEqual(['e1']);
  });
  it('กันซ้ำด้วย eventIndexCode: record เดิมมาอีก (ช่วงค้นเหลื่อมเวลา) ไม่แจ้งซ้ำ; ซ้ำในชุดเดียวกันนับครั้งเดียว', () => {
    const e = ev('e1', '1088', 5);
    const r1 = evaluate(state0(), [e, e], cfg, NOW);
    expect(r1.actions[0].total).toBe(1);
    const r2 = evaluate(r1.state, [e], cfg, NOW + MIN);
    expect(r2.actions).toEqual([]);
    expect(r2.fresh).toBe(0);
  });
  it('เหตุการณ์ที่มาช้า (เวลาเกิดก่อน watermark แต่ยังไม่เคยเห็น) ยังแจ้ง — ไม่ถูก watermark ตัดทิ้ง', () => {
    const r1 = evaluate(state0(), [ev('late-newer', '1088', 2)], cfg, NOW);
    const r2 = evaluate(r1.state, [ev('late-older', '1089', 20)], cfg, NOW + MIN);
    expect(r2.actions[0]).toMatchObject({ type: 'alert', total: 1 });
    expect(r2.actions[0].shown[0].id).toBe('late-older');
  });
  it('กรองกล้องและชนิดที่ไม่ได้ตั้ง', () => {
    const r = evaluate(state0(), [ev('x1', '9999', 5), ev('x2', '1088', 5, 131330), ev('ok', '1086', 5)], cfg, NOW);
    expect(r.actions[0].shown.map((e) => e.id)).toEqual(['ok']);
  });
  it('cooldown ต่อกล้อง (นับจากเวลาเกิดเหตุ): ซ้ำใน 10 นาทีไม่แจ้งแต่นับรวม; พ้น 10 นาทีแจ้งได้; กล้องอื่นไม่ถูกกระทบ', () => {
    const r = evaluate(state0(), [ev('a', '1088', 30), ev('b', '1088', 25), ev('c', '1089', 24), ev('d', '1088', 15)], cfg, NOW);
    const a = r.actions[0];
    expect(a.shown.map((e) => e.id)).toEqual(['a', 'c', 'd']); // b อยู่ใน cooldown ของ a (5 นาที), d ห่างจาก a 15 นาที
    expect(a.suppressed).toBe(1);
    expect(r.state.seen).toEqual(expect.arrayContaining(['a', 'b', 'c', 'd'])); // b ถูกบันทึกว่าเห็นแล้ว — ไม่โผล่ซ้ำรอบหน้า
    expect(evaluate(r.state, [ev('b', '1088', 25)], cfg, NOW + MIN).actions).toEqual([]);
  });
  it('cooldown ข้ามรอบ: เหตุการณ์ใหม่ของกล้องที่เพิ่งแจ้งไป ไม่แจ้ง (action suppressed อย่างเดียว) แต่แจ้งได้เมื่อพ้นเวลา', () => {
    const r1 = evaluate(state0(), [ev('a', '1088', 12)], cfg, NOW);
    const r2 = evaluate(r1.state, [ev('b', '1088', 6)], cfg, NOW);
    expect(r2.actions).toEqual([{ type: 'suppressed', count: 1 }]);
    const r3 = evaluate(r2.state, [ev('c', '1088', 1)], cfg, NOW + 5 * MIN); // ห่างจาก a (12 นาทีก่อน) = 11 นาที
    expect(r3.actions[0]).toMatchObject({ type: 'alert', total: 1 });
  });
  it('COOLDOWN_MIN=0 ปิด cooldown', () => {
    const r = evaluate(state0(), [ev('a', '1088', 20), ev('b', '1088', 19)], cfgOf({ [`${P}COOLDOWN_MIN`]: '0' }), NOW);
    expect(r.actions[0].total).toBe(2);
  });
  it(`รวมเป็นข้อความเดียว: แสดงสูงสุด ${MAX_SHOWN} + "และอีก N" (เหตุการณ์หลายรายการในรอบเดียวไม่แตกเป็นหลายข้อความ)`, () => {
    const events = Array.from({ length: 8 }, (_, i) => ev(`m${i}`, ['1086', '1087', '1088', '1089'][i % 4], 50 - i * 11)); // กล้องละหลายครั้งห่างกัน ≥ 22 นาที
    const r = evaluate(state0(), events, cfgOf({ [`${P}COOLDOWN_MIN`]: '0' }), NOW);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ total: 8, extra: 8 - MAX_SHOWN });
    expect(r.actions[0].shown).toHaveLength(MAX_SHOWN);
  });
  it('seen ถูกจำกัด 200 รายการล่าสุด และ evaluate ไม่แก้ state เดิม', () => {
    const prev = { ...freshState(SINCE), seen: Array.from({ length: SEEN_MAX }, (_, i) => `s${i}`) };
    const snapshot = JSON.stringify(prev);
    const r = evaluate(prev, [ev('new', '1088', 5)], cfg, NOW);
    expect(JSON.stringify(prev)).toBe(snapshot);
    expect(r.state.seen).toHaveLength(SEEN_MAX);
    expect(r.state.seen[SEEN_MAX - 1]).toBe('new');
    expect(r.state.seen).not.toContain('s0');
  });
  it('state เสีย/ไม่มี → ถือเป็นเริ่มใหม่ ณ เวลาตรวจ (ไม่ย้อนส่ง)', () => {
    const r = evaluate(null, [ev('old', '1088', 5)], cfg, NOW);
    expect(r.actions).toEqual([]);
    expect(r.state.sinceMs).toBe(NOW);
  });
});

describe('queryWindow()', () => {
  it('ไม่ก่อนเวลาเริ่มทำงาน (ไม่ดึงเหตุการณ์เก่า)', () => {
    expect(queryWindow(freshState(NOW), NOW + MIN).startMs).toBe(NOW);
  });
  it('ย้อนจาก watermark 30 นาที (เหลื่อมเวลา)', () => {
    const s = { ...freshState(NOW - 5 * 3600_000), watermarkMs: NOW - 10 * MIN };
    expect(queryWindow(s, NOW)).toEqual({ startMs: NOW - 10 * MIN - OVERLAP_MS, endMs: NOW });
  });
  it('lookback ปรับได้: ใช้ค่าที่ส่งเข้ามาแทน 30 นาที (แต่ยังไม่ก่อน sinceMs/ไม่เกิน 24 ชม.)', () => {
    const s = { ...freshState(NOW - 5 * 24 * 3600_000), watermarkMs: NOW - 10 * MIN };
    expect(queryWindow(s, NOW, 5 * MIN).startMs).toBe(NOW - 15 * MIN);
    expect(queryWindow(s, NOW, 90 * MIN).startMs).toBe(NOW - 100 * MIN);
    expect(queryWindow(s, NOW, 5000 * MIN).startMs).toBe(NOW - MAX_WINDOW_MS);
    expect(queryWindow({ ...s, sinceMs: NOW - 20 * MIN }, NOW, 90 * MIN).startMs).toBe(NOW - 20 * MIN); // ไม่ก่อน sinceMs
  });
  it('ไม่เกิน 24 ชม. แม้ watermark เก่ามาก (เช่น บอทหยุดไปหลายวัน)', () => {
    const s = { ...freshState(NOW - 10 * 24 * 3600_000), watermarkMs: NOW - 5 * 24 * 3600_000 };
    expect(queryWindow(s, NOW).startMs).toBe(NOW - MAX_WINDOW_MS);
  });
});

// ── ข้อความ ─────────────────────────────────────────────────────────────────────
describe('renderMessage()', () => {
  const alert = (shown, extra = 0, suppressed = 0) => ({ type: 'alert', shown, extra, suppressed, total: shown.length + extra });
  it('มีชื่อกล้อง + รหัส + เวลา +07:00 และให้ตรวจอุณหภูมิที่ HikCentral; ไม่มีตัวเลขอุณหภูมิ/URL รูป', () => {
    const t = renderMessage(alert([{ id: 'e', cameraId: '1088', startMs: Date.parse('2026-09-17T09:10:37+07:00') }]), { names: { 1088: 'บ่อขยะ.กล้องความร้อน1-BW' }, nowMs: Date.parse('2026-09-17T09:11:00+07:00') });
    expect(t).toContain('บ่อขยะ.กล้องความร้อน1-BW (1088)');
    expect(t).toContain('2026-09-17 09:10:37 (+07:00)');
    expect(t).toMatch(/ตรวจค่าอุณหภูมิที่ HikCentral/);
    expect(t).not.toMatch(/https?:|°|\d+\.\d+\s*(C|องศา)/);
  });
  it('ไม่มีชื่อกล้อง → ใช้รหัส; เหตุการณ์เก่ากว่า 15 นาที → ระบุว่าย้อนหลัง; มี "และอีก N" และหมายเหตุ cooldown', () => {
    const t = renderMessage(alert([{ id: 'e', cameraId: '7', startMs: NOW - 90 * MIN }], 3, 2), { nowMs: NOW, cooldownMin: 10 });
    expect(t).toContain('กล้อง 7');
    expect(t).toMatch(/เหตุการณ์ย้อนหลัง 2 ชม\./);
    expect(t).toContain('และอีก 3 รายการ');
    expect(t).toMatch(/ไม่นับซ้ำ 2 รายการ.*10 นาที/);
  });
  it('ชื่อกล้องเท่ากับรหัส (ไม่มีชื่อจริง) → ไม่แสดงซ้ำ "X (X)"', () => {
    const t = renderMessage(alert([{ id: 'e', cameraId: 'HQ-CAM-1', startMs: NOW }]), { names: { 'HQ-CAM-1': 'HQ-CAM-1' }, nowMs: NOW });
    expect(t).toContain('กล้อง HQ-CAM-1');
    expect(t).not.toContain('HQ-CAM-1 (HQ-CAM-1)');
  });
  it('fmtTime ใช้เวลาไทย (+07:00)', () => {
    expect(fmtTime(Date.parse('2026-09-17T02:10:37Z'))).toBe('2026-09-17 09:10:37 (+07:00)');
  });
});

// ── state ───────────────────────────────────────────────────────────────────────
describe('normalizeState() / fileStore', () => {
  it('state ที่ไม่ถูกต้องทุกแบบ → null (ผู้เรียกเริ่มใหม่)', () => {
    for (const bad of [null, undefined, 'x', [], {}, { sinceMs: 'a' }, { sinceMs: -1 }, { sinceMs: 0 }]) expect(normalizeState(bad)).toBeNull();
  });
  it('ล้างค่าเสียในฟิลด์ย่อย แต่คง sinceMs; watermark ต่ำกว่า since → ปรับเป็น since', () => {
    const s = normalizeState({ sinceMs: 1000, watermarkMs: 5, seen: ['a', 1, '', null, 'b'], lastAlertByCam: { '1088': 5, 'bad key!': 3, '1089': 'x' } });
    expect(s).toEqual({ sinceMs: 1000, watermarkMs: 1000, seen: ['a', 'b'], lastAlertByCam: { 1088: 5 } });
  });
  it('บันทึก/อ่านแบบ atomic; ไฟล์พัง/ไม่มี → load() เป็น null; เขียนไม่ได้ → false ไม่ throw', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hik-temp-'));
    const file = path.join(dir, 'sub', 'state.json');
    const logger = silent();
    const store = fileStore(file, logger);
    expect(store.load()).toBeNull();
    const s = { ...freshState(SINCE), seen: ['a'] };
    expect(store.save(s)).toBe(true);
    expect(fs.existsSync(`${file}.tmp`)).toBe(false);
    expect(store.load()).toEqual(s);
    fs.writeFileSync(file, '{broken');
    expect(store.load()).toBeNull();
    const blocker = path.join(dir, 'file'); fs.writeFileSync(blocker, 'x');
    expect(fileStore(path.join(blocker, 'x', 'state.json'), logger).save(s)).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

// ── checker ─────────────────────────────────────────────────────────────────────
describe('createChecker()', () => {
  const users = [{ id: 'Uadmin', role: 'ADMIN' }, { id: 'Uit', role: 'IT_STAFF' }, { id: 'Uview', role: 'VIEWER' }, { id: 'Upend', role: 'PENDING' }];
  const memStore = (initial = null) => {
    const s = { doc: initial, saves: 0, load: () => s.doc, save: (d) => { s.doc = JSON.parse(JSON.stringify(d)); s.saves++; return true; } };
    return s;
  };
  function build({ env = {}, events = [], store = memStore(freshState(SINCE)), hikOver = {}, pusherOver = null } = {}) {
    const sent = [];
    const logger = silent();
    const pusher = pusherOver || createAlertPusher({ listUsers: () => users, send: async (to, m) => sent.push({ to, text: m.text }), logger: silent() });
    const hik = {
      getTempAlarmEvents: jest.fn(async () => ({ events, truncated: false })),
      getCameras: jest.fn(async () => [{ id: '1088', name: 'บ่อขยะ.กล้องความร้อน1-BW' }]),
      getBreakerState: () => ({ state: 'closed' }),
      ...hikOver,
    };
    const checker = createChecker({ hikcentral: hik, pusher, logger, env: baseEnv({ [`${P}DRYRUN`]: 'false', ...env }), now: () => NOW, store });
    return { checker, hik, sent, logger, store };
  }

  it('ปิดอยู่ (ไม่ได้ ENABLED) → ไม่ดึง ไม่ส่ง; ENABLED แต่ไม่มีกล้อง → ไม่ทำงาน', async () => {
    const a = build({ env: { [`${P}ENABLED`]: 'false' } });
    expect(await a.checker.check()).toEqual({ status: 'disabled' });
    expect(a.hik.getTempAlarmEvents).not.toHaveBeenCalled();
    const b = build({ env: { [`${P}CAMERAS`]: '' } });
    expect((await b.checker.check()).status).toBe('disabled');
  });

  it('ส่งถึง ADMIN/IT_STAFF เท่านั้นที่ severity 3 (ค่าเริ่มต้น) ด้วยข้อความรวมชื่อกล้อง; รอบสองไม่ซ้ำ; state ถูกบันทึก', async () => {
    const { checker, sent, store } = build({ events: [ev('e1', '1088', 5)] });
    const r = await checker.check();
    expect(r).toMatchObject({ status: 'ok', actions: ['alert'] });
    expect(sent.map((s) => s.to)).toEqual(['Uadmin', 'Uit']);
    expect(sent[0].text).toContain('บ่อขยะ.กล้องความร้อน1-BW (1088)');
    expect(store.doc.seen).toEqual(['e1']);
    await checker.check();
    expect(sent).toHaveLength(2);
  });
  it('SEVERITY=4 → ถึงผู้ใช้ที่อนุมัติแล้วทุกระดับ (VIEWER ด้วย) แต่ PENDING ไม่ได้', async () => {
    const { checker, sent } = build({ events: [ev('e1', '1088', 5)], env: { [`${P}SEVERITY`]: '4' } });
    await checker.check();
    expect(sent.map((s) => s.to)).toEqual(['Uadmin', 'Uit', 'Uview']);
  });

  it('DRYRUN (ค่าเริ่มต้น): ไม่ส่ง LINE ไม่เขียน state แต่ log ข้อความที่จะส่ง และไม่ log ซ้ำรอบถัดไป', async () => {
    const store = memStore(freshState(SINCE));
    const sent = [];
    const pusher = jest.fn(async () => { sent.push(1); return { recipients: 2, sent: 2, failed: 0 }; });
    const logger = silent();
    const hik = { getTempAlarmEvents: jest.fn(async () => ({ events: [ev('e1', '1088', 5)], truncated: false })), getCameras: async () => [{ id: '1088', name: 'กล้องทดสอบ' }] };
    const env = baseEnv(); // ไม่ตั้ง DRYRUN → true
    const checker = createChecker({ hikcentral: hik, pusher, logger, env, now: () => NOW, store });
    expect(checker.config.dryRun).toBe(true);
    const r = await checker.check();
    expect(r.status).toBe('ok');
    expect(pusher).not.toHaveBeenCalled();
    expect(store.saves).toBe(0);
    expect(logText(logger)).toMatch(/DRYRUN.*จะส่ง.*กล้องทดสอบ \(1088\)/);
    const before = logger.info.mock.calls.length;
    await checker.check();
    expect(logger.info.mock.calls.length).toBe(before);
  });
  it('DRYRUN ไม่เขียน state แม้ start() (ไม่สร้างไฟล์ตอนเริ่ม)', () => {
    const store = memStore(null);
    const c = createChecker({ hikcentral: {}, pusher: jest.fn(), logger: silent(), env: baseEnv(), now: () => NOW, store });
    const stop = c.start(); stop();
    expect(store.saves).toBe(0);
  });
  it('ส่งจริง + ไม่มี state: start() บันทึกเวลาเริ่มทำงานทันที (กันเหตุการณ์ช่วงรอ delay ถูกข้าม/รีเซ็ต since)', () => {
    const store = memStore(null);
    const c = createChecker({ hikcentral: {}, pusher: jest.fn(), logger: silent(), env: baseEnv({ [`${P}DRYRUN`]: 'false' }), now: () => NOW, store });
    const stop = c.start(); stop();
    expect(store.doc).toMatchObject({ sinceMs: NOW, watermarkMs: NOW, seen: [] });
  });

  it('ดึงเหตุการณ์ไม่ได้ → ข้ามรอบ: state ไม่เปลี่ยน ไม่ส่งอะไร ไม่เขียนไฟล์; เตือนครั้งเดียว; รอบถัดไปที่ดึงได้แจ้งตามปกติ', async () => {
    let fail = true;
    const { checker, sent, store, logger } = build({ hikOver: { getTempAlarmEvents: jest.fn(async () => { if (fail) throw new Error('timeout'); return { events: [ev('e1', '1088', 5)], truncated: false }; }) } });
    const before = JSON.stringify(checker.getState());
    expect((await checker.check()).status).toBe('fetch-failed');
    expect((await checker.check()).status).toBe('fetch-failed');
    expect(JSON.stringify(checker.getState())).toBe(before);
    expect(sent).toEqual([]);
    expect(store.saves).toBe(0);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    fail = false;
    expect((await checker.check()).actions).toEqual(['alert']);
    expect(sent).toHaveLength(2);
  });
  it('breaker เปิด → ไม่เรียก HikCentral เลย ข้ามรอบ state ไม่เปลี่ยน (CircuitOpenError จาก service ก็ข้ามเช่นกัน)', async () => {
    const open = build({ hikOver: { getBreakerState: () => ({ state: 'open' }) } });
    expect((await open.checker.check()).status).toBe('breaker-open');
    expect(open.hik.getTempAlarmEvents).not.toHaveBeenCalled();
    const err = Object.assign(new Error('circuit open'), { name: 'CircuitOpenError' });
    const thrown = build({ hikOver: { getTempAlarmEvents: jest.fn(async () => { throw err; }) } });
    expect((await thrown.checker.check()).status).toBe('fetch-failed');
    expect(thrown.sent).toEqual([]);
    expect(thrown.store.saves).toBe(0);
  });

  it('ส่ง LINE ไม่ถึงใครเลย (ทุกคนล้มเหลว/pusher โยน) → ไม่บันทึก state รอบหน้าลองใหม่ ไม่สูญเหตุการณ์; ส่งสำเร็จแล้วจึงบันทึก', async () => {
    let mode = 'allfail';
    const pusher = jest.fn(async () => {
      if (mode === 'throw') throw new Error('LINE down');
      return mode === 'allfail' ? { recipients: 2, sent: 0, failed: 2 } : { recipients: 2, sent: 2, failed: 0 };
    });
    const { checker, store, logger } = build({ events: [ev('e1', '1088', 5)], pusherOver: pusher });
    expect((await checker.check()).status).toBe('send-failed');
    expect(store.saves).toBe(0);
    mode = 'throw';
    expect((await checker.check()).status).toBe('send-failed');
    expect(logger.error).toHaveBeenCalled();
    mode = 'ok';
    expect((await checker.check()).status).toBe('ok');
    expect(store.doc.seen).toEqual(['e1']);
    expect(pusher).toHaveBeenCalledTimes(3);
  });
  it('ไม่มีผู้รับที่เข้าเกณฑ์เลย (recipients=0) → ถือว่าจบ บันทึก state (ไม่วนส่งซ้ำไม่รู้จบ)', async () => {
    const { checker, store } = build({ events: [ev('e1', '1088', 5)], pusherOver: jest.fn(async () => ({ recipients: 0, sent: 0, failed: 0 })) });
    expect((await checker.check()).status).toBe('ok');
    expect(store.doc.seen).toEqual(['e1']);
  });

  it('restart: state ที่บันทึกไว้ทำให้ไม่แจ้งเหตุการณ์เดิมซ้ำ (ผ่าน checker ตัวใหม่)', async () => {
    const first = build({ events: [ev('e1', '1088', 5)] });
    await first.checker.check();
    const second = build({ events: [ev('e1', '1088', 5)], store: first.store });
    expect((await second.checker.check()).actions).toEqual([]);
    expect(second.sent).toEqual([]);
  });
  it('ไฟล์ state พัง → เริ่มใหม่นับจากเวลาเริ่มทำงาน: เหตุการณ์เก่าไม่ถูกย้อนส่ง แต่เหตุการณ์หลังจากนั้นแจ้งได้', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hik-temp-'));
    const file = path.join(dir, 'state.json');
    fs.writeFileSync(file, '{not json');
    const sent = [];
    const hik = { getTempAlarmEvents: jest.fn(async () => ({ events: [ev('old', '1088', 30), ev('new', '1089', -2)], truncated: false })), getCameras: async () => [], getBreakerState: () => ({ state: 'closed' }) };
    const c = createChecker({ hikcentral: hik, pusher: async (t) => { sent.push(t); return { recipients: 1, sent: 1, failed: 0 }; }, logger: silent(), env: baseEnv({ [`${P}DRYRUN`]: 'false' }), now: () => NOW, store: fileStore(file, silent()) });
    const r = await c.check();
    expect(r.actions).toEqual(['alert']);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toContain('กล้อง 1089');
    expect(sent[0]).not.toContain('กล้อง 1088');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('ค้นด้วยช่วงที่ถูกต้อง: ไม่ก่อน since, srcIndexs/eventTypes ตาม config', async () => {
    const { checker, hik } = build({ store: memStore({ ...freshState(NOW - 5 * MIN) }) });
    await checker.check();
    expect(hik.getTempAlarmEvents).toHaveBeenCalledWith({ startMs: NOW - 5 * MIN, endMs: NOW, eventTypes: [192517], srcIndexs: '1086,1087,1088,1089' });
  });
  it('LOOKBACK_MIN จาก env มีผลกับช่วงค้นจริง', async () => {
    const st = { ...freshState(NOW - 5 * 3600_000), watermarkMs: NOW - 60 * MIN };
    const a = build({ store: memStore(st), env: { [`${P}LOOKBACK_MIN`]: '5' } });
    await a.checker.check();
    expect(a.hik.getTempAlarmEvents.mock.calls[0][0].startMs).toBe(NOW - 65 * MIN);
    const b = build({ store: memStore(st) }); // ค่าเริ่มต้น 30
    await b.checker.check();
    expect(b.hik.getTempAlarmEvents.mock.calls[0][0].startMs).toBe(NOW - 90 * MIN);
  });
  it('log ไม่มี URL รูป/ข้อความ error ที่เป็นความลับ: error ดิบถูกตัดเหลือ code/ข้อความสั้น', async () => {
    const { checker, logger } = build({ hikOver: { getTempAlarmEvents: jest.fn(async () => { throw Object.assign(new Error('x'.repeat(500)), { code: 'ECONNREFUSED' }); }) } });
    await checker.check();
    const text = logText(logger);
    expect(text).toMatch(/ECONNREFUSED/);
    expect(text.length).toBeLessThan(400);
  });
});

// ── service จริง ผ่าน mock-lab ──────────────────────────────────────────────────
describe('HikCentral service + mock-lab (record รูปแบบจริงของ 192517)', () => {
  let server; let hik;
  beforeAll(async () => {
    const { createApp } = require('../mock-lab/server');
    const { app } = createApp({ scenarioFile: '01-baseline-office.yaml' });
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    Object.assign(process.env, {
      HIKCENTRAL_URL: `http://127.0.0.1:${server.address().port}`, HIKCENTRAL_APP_KEY: 'mock-app-key', HIKCENTRAL_APP_SECRET: 'mock-app-secret',
      HIKCENTRAL_TIMEOUT_MS: '3000',
    });
    jest.resetModules();
    hik = require('../services/hikcentral');
  });
  afterAll(() => new Promise((r) => server.close(r)));

  it('normalizeEventRecord: ตัดช่องรูป/URL ออก เหลือเฉพาะฟิลด์ที่ใช้; record ไม่ครบ → null', () => {
    const raw = { eventIndexCode: 'E1', eventType: '192517', srcType: 'camera', srcIndex: '1088', description: '', startTime: '2026-09-17T09:10:37+07:00', stopTime: '2026-09-17T09:10:52+07:00', eventPicUri: 'https://x/p.jpg', eventPicList: [{ u: 1 }] };
    const n = hik.normalizeEventRecord(raw);
    expect(n).toEqual({ id: 'E1', type: 192517, cameraId: '1088', startMs: Date.parse('2026-09-17T09:10:37+07:00'), stopMs: Date.parse('2026-09-17T09:10:52+07:00') });
    expect(JSON.stringify(n)).not.toMatch(/http|pic/i);
    for (const bad of [null, {}, { ...raw, eventIndexCode: '' }, { ...raw, startTime: 'nope' }, { ...raw, srcIndex: undefined, linkCameraIndexCode: undefined }, { ...raw, eventType: 'abc' }]) expect(hik.normalizeEventRecord(bad)).toBeNull();
  });
  it('redactSecrets: ตัด AppKey/AppSecret/StringToSign ออกจากข้อความ error (Artemis สะท้อน AppKey กลับมา)', () => {
    const msg = 'api AK/SK signature authentication failed,Invalid Signature! and StringToSign: POST\n*/*\nx-ca-key:mock-app-key\n/artemis/x, apiName : Search, appKey : mock-app-key';
    const out = hik.redactSecrets(msg); // โมดูลที่โหลดหลังตั้ง env (APP_KEY อ่านตอนโหลดโมดูล)
    expect(out).not.toContain('mock-app-key');
    expect(out).not.toContain('x-ca-key');
    expect(out).toContain('****-key');
  });
  it('getTempAlarmEvents: ได้เหตุการณ์รูปแบบ normalized (ไม่มีช่องรูป/URL) จากกล้องที่ระบุเท่านั้น', async () => {
    const cams = await hik.getCameras(1, 500);
    const ids = cams.slice(0, 3).map((c) => c.id);
    const now = Date.now();
    const { events, truncated } = await hik.getTempAlarmEvents({ startMs: now - 24 * 3600_000, endMs: now, eventTypes: [192517], srcIndexs: ids.join(',') });
    expect(truncated).toBe(false);
    expect(events.length).toBeGreaterThan(0);
    for (const e of events) {
      expect(Object.keys(e).sort()).toEqual(['cameraId', 'id', 'startMs', 'stopMs', 'type']);
      expect(e.type).toBe(192517);
      expect(ids).toContain(e.cameraId);
    }
    expect(JSON.stringify(events)).not.toMatch(/mock\.invalid|pic/i);
  });
  it('error จาก Artemis (code ≠ 0) ถูก sanitize และคง name/ข้อความสั้น', async () => {
    await expect(hik.getTempAlarmEvents({ startMs: Date.now() - 60_000, endMs: Date.now(), eventTypes: [1], srcIndexs: '1' })).rejects.toThrow(/parameter error/);
  });
  it('checker จริง + service จริง + mock-lab: ผู้รับถูกต้อง, ข้อความมีชื่อกล้องจากระบบ, ไม่มี URL รูป', async () => {
    const cams = await hik.getCameras(1, 500);
    const camIds = cams.slice(0, 4).map((c) => c.id);
    const { createChecker: mk } = require('../services/hik-temp-alarm');
    const sent = [];
    const pusher = createAlertPusher({ listUsers: () => [{ id: 'Uadmin', role: 'ADMIN' }, { id: 'Uview', role: 'VIEWER' }], send: async (to, m) => sent.push({ to, text: m.text }), logger: silent() });
    const realNow = Date.now();
    const store = { doc: { sinceMs: realNow - 3 * 3600_000, watermarkMs: realNow - 3 * 3600_000, seen: [], lastAlertByCam: {} }, load() { return this.doc; }, save(d) { this.doc = d; return true; } };
    const checker = mk({ hikcentral: hik, pusher, logger: silent(), env: { [`${P}ENABLED`]: 'true', [`${P}DRYRUN`]: 'false', [`${P}CAMERAS`]: camIds.join(',') }, now: () => realNow, store });
    const r = await checker.check();
    expect(r.actions).toEqual(['alert']);
    expect(sent.map((s) => s.to)).toEqual(['Uadmin']);
    expect(sent[0].text).toMatch(/Temperature Alarm/);
    expect(sent[0].text).not.toMatch(/mock\.invalid|https?:/);
    expect(cams.some((c) => sent[0].text.includes(c.name))).toBe(true);
    expect((await checker.check()).actions).toEqual([]); // รอบสองไม่ซ้ำ
  });
});

// ── Artemis สะท้อน AppKey/AppSecret/StringToSign กลับมาใน msg ของ error — ต้องไม่หลุดลง error/log ──────────────
describe('error จริงจาก Artemis ที่สะท้อน credential (stub HTTP server)', () => {
  const http = require('http');
  const KEY = 'FULLKEY-8f3a91c2d7';
  const SEC = 'FULLSECRET-zq7w2e5r9t';
  const ECHO = `api AK/SK signature authentication failed,Invalid Signature! and StringToSign: POST\n*/*\napplication/json\nx-ca-key:${KEY}\nx-ca-timestamp:1791176678431\n/artemis/api/eventService/v1/eventRecords/page, apiName : Search for events, appKey : ${KEY}, secret : ${SEC}`;
  let server; let hikReal; let mode = 'code';

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        if (mode === 'http401') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ msg: ECHO })); return; }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: '0x02401003', msg: ECHO }));
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    Object.assign(process.env, { HIKCENTRAL_URL: `http://127.0.0.1:${server.address().port}`, HIKCENTRAL_APP_KEY: KEY, HIKCENTRAL_APP_SECRET: SEC, HIKCENTRAL_TIMEOUT_MS: '3000' });
    jest.resetModules();
    hikReal = require('../services/hikcentral');
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const SECRETS = [KEY, SEC, 'x-ca-key', 'StringToSign: POST', 'x-ca-timestamp'];
  const leaks = (text) => SECRETS.filter((s) => String(text).includes(s));
  const allText = (err) => [err.message, err.stack, String(err), JSON.stringify(err, Object.getOwnPropertyNames(err))].join('\n');
  const fetchOpts = { startMs: NOW - 60 * MIN, endMs: NOW, eventTypes: [192517], srcIndexs: '1088' };

  it('error ที่โยนออกจาก getTempAlarmEvents (message/stack/ทุก property) ไม่มี AppKey/AppSecret/StringToSign แต่ยังบอกรหัสและสาเหตุสั้นๆ', async () => {
    mode = 'code';
    const err = await hikReal.getTempAlarmEvents(fetchOpts).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(leaks(allText(err))).toEqual([]);
    expect(err.message).toMatch(/0x02401003/);
    expect(err.message).toMatch(/Invalid Signature/);
    expect(err.message).toContain('StringToSign:(ตัด)'); // ส่วนลายเซ็นถูกตัดทิ้ง
    expect(err.message.length).toBeLessThanOrEqual(160);
  });
  it('HTTP 4xx ที่ body สะท้อน key: error คง status แต่ไม่พก body ติดมา', async () => {
    mode = 'http401';
    const err = await hikReal.getTempAlarmEvents(fetchOpts).catch((e) => e);
    expect(err.status).toBe(401);
    expect(leaks(allText(err))).toEqual([]);
  });
  it('บรรทัดที่ checker เขียนลง log (และ console ทั้งหมดระหว่างรัน) ไม่มี key/secret เต็ม', async () => {
    mode = 'code';
    const spies = ['log', 'info', 'warn', 'error'].map((k) => jest.spyOn(console, k).mockImplementation(() => {}));
    const logger = silent();
    const store = { doc: freshState(NOW - 3600_000), load() { return this.doc; }, save(d) { this.doc = d; return true; } };
    const checker = createChecker({ hikcentral: hikReal, pusher: jest.fn(), logger, env: baseEnv({ [`${P}DRYRUN`]: 'false' }), now: () => NOW, store });
    const r1 = await checker.check();
    const r2 = await checker.check();
    const consoleText = spies.flatMap((s) => s.mock.calls.map((c) => c.join(' '))).join('\n');
    spies.forEach((s) => s.mockRestore());
    expect(r1.status).toBe('fetch-failed');
    expect(r2.status).toBe('fetch-failed');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(leaks(logText(logger))).toEqual([]);
    expect(leaks(consoleText)).toEqual([]);
    expect(logText(logger)).toMatch(/0x02401003/); // ยังเห็นสาเหตุ (รหัส) ใน log
  });
  it('redactSecrets: ตัด AppKey/AppSecret/StringToSign ทุกตำแหน่ง ไม่ปล่อย msg ดิบ', () => {
    const out = hikReal.redactSecrets(ECHO);
    expect(leaks(out)).toEqual([]);
    expect(out).toMatch(/StringToSign:\(ตัด\)/);
  });
});
