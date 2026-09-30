'use strict';
// Unit Tests สำหรับระบบเลือก AI Provider (Claude / Gemini / OpenAI)
// รัน: npm test

jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
  apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

// Anthropic SDK จำลอง: messages.create(body, { signal }) ค้างจนกว่า signal จะ abort แล้ว reject แบบเดียวกับ SDK จริง
const mockCreate = jest.fn();
jest.mock('@anthropic-ai/sdk', () => jest.fn().mockImplementation(() => ({ messages: { create: (...a) => mockCreate(...a) } })));

const { getProvider } = require('../services/ai-providers');
const claudeProvider = require('../services/ai-providers/claude');
const retry = require('../services/ai-providers/retry');
const logger = require('../services/logger');
const geminiProvider = require('../services/ai-providers/gemini');
const openaiProvider = require('../services/ai-providers/openai');

// backoff ของ retry จริงคือ 2s/4s — ในเทสตั้งให้เกือบ 0 เพื่อไม่ต้องรอ (ค่าที่ใช้จริงตรวจแยกด้วย spy ใน describe backoff)
process.env.AI_RETRY_BASE_MS = '1';

const ORIGINAL_ENV = { ...process.env };
const KEYS_TO_CLEAR = ['AI_PROVIDER', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY', 'OPENAI_API_KEY'];

function resetEnv() {
  process.env = { ...ORIGINAL_ENV };
  KEYS_TO_CLEAR.forEach((k) => delete process.env[k]);
}

afterAll(() => { process.env = ORIGINAL_ENV; });

describe('ai-providers/index — getProvider()', () => {
  beforeEach(resetEnv);

  test('คืน claude เมื่อ AI_PROVIDER ไม่ได้ตั้งค่า (default) และมี ANTHROPIC_API_KEY', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    const { name } = getProvider();
    expect(name).toBe('claude');
  });

  test('คืน claude เมื่อ AI_PROVIDER=gemini แต่ไม่มี GEMINI_API_KEY (fallback)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_PROVIDER = 'gemini';
    const { name, module } = getProvider();
    expect(name).toBe('claude');
    expect(module.complete).toBeDefined();
  });

  test('คืน claude เมื่อ AI_PROVIDER=openai แต่ไม่มี OPENAI_API_KEY (fallback)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_PROVIDER = 'openai';
    const { name } = getProvider();
    expect(name).toBe('claude');
  });

  test('คืน gemini เมื่อตั้งค่าครบ', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_PROVIDER = 'gemini';
    process.env.GEMINI_API_KEY = 'gm-test';
    const { name, module } = getProvider();
    expect(name).toBe('gemini');
    expect(module).toBe(geminiProvider);
  });

  test('คืน openai เมื่อตั้งค่าครบ', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_PROVIDER = 'openai';
    process.env.OPENAI_API_KEY = 'oa-test';
    const { name, module } = getProvider();
    expect(name).toBe('openai');
    expect(module).toBe(openaiProvider);
  });

  test('AI_PROVIDER ตัวพิมพ์ใหญ่ก็ต้องใช้ได้ (case-insensitive)', () => {
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
    process.env.AI_PROVIDER = 'GEMINI';
    process.env.GEMINI_API_KEY = 'gm-test';
    const { name } = getProvider();
    expect(name).toBe('gemini');
  });

  test('throw เมื่อไม่มี ANTHROPIC_API_KEY เลย (ไม่มีทาง fallback)', () => {
    // ไม่ตั้ง AI_PROVIDER (default claude) และไม่มี key เลย
    expect(() => getProvider()).toThrow(/ANTHROPIC_API_KEY/);
  });
});

