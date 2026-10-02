'use strict';
// แจ้งเตือน Omada traffic เกิน threshold: config, แปลง bucket→Mbps, วงจรสถานะ (sustain/cooldown/กลับปกติ),
// checker (dry-run, ดึงไม่ได้, อ่านค่าไม่ได้, state คงอยู่), ผู้รับถูกต้อง, และทดสอบผ่าน mock-lab จริง

const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  loadConfig, extractBuckets, evaluate, createChecker, fileStore, emptyState, alertText,
} = require('../services/omada-traffic-alert');
const { createAlertPusher } = require('../services/push-targets');

const NOW = 1_800_000_000; // วินาที (หารด้วย 300 ลงตัว)
const MIN = 60_000;
const BUCKET = 300;
const MB_PER_MBPS = (1e6 / 8) * BUCKET; // bytes ต่อ bucket (300s) ที่เท่ากับ 1 Mbps = 37,500,000

// ลงเวลาเริ่ม bucket ที่ปิดแล้วเสมอ: bucket k มี time = NOW - (k+1)*300 (k=0 คือ bucket ล่าสุดที่ปิด)
const bucketAt = (k) => NOW - (k + 1) * BUCKET;
const act = (items) => ({ apTrafficActivities: items, switchTrafficActivities: [] });
const item = (k, downMbps, upMbps) => ({ time: bucketAt(k), rx: downMbps * MB_PER_MBPS, tx: upMbps * MB_PER_MBPS });
const cfgOf = (env = {}) => loadConfig({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100', ...env });
const silent = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('loadConfig()', () => {
  it('ปิดเป็นค่าเริ่มต้น (ไม่ตั้ง threshold = ไม่ทำงาน) และ default ตามที่ตกลง', () => {
    const c = loadConfig({});
    expect(c).toMatchObject({ enabled: false, downMbps: null, upMbps: null, sustain: 2, cooldownMin: 30, intervalMin: 5, severity: 3, dryRun: false });
  });
  it('ตั้ง DOWN หรือ UP ตัวใดตัวหนึ่งก็เปิดใช้; อีกทิศทางที่ไม่ตั้งจะไม่ถูกตรวจ', () => {
    expect(loadConfig({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '50' })).toMatchObject({ enabled: true, downMbps: 50, upMbps: null });
    expect(loadConfig({ OMADA_TRAFFIC_ALERT_UP_MBPS: '20.5' })).toMatchObject({ enabled: true, downMbps: null, upMbps: 20.5 });
  });
  it('ค่าที่ไม่ใช่ตัวเลขบวก → ไม่เปิดใช้ทิศทางนั้น + เตือน (ไม่ crash ไม่ตั้งเป็น 0)', () => {
    for (const bad of ['abc', '0', '-5', 'NaN']) {
      const c = loadConfig({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: bad });
      expect(c.enabled).toBe(false);
      expect(c.warnings).toHaveLength(1);
    }
  });
  it('ค่าอื่นผิด/นอกช่วง → ใช้ default; dryRun อ่านเฉพาะ "true"', () => {
    const c = loadConfig({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '10', OMADA_TRAFFIC_ALERT_SUSTAIN: '0', OMADA_TRAFFIC_ALERT_COOLDOWN_MIN: 'x', OMADA_TRAFFIC_ALERT_SEVERITY: '9', OMADA_TRAFFIC_ALERT_DRYRUN: 'yes' });
    expect(c).toMatchObject({ sustain: 2, cooldownMin: 30, severity: 3, dryRun: false });
    expect(loadConfig({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '10', OMADA_TRAFFIC_ALERT_DRYRUN: 'TRUE' }).dryRun).toBe(true);
  });
});

describe('extractBuckets()', () => {
  it('แปลง bytes/bucket → Mbps ถูกต้อง (37.5 MB ใน 300 วินาที = 1 Mbps) แยก down=rx / up=tx', () => {
    const r = extractBuckets(act([item(0, 100, 20)]), NOW);
    expect(r.readable).toBe(true);
    expect(r.buckets).toHaveLength(1);
    expect(r.buckets[0].downMbps).toBeCloseTo(100, 6);
    expect(r.buckets[0].upMbps).toBeCloseTo(20, 6);
  });
  it('ใช้เฉพาะ bucket ที่ปิดแล้ว: bucket ที่ยังไม่ครบ 300 วินาทีถูกข้าม', () => {
    const open = { time: NOW - 100, rx: 999 * MB_PER_MBPS, tx: 0 };
    const r = extractBuckets(act([item(0, 5, 5), open]), NOW);
    expect(r.buckets.map((b) => b.time)).toEqual([bucketAt(0)]);
  });
  it('bucket ที่มีแค่ time = ไม่มี traffic (0) และอ่านได้ (เหมือนไซต์จริงที่ว่าง)', () => {
    const r = extractBuckets(act([{ time: bucketAt(1) }, { time: bucketAt(0) }]), NOW);
    expect(r.readable).toBe(true);
    expect(r.buckets.map((b) => [b.downMbps, b.upMbps])).toEqual([[0, 0], [0, 0]]);
  });
  it('เผื่อชื่อ field หลายแบบ (download/upload, trafficDown/trafficUp)', () => {
    const r = extractBuckets(act([{ time: bucketAt(1), download: 4.5e7, upload: 0 }, { time: bucketAt(0), trafficDown: 3.75e7, trafficUp: 3.75e7 }]), NOW);
    expect(r.readable).toBe(true);
    expect(r.buckets[0].downMbps).toBeCloseTo(1.2, 6);
    expect(r.buckets[1].upMbps).toBeCloseTo(1, 6);
  });
  it('มี field ตัวเลขแต่ไม่ตรงชื่อที่รู้จัก → readable:false (ห้ามเดาเป็น 0) และคืนเฉพาะชื่อ field', () => {
    const r = extractBuckets(act([{ time: bucketAt(0), foo: 123456, bar: 9 }]), NOW);
    expect(r.readable).toBe(false);
    expect(r.unmappedKeys).toEqual(['bar', 'foo']);
  });
  it('response ผิดรูป/ว่าง → ไม่ crash', () => {
    for (const v of [undefined, null, {}, { apTrafficActivities: 'x' }, { apTrafficActivities: [null, {}, { time: 'x' }] }]) {
      const r = extractBuckets(v, NOW);
      expect(r.readable).toBe(true);
      expect(r.buckets).toEqual([]);
    }
  });
  it('infer ความกว้าง bucket จากเวลาที่ห่างกัน (เช่น 600s) แล้วคิด Mbps ตามนั้น', () => {
    const items = [{ time: NOW - 1800, rx: 75e6, tx: 0 }, { time: NOW - 1200, rx: 75e6, tx: 0 }];
    const r = extractBuckets(act(items), NOW);
    expect(r.bucketSec).toBe(600);
    expect(r.buckets[0].downMbps).toBeCloseTo(1, 6);
  });
});

describe('evaluate() — วงจรสถานะ', () => {
  const run = (state, seq, cfg = cfgOf(), nowMs = NOW * 1000) => evaluate(state, seq.map(([k, d, u]) => ({ time: bucketAt(k), downMbps: d, upMbps: u })), cfg, nowMs);
  // seq เรียงจากเก่าไปใหม่: k มาก = เก่ากว่า

  it('ต่ำกว่า threshold ไม่แจ้ง', () => {
    const r = run(emptyState(), [[3, 10, 1], [2, 50, 1], [1, 99, 1], [0, 99.9, 1]]);
    expect(r.actions).toEqual([]);
    expect(r.state.active).toBe(false);
  });
  it('เกินแค่ 1 bucket (ไม่ครบ sustain=2) ไม่แจ้ง — กัน spike', () => {
    const r = run(emptyState(), [[2, 10, 0], [1, 500, 0], [0, 10, 0]]);
    expect(r.actions).toEqual([]);
  });
  it('เกินติดกันครบ sustain → แจ้งครั้งเดียว พร้อมค่าสูงสุด', () => {
    const r = run(emptyState(), [[2, 10, 0], [1, 150, 0], [0, 180, 0]]);
    expect(r.actions).toHaveLength(1);
    expect(r.actions[0]).toMatchObject({ type: 'alert', buckets: 2 });
    expect(r.actions[0].peak.down).toBeCloseTo(180, 6);
    expect(r.state.active).toBe(true);
    expect(r.state.lastAlertAt).toBe(NOW * 1000);
  });
  it('ยังเกินต่อเนื่องหลังแจ้งแล้ว ไม่แจ้งซ้ำ', () => {
    const first = run(emptyState(), [[1, 150, 0], [0, 150, 0]]);
    const more = evaluate(first.state, [2, 3, 4, 5].map((i) => ({ time: NOW + i * BUCKET, downMbps: 300, upMbps: 0 })), cfgOf(), (NOW + 3600) * 1000);
    expect(more.actions).toEqual([]);
    expect(more.state.active).toBe(true);
  });
  it('ช่วงเทา (80–100% ของ threshold) ไม่นับเป็นกลับปกติและตัดสาย streak', () => {
    const a = run(emptyState(), [[1, 150, 0], [0, 150, 0]]).state; // active
    const g = evaluate(a, [{ time: NOW + 300, downMbps: 90, upMbps: 0 }, { time: NOW + 600, downMbps: 90, upMbps: 0 }, { time: NOW + 900, downMbps: 90, upMbps: 0 }], cfgOf(), (NOW + 900) * 1000);
    expect(g.actions).toEqual([]);
    expect(g.state.active).toBe(true);
    expect(g.state.underStreak).toBe(0);
  });
  it('กลับปกติ (≤80% ติดกันครบ sustain) → ส่ง recovered แล้วรีเซ็ต', () => {
    const a = run(emptyState(), [[1, 150, 0], [0, 200, 0]]).state;
    const r = evaluate(a, [{ time: NOW + 300, downMbps: 70, upMbps: 0 }, { time: NOW + 600, downMbps: 79, upMbps: 0 }], cfgOf(), (NOW + 600) * 1000);
    expect(r.actions.map((x) => x.type)).toEqual(['recovered']);
    expect(r.actions[0].peak.down).toBeCloseTo(200, 6);
    expect(r.state.active).toBe(false);
    expect(r.state.peak).toEqual({ down: 0, up: 0 });
  });
  it('กลับปกติแล้วเกินอีกหลังพ้น cooldown → แจ้งใหม่', () => {
    const t0 = NOW * 1000;
    let s = run(emptyState(), [[1, 150, 0], [0, 150, 0]], cfgOf(), t0).state;
    s = evaluate(s, [{ time: NOW + 300, downMbps: 10, upMbps: 0 }, { time: NOW + 600, downMbps: 10, upMbps: 0 }], cfgOf(), t0 + 10 * MIN).state;
    expect(s.active).toBe(false);
    const again = evaluate(s, [{ time: NOW + 900, downMbps: 400, upMbps: 0 }, { time: NOW + 1200, downMbps: 400, upMbps: 0 }], cfgOf(), t0 + 31 * MIN);
    expect(again.actions.map((x) => x.type)).toEqual(['alert']);
  });
  it('cooldown: เกินอีกครั้งภายใน 30 นาทีหลังการแจ้งก่อน → ไม่แจ้ง (suppressed) แต่แจ้งได้เมื่อพ้น cooldown ถ้ายังเกิน', () => {
    const t0 = NOW * 1000;
    let s = run(emptyState(), [[1, 150, 0], [0, 150, 0]], cfgOf(), t0).state;
    s = evaluate(s, [{ time: NOW + 300, downMbps: 10, upMbps: 0 }, { time: NOW + 600, downMbps: 10, upMbps: 0 }], cfgOf(), t0 + 10 * MIN).state; // recovered
    const quick = evaluate(s, [{ time: NOW + 900, downMbps: 400, upMbps: 0 }, { time: NOW + 1200, downMbps: 400, upMbps: 0 }], cfgOf(), t0 + 20 * MIN);
    expect(quick.actions.map((x) => x.type)).toEqual(['suppressed']);
    expect(quick.state.active).toBe(false);
    const later = evaluate(quick.state, [{ time: NOW + 1500, downMbps: 400, upMbps: 0 }], cfgOf(), t0 + 31 * MIN);
    expect(later.actions.map((x) => x.type)).toEqual(['alert']);
  });
  it('bucket ที่ประมวลผลแล้วไม่ถูกนับซ้ำเมื่อหน้าต่างที่ดึงซ้อนกัน (idempotent)', () => {
    const seq = [[1, 150, 0], [0, 150, 0]];
    const first = run(emptyState(), seq);
    const second = evaluate(first.state, seq.map(([k, d, u]) => ({ time: bucketAt(k), downMbps: d, upMbps: u })), cfgOf(), NOW * 1000 + 5 * MIN);
    expect(second.actions).toEqual([]);
    expect(second.state.overStreak).toBe(first.state.overStreak);
  });
  it('ตั้งเฉพาะ DOWN: upload สูงแค่ไหนก็ไม่แจ้ง; ตั้งทั้งคู่: ทิศใดทิศหนึ่งเกินก็แจ้ง', () => {
    expect(run(emptyState(), [[1, 1, 9999], [0, 1, 9999]], cfgOf()).actions).toEqual([]);
    const both = cfgOf({ OMADA_TRAFFIC_ALERT_UP_MBPS: '50' });
    expect(run(emptyState(), [[1, 1, 60], [0, 1, 60]], both).actions.map((a) => a.type)).toEqual(['alert']);
    expect(run(emptyState(), [[1, 120, 1], [0, 120, 1]], both).actions.map((a) => a.type)).toEqual(['alert']);
    // กลับปกติต้องต่ำกว่า 80% ทั้งสองทิศ
    const a = run(emptyState(), [[1, 120, 1], [0, 120, 1]], both).state;
    const stillUp = evaluate(a, [{ time: NOW + 300, downMbps: 10, upMbps: 45 }, { time: NOW + 600, downMbps: 10, upMbps: 45 }], both, (NOW + 600) * 1000);
    expect(stillUp.actions).toEqual([]);
  });
  it('sustain ปรับได้ (1 bucket ก็แจ้ง)', () => {
    expect(run(emptyState(), [[0, 500, 0]], cfgOf({ OMADA_TRAFFIC_ALERT_SUSTAIN: '1' })).actions.map((a) => a.type)).toEqual(['alert']);
  });
  it('ไม่แก้ state เดิม (pure)', () => {
    const prev = emptyState();
    const snapshot = JSON.stringify(prev);
    run(prev, [[1, 150, 0], [0, 150, 0]]);
    expect(JSON.stringify(prev)).toBe(snapshot);
  });
});

describe('createChecker()', () => {
  const memStore = (initial = emptyState()) => {
    let saved = JSON.parse(JSON.stringify(initial));
    return { load: () => JSON.parse(JSON.stringify(saved)), save: jest.fn((s) => { saved = JSON.parse(JSON.stringify(s)); return true; }), peek: () => saved };
  };
  const mkOmada = (items) => ({ getTrafficActivities: jest.fn().mockResolvedValue(act(items)) });
  const hot = [item(2, 5, 0), item(1, 150, 0), item(0, 160, 0)];
  const mk = (over = {}) => {
    const logger = silent();
    const pusher = jest.fn().mockResolvedValue({ recipients: 2, sent: 2, failed: 0 });
    const store = over.store || memStore();
    const omada = over.omada || mkOmada(hot);
    const checker = createChecker({ omada, pusher, logger, env: over.env || { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100' }, now: () => NOW * 1000, store });
    return { checker, pusher, logger, store, omada };
  };

  it('ปิดอยู่ (ไม่ตั้ง threshold): ไม่เรียก Omada ไม่ส่งอะไร', async () => {
    const { checker, omada, pusher } = mk({ env: {} });
    expect(await checker.check()).toEqual({ status: 'disabled' });
    expect(omada.getTrafficActivities).not.toHaveBeenCalled();
    expect(pusher).not.toHaveBeenCalled();
  });

  it('เกิน threshold ครบ sustain → ส่ง alert หนึ่งครั้ง severity 3 พร้อมข้อความที่มีค่าและเกณฑ์; รอบถัดไปไม่ซ้ำ', async () => {
    const { checker, pusher } = mk();
    const r = await checker.check();
    expect(r.actions).toEqual(['alert']);
    expect(pusher).toHaveBeenCalledTimes(1);
    const [text, severity] = pusher.mock.calls[0];
    expect(severity).toBe(3);
    expect(text).toMatch(/Omada traffic สูงกว่าเกณฑ์/);
    expect(text).toMatch(/ดาวน์โหลด 160 Mbps/);
    expect(text).toMatch(/> 100 Mbps/);
    await checker.check();
    expect(pusher).toHaveBeenCalledTimes(1);
  });

  it('ต่ำกว่า threshold ไม่ส่ง', async () => {
    const { checker, pusher } = mk({ omada: mkOmada([item(2, 5, 0), item(1, 10, 0), item(0, 20, 0)]) });
    expect((await checker.check()).actions).toEqual([]);
    expect(pusher).not.toHaveBeenCalled();
  });

  it('กลับปกติ → ส่งข้อความ "กลับสู่ปกติ" และเกินอีกหลังพ้น cooldown → แจ้งใหม่', async () => {
    const logger = silent();
    const pusher = jest.fn().mockResolvedValue({ recipients: 1, sent: 1 });
    const store = memStore();
    let nowMs = NOW * 1000;
    const omada = { getTrafficActivities: jest.fn() };
    const checker = createChecker({ omada, pusher, logger, env: { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100' }, now: () => nowMs, store });
    const shifted = (secs, vals) => act(vals.map((v, i) => ({ time: NOW + secs - (vals.length - i) * BUCKET, rx: v * MB_PER_MBPS, tx: 0 })));

    omada.getTrafficActivities.mockResolvedValueOnce(shifted(0, [150, 160]));
    await checker.check();                                     // alert
    nowMs += 10 * MIN;
    omada.getTrafficActivities.mockResolvedValueOnce(shifted(600, [10, 12]));
    await checker.check();                                     // recovered
    expect(pusher.mock.calls.map((c) => c[0].split('\n')[0])).toEqual(['⚠️ Omada traffic สูงกว่าเกณฑ์', '✅ Omada traffic กลับสู่ปกติ']);
    nowMs += 25 * MIN;                                         // ครบ 35 นาทีนับจากการแจ้ง
    omada.getTrafficActivities.mockResolvedValueOnce(shifted(2100, [200, 210]));
    await checker.check();
    expect(pusher).toHaveBeenCalledTimes(3);
    expect(pusher.mock.calls[2][0]).toMatch(/สูงกว่าเกณฑ์/);
  });

  it('DRYRUN: คำนวณ/log แต่ไม่ส่งข้อความเลย และ **ไม่เขียน state ลงไฟล์** (ไม่งั้นปิด dry-run แล้วจะไม่แจ้งครั้งแรก)', async () => {
    const { checker, pusher, logger, store } = mk({ env: { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100', OMADA_TRAFFIC_ALERT_DRYRUN: 'true' } });
    const r = await checker.check();
    expect(r.actions).toEqual(['alert']);
    expect(pusher).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(store.peek().active).toBe(false);
    expect(checker.getState().active).toBe(true); // เดินใน memory เพื่อดูผลใน log
    const logs = logger.info.mock.calls.map((c) => c[0]).join('\n');
    expect(logs).toMatch(/DRYRUN.*bucket ล่าสุด down=160/);
    expect(logs).toMatch(/DRYRUN.*จะส่ง alert/);
  });

  it('ดึง Omada ไม่ได้: ไม่แจ้ง ไม่เปลี่ยน state เตือนครั้งเดียว แล้วกลับมาทำงานต่อได้', async () => {
    const store = memStore();
    const omada = { getTrafficActivities: jest.fn().mockRejectedValue(Object.assign(new Error('boom'), { code: 'ECONNABORTED' })) };
    const { checker, pusher, logger } = mk({ omada, store });
    expect((await checker.check()).status).toBe('fetch-failed');
    expect((await checker.check()).status).toBe('fetch-failed');
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(pusher).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    omada.getTrafficActivities.mockResolvedValue(act(hot));
    expect((await checker.check()).actions).toEqual(['alert']);
  });

  it('อ่านค่า traffic ไม่ได้ (field ไม่รู้จัก): ไม่แจ้ง ไม่แตะ state เตือนครั้งเดียวพร้อมชื่อ field', async () => {
    const omada = mkOmada([{ time: bucketAt(1), weird: 1e9 }, { time: bucketAt(0), weird: 2e9 }]);
    const { checker, pusher, logger, store } = mk({ omada });
    expect((await checker.check()).status).toBe('unreadable');
    await checker.check();
    expect(pusher).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/weird/);
    expect(logger.warn.mock.calls[0][0]).not.toMatch(/1000000000|2000000000/); // ไม่ log ค่า
  });

  it('state คงอยู่ (recreate container ไม่ทำให้แจ้งซ้ำ): checker ใหม่ที่ใช้ store เดิมไม่แจ้งซ้ำ', async () => {
    const store = memStore();
    const a = mk({ store });
    await a.checker.check();
    expect(a.pusher).toHaveBeenCalledTimes(1);
    expect(store.peek().active).toBe(true);
    const b = mk({ store });             // จำลอง process ใหม่อ่าน state เดิม
    await b.checker.check();
    expect(b.pusher).not.toHaveBeenCalled();
  });

  it('ส่งข้อความล้มเหลว ไม่ crash (log error) และ state ถูกบันทึกแล้ว', async () => {
    const { checker, pusher, logger } = mk();
    pusher.mockRejectedValue(new Error('LINE down'));
    await expect(checker.check()).resolves.toMatchObject({ status: 'ok' });
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(/ส่ง alert ไม่สำเร็จ: LINE down/));
  });

  it('ผู้รับถูกต้อง: ผ่าน createAlertPusher จริง severity 3 → เฉพาะ ADMIN/IT_STAFF (ไม่ถึง VIEWER/PENDING/role แปลก)', async () => {
    const users = [
      { id: 'Uadmin', role: 'ADMIN' }, { id: 'Uit', role: 'IT_STAFF' }, { id: 'Uview', role: 'VIEWER' },
      { id: 'Upend', role: 'PENDING' }, { id: 'Uodd', role: 'admin' }, { id: 'Unone', role: undefined },
    ];
    const sent = [];
    const pusher = createAlertPusher({ listUsers: () => users, send: async (to, message) => sent.push({ to, message }), logger: silent() });
    const { checker } = (() => {
      const logger = silent();
      return { checker: createChecker({ omada: mkOmada(hot), pusher, logger, env: { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100' }, now: () => NOW * 1000, store: memStore() }) };
    })();
    await checker.check();
    expect(sent.map((s) => s.to)).toEqual(['Uadmin', 'Uit']);
    expect(sent[0].message.type).toBe('text');
    // severity 4+ จะถึง VIEWER ด้วย (ยืนยันว่า severity ที่ตั้งเป็นตัวกำหนดผู้รับจริง)
    const sent4 = [];
    const pusher4 = createAlertPusher({ listUsers: () => users, send: async (to) => sent4.push(to), logger: silent() });
    await createChecker({ omada: mkOmada(hot), pusher: pusher4, logger: silent(), env: { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100', OMADA_TRAFFIC_ALERT_SEVERITY: '4' }, now: () => NOW * 1000, store: memStore() }).check();
    expect(sent4).toEqual(['Uadmin', 'Uit', 'Uview']);
  });

  it('สลับจาก dry-run เป็นโหมดจริง (process ใหม่ state สะอาด) → แจ้งครั้งแรกจริงแม้ traffic ยังสูง', async () => {
    const store = memStore();
    const dry = mk({ store, env: { OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100', OMADA_TRAFFIC_ALERT_DRYRUN: 'true' } });
    await dry.checker.check();
    const live = mk({ store });
    await live.checker.check();
    expect(live.pusher).toHaveBeenCalledTimes(1);
  });

  it('ค่า threshold เล็กๆ แสดงตามจริง (ไม่ถูกปัดเป็น 0.0)', () => {
    expect(alertText(cfgOf({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '0.001' }), { down: 0.5, up: 0.05 }, 2, 300)).toMatch(/> 0\.001 Mbps/);
  });

  it('ข้อความ alert มีแต่ตัวเลข ไม่มีข้อมูลลับ/ชื่อระบบ', () => {
    const t = alertText(cfgOf({ OMADA_TRAFFIC_ALERT_UP_MBPS: '40' }), { down: 123.456, up: 7 }, 3, 300);
    expect(t).toMatch(/123 Mbps/);
    expect(t).toMatch(/ต่อเนื่อง 3 ช่วง \(~15 นาที\)/);
    expect(t).not.toMatch(/http|token|secret|key/i);
  });
});

describe('fileStore() — state ในไฟล์', () => {
  const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'oalert-')), 'state.json');
  it('เขียนแบบ atomic อ่านกลับได้ ไม่มี .tmp ค้าง', () => {
    const f = tmp();
    const store = fileStore(f);
    const s = { ...emptyState(), active: true, lastAlertAt: 123, overStreak: 3, lastBucketTime: 456, peak: { down: 9.5, up: 1 } };
    expect(store.save(s)).toBe(true);
    expect(store.load()).toEqual(s);
    expect(fs.existsSync(`${f}.tmp`)).toBe(false);
  });
  it('ไม่มีไฟล์/ไฟล์พัง/ค่าผิดชนิด → เริ่มใหม่แบบปลอดภัย (ไม่ crash)', () => {
    const f = tmp();
    const store = fileStore(f);
    expect(store.load()).toEqual(emptyState());
    for (const bad of ['{broken', '', 'null', '[]', JSON.stringify({ active: 'yes', overStreak: -4, lastAlertAt: 'x' })]) {
      fs.writeFileSync(f, bad);
      const s = store.load();
      expect(s.active).toBe(false);
      expect(s.overStreak).toBe(0);
      expect(s.lastAlertAt).toBeNull();
    }
  });
  it('เขียนไม่ได้ → คืน false + log เตือน ไม่ throw', () => {
    const logger = silent();
    const blocker = tmp();
    fs.writeFileSync(blocker, 'x');
    const store = fileStore(path.join(blocker, 'nested', 'state.json'), logger);
    expect(store.save(emptyState())).toBe(false);
    expect(logger.warn).toHaveBeenCalled();
  });
});

// ── ผ่าน mock-lab จริง: service omada ตัวจริง + HTTP จริง + ผู้รับจริง ───────────────────────
describe('ผ่าน mock-lab (Omada traffic-activities จริงของ mock)', () => {
  let server; let omada;
  beforeAll(async () => {
    const { createApp } = require('../mock-lab/server');
    const { app } = createApp({ scenarioFile: '01-baseline-office.yaml' });
    await new Promise((r) => { server = app.listen(0, '127.0.0.1', r); });
    Object.assign(process.env, {
      OMADA_URL: `http://127.0.0.1:${server.address().port}`, OMADA_OMADAC_ID: 'mock-omadac', OMADA_SITE_ID: 'mock-site',
      OMADA_CLIENT_ID: 'mock-client', OMADA_CLIENT_SECRET: 'mock-secret',
    });
    jest.resetModules();
    omada = require('../services/omada');
  });
  afterAll(() => new Promise((r) => server.close(r)));

  const realNow = () => Math.floor(Date.now() / 1000) * 1000;
  const users = [{ id: 'Uadmin', role: 'ADMIN' }, { id: 'Uit', role: 'IT_STAFF' }, { id: 'Uview', role: 'VIEWER' }, { id: 'Upend', role: 'PENDING' }];
  const build = (env) => {
    const sent = [];
    const pusher = createAlertPusher({ listUsers: () => users, send: async (to, m) => sent.push({ to, text: m.text }), logger: silent() });
    let saved = emptyState();
    const store = { load: () => saved, save: (s) => { saved = s; return true; } };
    const { createChecker: mkChecker } = require('../services/omada-traffic-alert');
    return { sent, checker: mkChecker({ omada, pusher, logger: silent(), env, now: realNow, store }) };
  };

  it('threshold ต่ำ → แจ้งถึง ADMIN/IT_STAFF เท่านั้น ครั้งเดียว (รอบที่สองไม่ซ้ำ)', async () => {
    const { sent, checker } = build({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '0.001', OMADA_TRAFFIC_ALERT_SUSTAIN: '2' });
    const r1 = await checker.check();
    expect(r1.status).toBe('ok');
    expect(r1.actions).toEqual(['alert']);
    expect(sent.map((s) => s.to)).toEqual(['Uadmin', 'Uit']);
    expect(sent[0].text).toMatch(/สูงกว่าเกณฑ์/);
    await checker.check();
    expect(sent).toHaveLength(2);
  });

  it('threshold สูงมาก → ไม่แจ้ง', async () => {
    const { sent, checker } = build({ OMADA_TRAFFIC_ALERT_DOWN_MBPS: '100000', OMADA_TRAFFIC_ALERT_UP_MBPS: '100000' });
    expect((await checker.check()).actions).toEqual([]);
    expect(sent).toEqual([]);
  });
});
