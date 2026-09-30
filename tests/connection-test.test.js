'use strict';
jest.mock('../services/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(),
}));
jest.mock('axios', () => {
  const inst = { post: jest.fn(), get: jest.fn() };
  return { create: jest.fn(() => inst), post: jest.fn(), get: jest.fn(), __inst: inst };
});

const axios = require('axios');
const ct = require('../services/connection-test');
const claude = require('../services/ai-providers/claude');
const gemini = require('../services/ai-providers/gemini');
const openai = require('../services/ai-providers/openai');

const httpErr = (status) => Object.assign(new Error(`Request failed with status code ${status}`), { response: { status } });
const codeErr = (code) => Object.assign(new Error(code), { code });
const THAI = /[฀-๿]/;

// axios.post (ใช้โดย zabbix) และ axios.__inst.post (ใช้โดย omada/hik) — mock ทั้งคู่ให้ทดสอบเหมือนกัน
const mockPost = (impl) => { axios.post.mockImplementation(impl); axios.__inst.post.mockImplementation(impl); };
const resolves = (data) => () => Promise.resolve({ status: 200, data });
const rejects = (err) => () => Promise.reject(err);

const CFG = {
  zabbix: { url: 'https://z.example/api_jsonrpc.php', apiToken: 'tok' },
  omada: { url: 'https://o.example:8043', omadacId: 'oid', clientId: 'cid', clientSecret: 'sec', siteId: 's' },
  hik: { url: 'https://h.example', appKey: 'k', appSecret: 's' },
};
const cases = [
  ['zabbix', () => ct.testZabbix(CFG.zabbix), { result: [{ groupid: '1' }] }],
  ['omada', () => ct.testOmada(CFG.omada), { errorCode: 0, result: { accessToken: 'T', expiresIn: 7200 } }],
  ['hikcentral', () => ct.testHikCentral(CFG.hik), { code: '0', data: { list: [] } }],
];

describe.each(cases)('%s', (name, run, okBody) => {
  beforeEach(() => jest.clearAllMocks());

  test('สำเร็จ → ok: true', async () => {
    mockPost(resolves(okBody));
    expect(await run()).toEqual({ ok: true, message: 'เชื่อมต่อสำเร็จ' });
  });
  test.each([
    ['401', httpErr(401), /ไม่ถูกต้อง/],
    ['404', httpErr(404), /ไม่พบ endpoint/],
    ['timeout', codeErr('ECONNABORTED'), /เชื่อมต่อไม่ได้/],
    ['ENOTFOUND', codeErr('ENOTFOUND'), /ไม่พบเซิร์ฟเวอร์/],
    ['error แปลกๆ', new Error('boom secret-xyz'), /เชื่อมต่อไม่สำเร็จ/],
  ])('%s → ok: false ข้อความไทย ไม่ throw ไม่หลุดข้อความดิบ', async (_l, err, re) => {
    mockPost(rejects(err));
    const r = await run();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(THAI);
    expect(r.message).toMatch(re);
    expect(r.message).not.toMatch(/secret-xyz/);
  });
});

describe('field ที่ขาด', () => {
  test('ไม่เรียกเครือข่าย และไม่ throw', async () => {
    jest.clearAllMocks();
    const results = [
      await ct.testZabbix({}), await ct.testZabbix(null), await ct.testOmada({ url: 'https://x' }),
      await ct.testHikCentral({ url: 'ftp://x', appKey: 'a', appSecret: 'b' }), await ct.testAiProvider('claude', ''),
    ];
    for (const r of results) {
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(THAI);
    }
    expect(axios.post).not.toHaveBeenCalled();
    expect(axios.__inst.post).not.toHaveBeenCalled();
  });
});

describe('zabbix', () => {
  beforeEach(() => jest.clearAllMocks());
  test('เติม /api_jsonrpc.php เมื่อกรอกแค่ base URL และใช้ token ที่ส่งมา', async () => {
    mockPost(resolves({ result: [] }));
    await ct.testZabbix({ url: 'https://z.example/', apiToken: 'abc' });
    const [url, , opts] = axios.post.mock.calls[0];
    expect(url).toBe('https://z.example/api_jsonrpc.php');
    expect(opts.headers.Authorization).toBe('Bearer abc');
  });
  test('Zabbix error ใน body (Not authorized) → ข้อความไทย', async () => {
    mockPost(resolves({ error: { code: -32602, data: 'Not authorized.' } }));
    const r = await ct.testZabbix(CFG.zabbix);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/API Token.*ไม่ถูกต้อง/);
  });
});

describe('omada', () => {
  test('errorCode ≠ 0 → ok:false และส่ง credential ที่ทดสอบไปตรงๆ', async () => {
    jest.clearAllMocks();
    mockPost(resolves({ errorCode: -44106, msg: 'bad client' }));
    const r = await ct.testOmada(CFG.omada);
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Omada/);
    const [, body] = axios.__inst.post.mock.calls[0];
    expect(body).toEqual({ omadacId: 'oid', client_id: 'cid', client_secret: 'sec' });
  });
});

