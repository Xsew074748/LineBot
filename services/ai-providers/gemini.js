'use strict';
// เรียก Gemini API ผ่าน REST (fetch) ตรงๆ ไม่ลง SDK ใหม่
// shape ของ request/response ตรวจสอบจาก Google AI documentation แล้ว (ai.google.dev/api/generate-content)
const logger = require('../logger');

const MODEL = 'gemini-2.5-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function callGemini(systemPrompt, userPrompt, maxTokens) {
  const url = `${ENDPOINT}?key=${encodeURIComponent(process.env.GEMINI_API_KEY || '')}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Gemini API ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) throw new Error('Gemini API: ไม่มีคำตอบใน response');

  return {
    text: text.trim(),
    inputTokens:  data.usageMetadata?.promptTokenCount     || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
  };
}

// retry 1 ครั้งเหมือน claude.js — ล้มเหลวทั้ง 2 ครั้ง → throw ให้ caller จัดการ
async function complete({ systemPrompt, userPrompt, maxTokens = 500 }) {
  const start = Date.now();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const { text, inputTokens, outputTokens } = await callGemini(systemPrompt, userPrompt, maxTokens);
      logger.aiCall('gemini.complete', inputTokens, outputTokens, Date.now() - start);
      return text;
    } catch (err) {
      if (attempt === 1) {
        logger.warn(`ai-providers/gemini: attempt 1 ล้มเหลว: ${err.message} — กำลัง retry`);
        continue;
      }
      logger.error('ai-providers/gemini: Gemini API ล้มเหลวทั้ง 2 ครั้ง', err);
      throw err;
    }
  }
}

module.exports = { complete };
