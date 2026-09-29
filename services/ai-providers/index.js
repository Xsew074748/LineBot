'use strict';
// Factory: เลือก AI provider ตาม AI_PROVIDER env + fallback logic
const logger = require('../logger');
const claudeProvider = require('./claude');
const geminiProvider = require('./gemini');
const openaiProvider = require('./openai');

// เลือก provider ที่จะใช้จริง (หลัง fallback แล้ว) — เรียกทุกครั้งที่ต้องใช้ AI
// ไม่ cache เพราะ env ไม่เปลี่ยนระหว่าง process อยู่แล้ว การเรียกซ้ำถูกมาก
function getProvider() {
  const requested = (process.env.AI_PROVIDER || 'claude').toLowerCase();
  const keyMap = {
    claude: process.env.ANTHROPIC_API_KEY,
    gemini: process.env.GEMINI_API_KEY,
    openai: process.env.OPENAI_API_KEY,
  };

  if (requested !== 'claude' && !keyMap[requested]) {
    logger.warn(`AI_PROVIDER=${requested} แต่ไม่มี API key — fallback ไปใช้ claude`);
    return { name: 'claude', module: claudeProvider };
  }

  if (!keyMap[requested]) {
    throw new Error('ไม่มี ANTHROPIC_API_KEY — AI จะใช้งานไม่ได้เลย');
  }

  const map = { claude: claudeProvider, gemini: geminiProvider, openai: openaiProvider };
  return { name: requested, module: map[requested] || claudeProvider };
}

module.exports = { getProvider };
