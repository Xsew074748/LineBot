'use strict';
// ครอบ Anthropic SDK — ย้าย logic จาก services/ai.js เดิมมาทั้งหมด (callClaude + retry 1 ครั้ง)
// ไม่ได้เขียนใหม่ แค่เปลี่ยน signature ให้ตรงกับ interface กลาง (base.js)
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../logger');

const MODEL = 'claude-haiku-4-5';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// ล้มเหลวทั้ง 2 ครั้ง → throw ให้ caller จัดการ (withAI จะไม่หัก quota)
// apiKey/maxAttempts: ใช้ตอนทดสอบ key ที่ยังไม่บันทึก (services/connection-test.js) — ไม่ส่ง = ใช้ env + retry 1 ครั้ง
async function complete({ systemPrompt, userPrompt, maxTokens = 500, apiKey, maxAttempts = 2 }) {
  const start = Date.now();
  const anthropic = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : getClient();
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const msg = await anthropic.messages.create({
        model:      MODEL,
        max_tokens: maxTokens,
        system:     systemPrompt,
        messages:   [{ role: 'user', content: userPrompt }],
      });

      const inputT  = msg.usage?.input_tokens  || 0;
      const outputT = msg.usage?.output_tokens || 0;
      logger.aiCall('claude.complete', inputT, outputT, Date.now() - start);

      return msg.content[0]?.text?.trim() || '(ไม่มีคำตอบ)';
    } catch (err) {
      if (attempt < maxAttempts) {
        logger.warn(`ai-providers/claude: attempt 1 ล้มเหลว: ${err.message} — กำลัง retry`);
        continue;
      }
      logger.error('ai-providers/claude: Claude API ล้มเหลวทั้ง 2 ครั้ง', err);
      throw err;
    }
  }
}

module.exports = { complete };