describe('ai-providers/gemini — parse response ตาม shape จริงของ Gemini API', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test('parse candidates[0].content.parts[0].text + usageMetadata ถูกต้อง, auth ผ่าน query param', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: '  สวัสดีครับ  ' }] } }],
        usageMetadata: { promptTokenCount: 12, candidatesTokenCount: 8 },
      }),
    });

    const result = await geminiProvider.complete({ systemPrompt: 'sys', userPrompt: 'user', maxTokens: 100 });
    expect(result).toBe('สวัสดีครับ');
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const [url, opts] = global.fetch.mock.calls[0];
    // อ้างชื่อรุ่นจาก export ของโมดูลเอง ไม่ hardcode ซ้ำ — กัน test พังทุกครั้งที่เปลี่ยนรุ่นตาม Google
    expect(url).toContain(`generativelanguage.googleapis.com/v1beta/models/${geminiProvider.MODEL}:generateContent`);
    expect(url).toContain('key=gm-test');

    const body = JSON.parse(opts.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.contents).toEqual([{ role: 'user', parts: [{ text: 'user' }] }]);
    // thinkingConfig: ปิด reasoning ไม่ให้กิน maxOutputTokens (ดูคอมเมนต์ใน gemini.js)
    expect(body.generationConfig).toEqual({ maxOutputTokens: 100, thinkingConfig: { thinkingBudget: 0 } });
  });

  test('retry 1 ครั้งเมื่อ attempt แรก fail แล้วสำเร็จ attempt 2', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }),
      });

    const result = await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' });
    expect(result).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throw หลัง fail ครบ 3 ครั้ง', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('throw เมื่อ response ไม่มี candidates/text (shape ผิดคาด)', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
    await expect(geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/finishReason: unknown/);
    expect(global.fetch).toHaveBeenCalledTimes(3); // retry ด้วยเพราะถือเป็นความล้มเหลวเหมือนกัน
  });

  test('throw พร้อมระบุ finishReason: MAX_TOKENS เมื่อ thinking กิน token จนไม่เหลือคำตอบ', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [] }, finishReason: 'MAX_TOKENS' }] }),
    });
    await expect(geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u', maxTokens: 10 }))
      .rejects.toThrow(/finishReason: MAX_TOKENS/);
  });
});

describe('ai-providers/openai — parse response ตาม shape จริงของ OpenAI API', () => {
  const originalFetch = global.fetch;
  afterEach(() => { global.fetch = originalFetch; });

  test('parse choices[0].message.content + usage ถูกต้อง, auth ผ่าน Bearer header', async () => {
    process.env.OPENAI_API_KEY = 'oa-test';
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '  hello  ' } }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    });

    const result = await openaiProvider.complete({ systemPrompt: 'sys', userPrompt: 'user', maxTokens: 200 });
    expect(result).toBe('hello');

    const [url, opts] = global.fetch.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/chat/completions');
    expect(opts.headers.Authorization).toBe('Bearer oa-test');

    const body = JSON.parse(opts.body);
    expect(body.model).toBe('gpt-4o');
    expect(body.messages).toEqual([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'user' },
    ]);
    expect(body.max_tokens).toBe(200);
  });

  test('retry 1 ครั้งเมื่อ attempt แรก fail แล้วสำเร็จ attempt 2', async () => {
    process.env.OPENAI_API_KEY = 'oa-test';
    global.fetch = jest.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'server error' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ choices: [{ message: { content: 'ok' } }] }),
      });

    const result = await openaiProvider.complete({ systemPrompt: 's', userPrompt: 'u' });
    expect(result).toBe('ok');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throw หลัง fail ครบ 3 ครั้ง', async () => {
    process.env.OPENAI_API_KEY = 'oa-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(openaiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });
});

// ── timeout ของ provider (ตั้ง AI_TIMEOUT_MS สั้นๆ แค่ในเทส — ค่าจริง default 45 วินาที) ─────────────
// fetch/SDK จำลองที่ "ค้าง" จนกว่าจะถูก abort ด้วย signal (เหมือนผู้ให้บริการที่ hang ไม่ตอบ)
const hangUntilAborted = (signal) => new Promise((_, reject) => {
  signal.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
});

