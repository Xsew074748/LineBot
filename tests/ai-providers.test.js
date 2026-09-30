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
const geminiProvider = require('../services/ai-providers/gemini');
const openaiProvider = require('../services/ai-providers/openai');

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

  test('throw หลัง fail ครบ 2 ครั้ง', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'forbidden' });
    await expect(geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('throw เมื่อ response ไม่มี candidates/text (shape ผิดคาด)', async () => {
    process.env.GEMINI_API_KEY = 'gm-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ candidates: [] }) });
    await expect(geminiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow(/finishReason: unknown/);
    expect(global.fetch).toHaveBeenCalledTimes(2); // retry ด้วยเพราะถือเป็นความล้มเหลวเหมือนกัน
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

  test('throw หลัง fail ครบ 2 ครั้ง', async () => {
    process.env.OPENAI_API_KEY = 'oa-test';
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => 'unauthorized' });
    await expect(openaiProvider.complete({ systemPrompt: 's', userPrompt: 'u' })).rejects.toThrow();
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
    expect(global.fetch).toHaveBeenCalledTimes(2);
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
