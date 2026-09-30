'use strict';
// ครอบ Anthropic SDK — ย้าย logic จาก services/ai.js เดิมมาทั้งหมด (callClaude + retry 1 ครั้ง)
// ไม่ได้เขียนใหม่ แค่เปลี่ยน signature ให้ตรงกับ interface กลาง (base.js)
const Anthropic = require('@anthropic-ai/sdk');
const logger = require('../logger');
const { timeoutGuard } = require('./timeout');
const { formatDiag } = require('./diagnostics');
const { withRetry, DEFAULT_MAX_ATTEMPTS } = require('./retry');

const MODEL = 'claude-haiku-4-5';

let client = null;
function getClient() {
  if (!client) client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  return client;
}

// retry + backoff: ดู retry.js (3 attempt, รอ 2s/4s เมื่อเจอ 503/429) — ล้มเหลวครบ → throw ให้ caller จัดการ
// apiKey/maxAttempts: ใช้ตอนทดสอบ key ที่ยังไม่บันทึก (services/connection-test.js) — ไม่ส่ง = ใช้ env + retry ตามค่า default
async function complete({ systemPrompt, userPrompt, maxTokens = 500, apiKey, maxAttempts = DEFAULT_MAX_ATTEMPTS }) {
  const start = Date.now();
  const anthropic = apiKey ? new Anthropic({ apiKey, maxRetries: 0 }) : getClient();
  return withRetry({
    provider: 'claude', label: 'Claude API', maxAttempts, logger,
    attemptFn: async () => {
      const guard = timeoutGuard('Claude');
      try {
        const msg = await anthropic.messages.create({
          model:      MODEL,
          max_tokens: maxTokens,
          system:     systemPrompt,
          messages:   [{ role: 'user', content: userPrompt }],
        }, { signal: guard.signal });

        const inputT  = msg.usage?.input_tokens  || 0;
        const outputT = msg.usage?.output_tokens || 0;
        logger.aiCall('claude.complete', inputT, outputT, Date.now() - start);

        return msg.content[0]?.text?.trim() || '(ไม่มีคำตอบ)';
      } catch (rawErr) {
        const err = guard.wrap(rawErr);
        // SDK error: status/headers/error อยู่บนตัว error เอง — สกัดเฉพาะ field ที่ปลอดภัยไว้ใน diag
        if (!err.isTimeout && err.status && !err.diag) {
          err.diag = formatDiag({
            status: err.status,
            retryAfter: err.headers && (typeof err.headers.get === 'function' ? err.headers.get('retry-after') : err.headers['retry-after']),
            errObj: err.error && err.error.error,
            apiKey: apiKey || process.env.ANTHROPIC_API_KEY,
          });
        }
        throw err;
      } finally {
        guard.done();
      }
    },
  });
}

module.exports = { complete };