describe('ai-providers — timeout เมื่อผู้ให้บริการค้างไม่ตอบ', () => {
  beforeEach(() => {
    resetEnv();
    process.env.AI_TIMEOUT_MS = '60';
    process.env.GEMINI_API_KEY = 'gm-test';
    process.env.OPENAI_API_KEY = 'oa-test';
    process.env.ANTHROPIC_API_KEY = 'ak-test';
    mockCreate.mockReset();
  });

  test.each([
    ['gemini', geminiProvider, 'Gemini API: หมดเวลารอการตอบกลับ (timeout 60ms)'],
    ['openai', openaiProvider, 'OpenAI API: หมดเวลารอการตอบกลับ (timeout 60ms)'],
  ])('%s: fetch ค้าง → throw error ระบุ timeout ชัดเจน (isTimeout) และไม่ retry', async (_n, provider, re) => {
    global.fetch = jest.fn((url, opts) => hangUntilAborted(opts.signal));
    const started = Date.now();
    const err = await provider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(err.message).toMatch(re);
    expect(err.isTimeout).toBe(true);
    expect(err.code).toBe('ETIMEDOUT');
    expect(global.fetch).toHaveBeenCalledTimes(1); // ไม่ retry หลัง timeout — ไม่ให้ผู้ใช้รอเป็น 2 เท่า
    expect(Date.now() - started).toBeLessThan(1500);
  });

  test('claude: SDK ค้าง → throw error ระบุ timeout ชัดเจน และไม่ retry', async () => {
    mockCreate.mockImplementation((body, opts) => hangUntilAborted(opts.signal));
    const err = await claudeProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(err.message).toMatch('Claude API: หมดเวลารอการตอบกลับ (timeout 60ms)');
    expect(err.isTimeout).toBe(true);
    expect(mockCreate).toHaveBeenCalledTimes(1);
  });

  test('error อื่นที่ไม่ใช่ timeout ยังถูก retry ตามเดิม (ไม่กระทบพฤติกรรมเดิม)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503, text: async () => '' });
    const err = await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(err.isTimeout).toBeUndefined();
    expect(err.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('ตอบทันเวลา → ไม่ timeout และส่ง signal ให้ fetch', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] }) });
    expect(await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).toBe('ok');
    expect(global.fetch.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  test('AI_TIMEOUT_MS ไม่ถูกต้อง → ใช้ค่า default 45 วินาที', () => {
    const { getTimeoutMs, DEFAULT_AI_TIMEOUT_MS } = require('../services/ai-providers/timeout');
    process.env.AI_TIMEOUT_MS = 'abc';
    expect(getTimeoutMs()).toBe(DEFAULT_AI_TIMEOUT_MS);
    expect(DEFAULT_AI_TIMEOUT_MS).toBe(45000);
    process.env.AI_TIMEOUT_MS = '-5';
    expect(getTimeoutMs()).toBe(45000);
  });
});

// ── retry 3 attempt + backoff + diagnostics ที่ปลอดภัย ─────────────────────────────────────────────
const jsonRes = (status, body, headers = {}) => ({
  ok: false, status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
});
const okGemini = { ok: true, json: async () => ({ candidates: [{ content: { parts: [{ text: 'สำเร็จ' }] } }] }) };
const logLines = (fn) => fn.mock.calls.map((c) => c.map((x) => (x instanceof Error ? x.message : String(x))).join(' '));
const allLogs = () => [...logLines(logger.warn), ...logLines(logger.error)].join('\n');

describe('retry: 3 attempt + backoff (ใช้ค่า backoff จริง 2s/4s ตรวจผ่าน spy ไม่รอจริง)', () => {
  let sleepSpy;
  beforeEach(() => {
    resetEnv();
    delete process.env.AI_RETRY_BASE_MS; // ใช้ค่า default จริง (2000)
    process.env.GEMINI_API_KEY = 'gm-test';
    process.env.OPENAI_API_KEY = 'oa-test';
    sleepSpy = jest.spyOn(retry.timers, 'sleep').mockResolvedValue();
    logger.warn.mockClear(); logger.error.mockClear();
  });
  afterEach(() => { sleepSpy.mockRestore(); process.env.AI_RETRY_BASE_MS = '1'; });

  test('503 สองครั้งแล้ว attempt 3 สำเร็จ → ได้ผลลัพธ์ และ backoff = 2000ms แล้ว 4000ms', async () => {
    global.fetch = jest.fn()
      .mockResolvedValueOnce(jsonRes(503, {}))
      .mockResolvedValueOnce(jsonRes(503, {}))
      .mockResolvedValueOnce(okGemini);
    expect(await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).toBe('สำเร็จ');
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([2000, 4000]);
  });

  test('503 ตลอด → เรียก 3 ครั้ง backoff 2 ครั้ง แล้ว throw (status 503)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonRes(503, {}));
    const err = await openaiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(err.status).toBe(503);
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  test('429 ก็ backoff เหมือน 503', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(jsonRes(429, {})).mockResolvedValueOnce(okGemini);
    await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' });
    expect(sleepSpy.mock.calls.map((c) => c[0])).toEqual([2000]);
  });

  test('error อื่น (403) retry ทันทีเหมือนเดิม ไม่ backoff', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonRes(403, {}));
    await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch(() => {});
    expect(global.fetch).toHaveBeenCalledTimes(3);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('maxAttempts:1 (ปุ่มทดสอบการเชื่อมต่อ) → ไม่ retry ไม่ backoff', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonRes(503, {}));
    await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u', maxAttempts: 1 }).catch(() => {});
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('timeout ยังไม่ retry และไม่ backoff (พฤติกรรมจากรอบก่อน)', async () => {
    process.env.AI_TIMEOUT_MS = '40';
    global.fetch = jest.fn((url, opts) => hangUntilAborted(opts.signal));
    const err = await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    expect(err.isTimeout).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
    delete process.env.AI_TIMEOUT_MS;
  });

  test('backoffMs: base×2^(n-1) และ env AI_RETRY_BASE_MS override ได้', () => {
    expect([1, 2, 3].map(retry.backoffMs)).toEqual([2000, 4000, 8000]);
    process.env.AI_RETRY_BASE_MS = '500';
    expect([1, 2].map(retry.backoffMs)).toEqual([500, 1000]);
    process.env.AI_RETRY_BASE_MS = 'abc';
    expect(retry.backoffMs(1)).toBe(2000);
  });
});

