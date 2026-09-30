'use strict';
// เรียก OpenAI API ผ่าน REST (fetch) ตรงๆ ไม่ลง SDK ใหม่
const logger = require('../logger');

const MODEL = 'gpt-4o';
const ENDPOINT = 'https://api.openai.com/v1/chat/completions';

async function callOpenAI(systemPrompt, userPrompt, maxTokens, apiKey = process.env.OPENAI_API_KEY || '') {
  const res = await fetch(ENDPOINT, {
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
    throw Object.assign(new Error(`OpenAI API error (status ${res.status})`), { status: res.status });
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content;
  if (!text) throw new Error('OpenAI API: ไม่มีคำตอบใน response');

  return {
    text: text.trim(),
    inputTokens:  data.usage?.prompt_tokens     || 0,
    outputTokens: data.usage?.completion_tokens || 0,
  };
}

// retry 1 ครั้งเหมือน claude.js — ล้มเหลวทั้ง 2 ครั้ง → throw ให้ caller จัดการ
// apiKey/maxAttempts: ใช้ตอนทดสอบ key ที่ยังไม่บันทึก — ไม่ส่ง = ใช้ env + retry 1 ครั้ง
async function complete({ systemPrompt, userPrompt, maxTokens = 500, apiKey, maxAttempts = 2 }) {
  const start = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { text, inputTokens, outputTokens } = await callOpenAI(systemPrompt, userPrompt, maxTokens, apiKey || undefined);
      logger.aiCall('openai.complete', inputTokens, outputTokens, Date.now() - start);
      return text;
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.warn(`ai-providers/openai: attempt 1 ล้มเหลว: ${err.message} — กำลัง retry`);
        continue;
      }
      logger.error('ai-providers/openai: OpenAI API ล้มเหลวทั้ง 2 ครั้ง', err);
      throw err;
    }
  }
}

module.exports = { complete };