describe('testAiProvider', () => {
  afterEach(() => jest.restoreAllMocks());
  test.each([['claude', claude], ['gemini', gemini], ['openai', openai]])('%s สำเร็จ', async (n, mod) => {
    const spy = jest.spyOn(mod, 'complete').mockResolvedValue('ok');
    expect(await ct.testAiProvider(n, 'k')).toEqual({ ok: true, message: 'เชื่อมต่อสำเร็จ' });
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ apiKey: 'k', maxTokens: 64, maxAttempts: 1 }));
  });
  test.each([['claude', claude], ['gemini', gemini], ['openai', openai]])('%s 401/404/timeout', async (n, mod) => {
    const scenarios = [
      [Object.assign(new Error('x'), { status: 401 }), /API Key.*ไม่ถูกต้อง/],
      [Object.assign(new Error('Gemini API error (status 404)'), { status: 404 }), /ไม่พบ endpoint/],
      [codeErr('ETIMEDOUT'), /เชื่อมต่อไม่ได้/],
    ];
    for (const [err, re] of scenarios) {
      jest.spyOn(mod, 'complete').mockRejectedValueOnce(err);
      const r = await ct.testAiProvider(n, 'k');
      expect(r.ok).toBe(false);
      expect(r.message).toMatch(re);
    }
  });
  test('ไม่รู้จัก provider', async () => {
    expect((await ct.testAiProvider('foo', 'k')).ok).toBe(false);
  });

  test('gemini: finishReason MAX_TOKENS (thinking กิน token หมด) → ข้อความไทยเฉพาะ ไม่ตกไป fallback', async () => {
    jest.spyOn(gemini, 'complete').mockRejectedValueOnce(
      new Error('Gemini API: ไม่มีคำตอบใน response (finishReason: MAX_TOKENS, model gemini-3.8-flash)')
    );
    const r = await ct.testAiProvider('gemini', 'k');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/เชื่อมต่อสำเร็จ แต่โมเดลตอบไม่ทัน/);
  });

  test('ไม่มีคำตอบใน response (finishReason อื่นที่ไม่ใช่ MAX_TOKENS) → ข้อความไทยเฉพาะ ไม่ตกไป fallback', async () => {
    jest.spyOn(gemini, 'complete').mockRejectedValueOnce(
      new Error('Gemini API: ไม่มีคำตอบใน response (finishReason: SAFETY, model gemini-3.8-flash)')
    );
    const r = await ct.testAiProvider('gemini', 'k');
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/เชื่อมต่อกับ API สำเร็จ แต่ไม่ได้คำตอบกลับมา/);
  });
});

describe('provider รับ apiKey ตรง (ไม่อ่าน env)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; delete process.env.OPENAI_API_KEY; });
  test('openai ใช้ key ที่ส่งมา', async () => {
    process.env.OPENAI_API_KEY = 'ENV-KEY';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ choices: [{ message: { content: 'x' } }] }) });
    await openai.complete({ systemPrompt: 's', userPrompt: 'u', maxTokens: 10, apiKey: 'PASSED', maxAttempts: 1 });
    expect(global.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer PASSED');
  });
  test('maxAttempts:1 → ไม่ retry', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => '' });
    await expect(openai.complete({ systemPrompt: 's', userPrompt: 'u', apiKey: 'k', maxAttempts: 1 })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('provider ไม่ใส่ response body ใน Error (กัน key หลุดลง log)', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; });
  test.each([['openai', openai], ['gemini', gemini]])('%s', async (n, mod) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'Incorrect API key provided: sk-LEAKME' });
    const err = await mod.complete({ systemPrompt: 's', userPrompt: 'u', apiKey: 'k', maxAttempts: 2 }).catch((e) => e);
    expect(err.status).toBe(401);
    expect(err.message).not.toMatch(/LEAKME/);
    expect(global.fetch).toHaveBeenCalledTimes(2); // retry เดิมยังทำงาน
  });
  test('gemini 400 → ข้อความไทยเรื่อง key', async () => {
    jest.spyOn(gemini, 'complete').mockRejectedValueOnce(Object.assign(new Error('Gemini API error (status 400)'), { status: 400 }));
    expect((await ct.testAiProvider('gemini', 'k')).message).toMatch(/API Key.*ไม่ถูกต้อง/);
  });
});

describe('describeError — timeout ของ AI provider', () => {
  test('error ที่มี isTimeout → ข้อความไทยเรื่อง AI ตอบช้า (ไม่ใช่ "ตรวจสอบ URL")', () => {
    const e = Object.assign(new Error('Gemini API: หมดเวลารอการตอบกลับ (timeout 45000ms)'), { code: 'ETIMEDOUT', isTimeout: true });
    expect(ct.describeError(e)).toBe('AI ตอบช้าเกินกำหนด (หมดเวลารอ) ลองใหม่อีกครั้ง');
  });
  test('จับจากข้อความได้แม้ไม่มี flag (error ที่ถูก wrap ต่อ)', () => {
    expect(ct.describeError(new Error('OpenAI API: หมดเวลารอการตอบกลับ (timeout 45000ms)'))).toMatch(/AI ตอบช้า/);
  });
  test('timeout เครือข่ายทั่วไปยังได้ข้อความเดิม', () => {
    expect(ct.describeError(codeErr('ETIMEDOUT'))).toMatch(/ตรวจสอบ URL/);
  });
  test('testAiProvider: provider timeout → ok:false ข้อความไทย ไม่ throw', async () => {
    jest.spyOn(gemini, 'complete').mockRejectedValueOnce(Object.assign(new Error('Gemini API: หมดเวลารอการตอบกลับ (timeout 45000ms)'), { isTimeout: true, code: 'ETIMEDOUT' }));
    const r = await ct.testAiProvider('gemini', 'k');
    expect(r).toEqual({ ok: false, message: 'AI ตอบช้าเกินกำหนด (หมดเวลารอ) ลองใหม่อีกครั้ง' });
    jest.restoreAllMocks();
  });
});