describe('diagnostics: log ข้อมูล 503/429 แบบปลอดภัย', () => {
  beforeEach(() => {
    resetEnv();
    process.env.AI_RETRY_BASE_MS = '1';
    process.env.GEMINI_API_KEY = 'AIzaSyFAKE-KEY-1234567890';
    process.env.OPENAI_API_KEY = 'sk-proj-FAKEKEY1234567890';
    logger.warn.mockClear(); logger.error.mockClear();
  });

  test('Gemini 503: log มี status, retry-after, code (UNAVAILABLE) และ message สั้น — ไม่มี body ดิบ', async () => {
    const body = { error: { code: 503, status: 'UNAVAILABLE', message: 'The model is overloaded. Please try again later.', details: [{ secret: 'LEAK-ME' }] } };
    global.fetch = jest.fn().mockResolvedValue(jsonRes(503, body, { 'retry-after': '30' }));
    await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch(() => {});
    const lines = allLogs();
    expect(lines).toContain('retry-after=30');
    expect(lines).toContain('code=UNAVAILABLE');
    expect(lines).toContain('msg="The model is overloaded. Please try again later."');
    expect(lines).toContain('attempt 1/3');
    expect(lines).toContain('ล้มเหลวทั้ง 3 ครั้ง');
    expect(lines).not.toContain('LEAK-ME'); // field นอก allowlist ไม่ถูก log
  });

  test('ข้อความ 429 ที่มี API key/รูปแบบ key ปนอยู่ ถูก redact', async () => {
    const msg = 'quota for key=AIzaSyFAKE-KEY-1234567890 exceeded; also sk-proj-FAKEKEY1234567890 and Bearer abc.def.ghi';
    global.fetch = jest.fn().mockResolvedValue(jsonRes(429, { error: { status: 'RESOURCE_EXHAUSTED', message: msg } }));
    await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch(() => {});
    const lines = allLogs();
    expect(lines).toContain('code=RESOURCE_EXHAUSTED');
    expect(lines).not.toMatch(/AIzaSyFAKE|sk-proj-FAKE|abc\.def\.ghi/);
  });

  test('OpenAI 401 ที่สะท้อน key ใน message: ไม่ log message ของ 4xx (log แค่ code)', async () => {
    const body = { error: { message: 'Incorrect API key provided: sk-proj-FAKEKEY1234567890.', type: 'invalid_request_error', code: 'invalid_api_key' } };
    global.fetch = jest.fn().mockResolvedValue(jsonRes(401, body));
    const err = await openaiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch((e) => e);
    const lines = allLogs();
    expect(lines).toContain('code=invalid_api_key');
    expect(lines).not.toMatch(/sk-proj-FAKE|Incorrect API key/);
    expect(err.message).not.toMatch(/sk-proj|Incorrect/); // ไม่มี body ใน Error เหมือนเดิม
  });

  test('retry-after / code ที่รูปแบบผิดปกติ ถูกทิ้ง (allowlist)', async () => {
    global.fetch = jest.fn().mockResolvedValue(jsonRes(503, { error: { status: 'BAD CODE WITH SPACES; rm -rf', message: 'x' } }, { 'retry-after': 'a<script>b' }));
    await geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch(() => {});
    const lines = allLogs();
    expect(lines).not.toContain('retry-after=');
    expect(lines).not.toContain('code=');
  });

  test('Claude SDK error 503: สกัด diag จาก status/headers/error ของ SDK และ retry 3 ครั้ง', async () => {
    const sdkErr = Object.assign(new Error('503 overloaded'), { status: 503, headers: { 'retry-after': '7' }, error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } } });
    mockCreate.mockReset();
    mockCreate.mockRejectedValue(sdkErr);
    process.env.ANTHROPIC_API_KEY = 'ak-test';
    await claudeProvider.complete({ systemPrompt: 's', userPrompt: 'u' }).catch(() => {});
    const lines = allLogs();
    expect(lines).toContain('retry-after=7');
    expect(lines).toContain('code=overloaded_error');
    expect(mockCreate).toHaveBeenCalledTimes(3);
  });
});
