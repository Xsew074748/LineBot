'use strict';
// Circuit breaker ของ HikCentral: เปิดหลังล้มติดกัน N ครั้ง, ปิดเองหลัง cooldown, ไม่กระทบระบบอื่น
// ส่วนแรก = unit ด้วยนาฬิกาปลอม; ส่วนหลัง = ทดสอบ service จริงผ่าน mock-lab (fault injection: hang / error500)

const { createBreaker, CircuitOpenError, isAvailabilityFailure, envPositiveInt } = require('../services/circuit-breaker');

const axiosErr = (code, status) => Object.assign(new Error(code || `HTTP ${status}`), { isAxiosError: true, code, ...(status ? { response: { status } } : {}) });
const timeoutErr = () => axiosErr('ECONNABORTED');
const paramErr = () => new Error('HikCentral API error 2: Incorrect request parameter');

function fakeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}
const mkLogger = () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() });

describe('isAvailabilityFailure()', () => {
  it('timeout / เครือข่ายขาด / HTTP 5xx = ระบบไม่พร้อม', () => {
    for (const code of ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN']) {
      expect(isAvailabilityFailure(axiosErr(code))).toBe(true);
    }
    expect(isAvailabilityFailure(axiosErr(null, 500))).toBe(true);
    expect(isAvailabilityFailure(axiosErr(null, 503))).toBe(true);
  });
  it('คำขอที่เซิร์ฟเวอร์ตอบมาแล้วแต่ปฏิเสธ (4xx, code!=0 ของ artemis, error ที่เราโยนเอง) ไม่นับ', () => {
    expect(isAvailabilityFailure(axiosErr(null, 401))).toBe(false);
    expect(isAvailabilityFailure(axiosErr(null, 404))).toBe(false);
    expect(isAvailabilityFailure(paramErr())).toBe(false);
    expect(isAvailabilityFailure(new TypeError('x'))).toBe(false);
    expect(isAvailabilityFailure(null)).toBe(false);
  });
  it('CircuitOpenError ไม่ถูกนับซ้ำเป็นความล้มเหลว', () => {
    expect(isAvailabilityFailure(new CircuitOpenError('x', 1000))).toBe(false);
  });
});

