'use strict';
// เรียก Gemini API ผ่าน REST (fetch) ตรงๆ ไม่ลง SDK ใหม่
// shape ของ request/response ตรวจสอบจาก Google AI documentation แล้ว (ai.google.dev/api/generate-content)
const logger = require('../logger');

// gemini-2.5-flash ถูกจำกัดสิทธิ์ใหม่โดย Google (ตอบ 404 แม้ ListModels จะยังเห็นชื่อรุ่นอยู่)
// เปลี่ยนเป็นรุ่นปัจจุบันที่ยังใช้งานได้ และให้ override ผ่าน env ได้เผื่อ Google เปลี่ยนชื่อรุ่นอีกในอนาคต
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.8-flash';
const ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

async function callGemini(systemPrompt, userPrompt, maxTokens, apiKey = process.env.GEMINI_API_KEY || '') {
  const url = `${ENDPOINT}?key=${encodeURIComponent(apiKey)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: systemPrompt }] },
      contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
      // gemini-3.x/2.5 เป็น "thinking model" — ถ้าไม่ปิด จะกิน maxOutputTokens ไปกับ reasoning
      // จนไม่เหลือ token สำหรับคำตอบจริง (โดยเฉพาะตอน maxTokens น้อยๆ ตอนทดสอบการเชื่อมต่อ)
      // thinkingBudget:0 เป็นพารามิเตอร์ที่ Google เอกสารไว้สำหรับตระกูล Flash — รุ่นที่ปิดไม่ได้จะเมินฟิลด์นี้เฉยๆ ไม่ error
      generationConfig: { maxOutputTokens: maxTokens, thinkingConfig: { thinkingBudget: 0 } },
    }),
  });

  if (!res.ok) {
    // ห้ามใส่ response body ใน Error — provider อาจสะท้อน API key กลับมา แล้ว logger จะเขียนลงไฟล์ log
    throw Object.assign(new Error(`Gemini API error (status ${res.status}, model ${MODEL})`), { status: res.status });
  }

  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!text) {
    const finishReason = data.candidates?.[0]?.finishReason || 'unknown';
    // MAX_TOKENS = โดน reasoning/thinking token กินโควตาจนไม่เหลือคำตอบ — บอกสาเหตุนี้ตรงๆ เพื่อ debug ง่ายขึ้น
    throw new Error(`Gemini API: ไม่มีคำตอบใน response (finishReason: ${finishReason}, model ${MODEL})`);
  }

  return {
    text: text.trim(),
    inputTokens:  data.usageMetadata?.promptTokenCount     || 0,
    outputTokens: data.usageMetadata?.candidatesTokenCount || 0,
  };
}

// retry 1 ครั้งเหมือน claude.js — ล้มเหลวทั้ง 2 ครั้ง → throw ให้ caller จัดการ
// apiKey/maxAttempts: ใช้ตอนทดสอบ key ที่ยังไม่บันทึก — ไม่ส่ง = ใช้ env + retry 1 ครั้ง
async function complete({ systemPrompt, userPrompt, maxTokens = 500, apiKey, maxAttempts = 2 }) {
  const start = Date.now();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const { text, inputTokens, outputTokens } = await callGemini(systemPrompt, userPrompt, maxTokens, apiKey || undefined);
      logger.aiCall('gemini.complete', inputTokens, outputTokens, Date.now() - start);
      return text;
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.warn(`ai-providers/gemini: attempt 1 ล้มเหลว: ${err.message} — กำลัง retry`);
        continue;
      }
      logger.error('ai-providers/gemini: Gemini API ล้มเหลวทั้ง 2 ครั้ง', err);
      throw err;
    }
  }
}

module.exports = { complete, MODEL };
