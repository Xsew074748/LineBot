'use strict';
// เรียก OpenAI API ผ่าน REST (fetch) ตรงๆ ไม่ลง SDK ใหม่
const logger = require('../logger');
const { timeoutGuard } = require('./timeout');
const { httpFailureDiag } = require('./diagnostics');
const { withRetry, DEFAULT_MAX_ATTEMPTS } = require('./retry');

const MODEL = 'gpt-4o';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userPrompt, maxTokens, apiKey = process.env.OPENAI_API_KEY || '') {
  const guard = timeoutGuard('OpenAI');
  try {
    const res = await fetch(ENDPOINT, {
      signal: guard.signal,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        max_tokens: maxTokens,
      }),
    });

    if (!res.ok) {
      // ห้ามใส่ response body ใน Error — provider อาจสะท้อน API key กลับมา แล้ว logger จะเขียนลงไฟล์ log
      // diag = ข้อมูลวินิจฉัยที่กรองแล้ว ใช้ log เท่านั้น ไม่อยู่ใน message (OpenAI สะท้อน key ในข้อความ 4xx จึงไม่ log message ของ 4xx)
      throw Object.assign(new Error(`OpenAI API error (status ${res.status})`), {
        status: res.status,
        diag: await httpFailureDiag(res, apiKey),
      });
    }

    const data = await res.json();
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error('OpenAI API: ไม่มีคำตอบใน response');

    return {
      text: text.trim(),
      inputTokens:  data.usage?.prompt_tokens     || 0,
      outputTokens: data.usage?.completion_tokens || 0,
    };
  } catch (err) {
    throw guard.wrap(err);
  } finally {
    guard.done();
  }
}

// retry + backoff: ดู retry.js (3 attempt, รอ 2s/4s เมื่อเจอ 503/429) — ล้มเหลวครบ → throw ให้ caller จัดการ
// apiKey/maxAttempts: ใช้ตอนทดสอบ key ที่ยังไม่บันทึก — ไม่ส่ง = ใช้ env + retry ตามค่า default
async function complete({ systemPrompt, userPrompt, maxTokens = 500, apiKey, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const start = Date.now();
  return withRetry({
    provider: 'openai', label: 'OpenAI API', maxAttempts, logger,
    attemptFn: async () => {
      const { text, inputTokens, outputTokens } = await callOpenAI(systemPrompt, userPrompt, maxTokens, apiKey || undefined);
      logger.aiCall('openai.complete', inputTokens, outputTokens, Date.now() - start);
      return text;
    },
  });
}

module.exports = { complete };