describe('createBreaker() — นาฬิกาปลอม', () => {
  const setup = (opts = {}) => {
    const clock = fakeClock();
    const logger = mkLogger();
    const breaker = createBreaker({ name: 'hik', failureThreshold: 3, cooldownMs: 60_000, now: clock.now, logger, ...opts });
    return { clock, logger, breaker };
  };
  const fail = (b) => b.execute(async () => { throw timeoutErr(); }).catch((e) => e);
  const ok = (b) => b.execute(async () => 'fine');

  it('ล้มเหลวติดกันครบ N=3 ครั้ง → เปิด; ก่อนครบยังปิดอยู่', async () => {
    const { breaker } = setup();
    await fail(breaker); await fail(breaker);
    expect(breaker.state).toBe('closed');
    await fail(breaker);
    expect(breaker.state).toBe('open');
  });

  it('สำเร็จคั่นกลางรีเซ็ตตัวนับ (ไม่ใช่ล้มรวมทั้งหมด แต่ล้ม "ติดกัน")', async () => {
    const { breaker } = setup();
    await fail(breaker); await fail(breaker);
    await ok(breaker);
    await fail(breaker); await fail(breaker);
    expect(breaker.state).toBe('closed');
    await fail(breaker);
    expect(breaker.state).toBe('open');
  });

  it('error ที่ไม่ใช่ความล้มเหลวของระบบ (เช่น code=2) ไม่นับ และรีเซ็ตตัวนับ', async () => {
    const { breaker } = setup();
    for (let i = 0; i < 10; i++) {
      await expect(breaker.execute(async () => { throw paramErr(); })).rejects.toThrow(/parameter/);
    }
    expect(breaker.state).toBe('closed');
    await fail(breaker); await fail(breaker);
    await expect(breaker.execute(async () => { throw paramErr(); })).rejects.toThrow();
    await fail(breaker); await fail(breaker);
    expect(breaker.state).toBe('closed'); // ตัวนับถูกรีเซ็ตด้วยคำขอที่เซิร์ฟเวอร์ตอบมา
  });

  it('ตอน open: ปฏิเสธทันทีด้วย CircuitOpenError โดยไม่เรียกฟังก์ชันจริง', async () => {
    const { breaker } = setup();
    for (let i = 0; i < 3; i++) await fail(breaker);
    const fn = jest.fn(async () => 'x');
    const err = await breaker.execute(fn).catch((e) => e);
    expect(err).toBeInstanceOf(CircuitOpenError);
    expect(err.code).toBe('ECIRCUITOPEN');
    expect(err.retryInMs).toBe(60_000);
    expect(err.message).toMatch(/circuit breaker เปิดอยู่/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('ปิดเองหลัง cooldown: คำขอทดลองสำเร็จ → closed และเรียกได้ปกติ', async () => {
    const { breaker, clock } = setup();
    for (let i = 0; i < 3; i++) await fail(breaker);
    clock.advance(59_999);
    await expect(ok(breaker)).rejects.toBeInstanceOf(CircuitOpenError); // ยังไม่ครบ cooldown
    clock.advance(1);
    expect(breaker.state).toBe('half_open');
    await expect(ok(breaker)).resolves.toBe('fine');
    expect(breaker.state).toBe('closed');
    await expect(ok(breaker)).resolves.toBe('fine');
  });

  it('half-open ปล่อยคำขอทดลองเพียง 1 ตัว ที่เหลือถูกปฏิเสธระหว่างรอผล', async () => {
    const { breaker, clock } = setup();
    for (let i = 0; i < 3; i++) await fail(breaker);
    clock.advance(60_000);
    let release;
    const probe = breaker.execute(() => new Promise((resolve) => { release = resolve; }));
    const second = await breaker.execute(async () => 'x').catch((e) => e);
    expect(second).toBeInstanceOf(CircuitOpenError);
    release('probe-ok');
    await expect(probe).resolves.toBe('probe-ok');
    expect(breaker.state).toBe('closed');
  });

  it('คำขอทดลองล้มเหลว → เปิดอีกรอบและเริ่มนับ cooldown ใหม่', async () => {
    const { breaker, clock } = setup();
    for (let i = 0; i < 3; i++) await fail(breaker);
    clock.advance(60_000);
    await fail(breaker); // ตัวทดลองล้ม
    expect(breaker.state).toBe('open');
    clock.advance(59_000);
    await expect(ok(breaker)).rejects.toBeInstanceOf(CircuitOpenError); // cooldown เริ่มใหม่ ยังไม่ครบ
    clock.advance(1_000);
    await expect(ok(breaker)).resolves.toBe('fine');
    expect(breaker.state).toBe('closed');
  });

  it('คำขอทดลองที่เซิร์ฟเวอร์ตอบมาแต่ปฏิเสธ (code=2) ถือว่าเซิร์ฟเวอร์กลับมาแล้ว → closed', async () => {
    const { breaker, clock } = setup();
    for (let i = 0; i < 3; i++) await fail(breaker);
    clock.advance(60_000);
    await expect(breaker.execute(async () => { throw paramErr(); })).rejects.toThrow(/parameter/);
    expect(breaker.state).toBe('closed');
  });

  it('log เมื่อเปลี่ยนสถานะเท่านั้น: OPEN / HALF_OPEN / CLOSED อย่างละครั้ง ไม่ log ทุกคำขอที่ถูกปฏิเสธ', async () => {
    const { breaker, clock, logger } = setup();
    for (let i = 0; i < 3; i++) await fail(breaker);
    for (let i = 0; i < 20; i++) await ok(breaker).catch(() => {});
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toMatch(/circuit\[hik\]: OPEN/);
    expect(logger.warn.mock.calls[0][0]).toMatch(/ล้มเหลวติดกัน 3 ครั้ง/);
    clock.advance(60_000);
    await ok(breaker);
    const infos = logger.info.mock.calls.map((c) => c[0]);
    expect(infos.filter((m) => /HALF_OPEN/.test(m))).toHaveLength(1);
    expect(infos.filter((m) => /CLOSED/.test(m))).toHaveLength(1);
    await ok(breaker); await ok(breaker);
    expect(logger.info.mock.calls.filter((c) => /CLOSED/.test(c[0]))).toHaveLength(1); // ปิดอยู่แล้วไม่ log ซ้ำ
  });

  it('ค่า threshold/cooldown ปรับได้ และ snapshot บอกสถานะ/เวลาที่เหลือ', async () => {
    const { breaker, clock } = setup({ failureThreshold: 1, cooldownMs: 5_000 });
    await fail(breaker);
    expect(breaker.snapshot()).toMatchObject({ name: 'hik', state: 'open', retryInMs: 5_000 });
    clock.advance(2_000);
    expect(breaker.snapshot().retryInMs).toBe(3_000);
    clock.advance(3_000);
    expect(breaker.snapshot().state).toBe('half_open');
  });

  it('breaker คนละตัวแยกกัน: ตัวหนึ่งเปิดไม่กระทบอีกตัว', async () => {
    const clock = fakeClock();
    const hik = createBreaker({ name: 'hik', now: clock.now });
    const zabbix = createBreaker({ name: 'zabbix', now: clock.now });
    for (let i = 0; i < 3; i++) await fail(hik);
    expect(hik.state).toBe('open');
    expect(zabbix.state).toBe('closed');
    await expect(ok(zabbix)).resolves.toBe('fine');
  });

  it('envPositiveInt: ค่าผิด/ศูนย์/ติดลบ → ใช้ default', () => {
    expect(envPositiveInt('5', 3)).toBe(5);
    for (const bad of [undefined, '', '0', '-2', 'abc', null]) expect(envPositiveInt(bad, 3)).toBe(3);
  });
});

// ── service จริง ผ่าน mock-lab ──────────────────────────────────────────────────
describe('HikCentral service + breaker (mock-lab fault injection)', () => {
  let server; let base; let holder; let hik; let statsService;
  const setFault = (mode) => fetch(`${base}/mock/fault`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ system: 'hikcentral', mode }) });
  const hikHits = () => holder.requests.filter((r) => r.system === 'hikcentral' && !/FAULT/.test(r.what)).length;
  const faultHits = () => holder.requests.filter((r) => r.system === 'hikcentral' && /FAULT/.test(r.what)).length;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  beforeAll(async () => {
    const { createApp } = require('../mock-lab/server');
    const created = createApp({ scenarioFile: '01-baseline-office.yaml' });
    holder = created.holder;
    await new Promise((r) => { server = created.app.listen(0, '127.0.0.1', r); });
    base = `http://127.0.0.1:${server.address().port}`;
    Object.assign(process.env, {
      HIKCENTRAL_URL: base, HIKCENTRAL_APP_KEY: 'mock-app-key', HIKCENTRAL_APP_SECRET: 'mock-app-secret',
      HIKCENTRAL_TIMEOUT_MS: '150', HIKCENTRAL_BREAKER_THRESHOLD: '3', HIKCENTRAL_BREAKER_COOLDOWN_MS: '500',
    });
    jest.resetModules();
    hik = require('../services/hikcentral');
    statsService = require('../services/stats');
  });
  afterAll(async () => {
    await setFault('ok');
    if (server.closeAllConnections) server.closeAllConnections();
    await new Promise((r) => server.close(r));
    delete process.env.HIKCENTRAL_TIMEOUT_MS; delete process.env.HIKCENTRAL_BREAKER_THRESHOLD; delete process.env.HIKCENTRAL_BREAKER_COOLDOWN_MS;
  });

  it('ปกติ: closed และดึงกล้องได้', async () => {
    expect(hik.getBreakerState().state).toBe('closed');
    const cams = await hik.getCameras(1, 1000);
    expect(cams.length).toBeGreaterThan(0);
  });

  it('server ค้าง (hang): ล้มด้วย timeout ติดกัน 3 ครั้ง → breaker เปิด → ครั้งถัดไปล้มทันทีโดยไม่ยิงไปที่ server', async () => {
    await setFault('hang');
    for (let i = 0; i < 3; i++) {
      const t0 = Date.now();
      await expect(hik.getCameras(1, 1000)).rejects.toMatchObject({ code: 'ECONNABORTED' });
      expect(Date.now() - t0).toBeGreaterThanOrEqual(120); // รอ timeout จริง
    }
    expect(hik.getBreakerState().state).toBe('open');

    const before = faultHits() + hikHits();
    const t0 = Date.now();
    const err = await hik.getCameras(1, 1000).catch((e) => e);
    expect(Date.now() - t0).toBeLessThan(50); // ล้มทันที ไม่ต้องรอ timeout
    expect(err.code).toBe('ECIRCUITOPEN');
    await hik.healthCheck().then((r) => { expect(r.ok).toBe(false); expect(r.error).toMatch(/circuit breaker เปิดอยู่/); });
    expect(faultHits() + hikHits()).toBe(before); // ไม่มีคำขอหลุดไปถึง server เลย
  });

  it('/stats ตอน breaker เปิด: partial ทันที, breakers.hikcentral=open และระบบอื่น (Zabbix/Omada) ไม่ถูกกระทบ', async () => {
    const zabbix = {
      getProblems: jest.fn().mockResolvedValue([{ priority: 4 }]), getHosts: jest.fn().mockResolvedValue([{ available: 1 }]),
      getCameras: jest.fn().mockResolvedValue([]),
    };
    const omada = { getAPs: jest.fn().mockResolvedValue({ aps: [{ status: 'up' }], switches: [] }) };
    const t0 = Date.now();
    const stats = await statsService.buildStats({ monitorKeys: ['zabbix', 'omada', 'hikcentral'], zabbix, omada, hikcentral: hik });
    expect(Date.now() - t0).toBeLessThan(100); // ไม่ต้องรอ timeout 4 วินาทีของ Hik
    expect(stats.partial).toBe(true);
    expect(stats.failed).toEqual(['hikcentral']);
    expect(stats.breakers).toEqual({ hikcentral: 'open' });
    expect(stats.problems.total).toBe(1);
    expect(stats.devices.aps).toEqual({ total: 1, up: 1, down: 0 });
    expect(stats.devices.hosts.total).toBe(1);
  });

  it('override (ทดสอบ config ที่ยังไม่บันทึก) ข้าม breaker: ใช้ได้แม้ breaker เปิด และไม่เปลี่ยนสถานะ', async () => {
    await setFault('ok');
    expect(hik.getBreakerState().state).toBe('open'); // cooldown ยังไม่ครบ
    await expect(hik.checkAuth({ url: base, appKey: 'mock-app-key', appSecret: 'mock-app-secret' })).resolves.toBeUndefined();
    expect(hik.getBreakerState().state).toBe('open');
  });

  it('ครบ cooldown → half-open → คำขอทดลองสำเร็จ → closed (server กลับมา)', async () => {
    await sleep(550);
    expect(hik.getBreakerState().state).toBe('half_open');
    const cams = await hik.getCameras(1, 1000);
    expect(cams.length).toBeGreaterThan(0);
    expect(hik.getBreakerState().state).toBe('closed');
  });

  it('HTTP 500 จาก server ก็นับเป็นความล้มเหลว (เปิดหลัง 3 ครั้ง)', async () => {
    await setFault('error500');
    for (let i = 0; i < 3; i++) await expect(hik.getCameras(1, 1000)).rejects.toMatchObject({ response: { status: 500 } });
    expect(hik.getBreakerState().state).toBe('open');
    await setFault('ok');
    await sleep(550);
    await hik.getCameras(1, 1000);
    expect(hik.getBreakerState().state).toBe('closed');
  });

  it('คำขอที่เราส่งผิด (artemis code=2) ไม่ทำให้ breaker เปิด แม้ผิดซ้ำหลายครั้ง', async () => {
    for (let i = 0; i < 6; i++) {
      await expect(hik.getEventRecords({ startMs: Date.now() - 60_000, endMs: Date.now(), eventTypes: [1] })).rejects.toThrow(/parameter error/);
    }
    expect(hik.getBreakerState().state).toBe('closed');
    expect((await hik.getCameras(1, 1000)).length).toBeGreaterThan(0);
  });

  it('/stats ปกติ: breakers.hikcentral=closed และไม่ partial', async () => {
    const stats = await statsService.buildStats({ monitorKeys: ['hikcentral'], hikcentral: hik });
    expect(stats.breakers).toEqual({ hikcentral: 'closed' });
    expect(stats.partial).toBeUndefined();
  });

  it('stats ที่ไม่มี service รองรับ breaker (mock เดิมใน test อื่น) ไม่มี field breakers และไม่พัง', async () => {
    const stats = await statsService.buildStats({ monitorKeys: ['hikcentral'], hikcentral: { getCameras: async () => [] } });
    expect(stats.breakers).toBeUndefined();
  });
});
