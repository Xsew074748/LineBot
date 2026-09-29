'use strict';
require('dotenv').config();
const { getProvider } = require('./ai-providers');

// ── System prompts ────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `คุณเป็น IT System Administrator ผู้เชี่ยวชาญด้าน Network Monitoring
สำหรับองค์กรในประเทศไทย ที่มีความรู้เรื่อง Zabbix, TP-Link Omada, HikCentral และ Network Infrastructure

กฎการตอบ:
- ตอบเป็นภาษาไทยเสมอ กระชับ ชัดเจน ไม่เกิน 5 ประโยค
- ระบุปัญหาเร่งด่วนก่อนเสมอ
- ให้ขั้นตอนแก้ไขที่ปฏิบัติได้จริง
- ใช้ emoji เพื่อให้อ่านง่าย
- หากไม่มีข้อมูลเพียงพอให้บอกตรงๆ`;

// System prompt พร้อม guardrails สำหรับ Cross-System Correlation
// ออกแบบมาเพื่อป้องกัน hallucination — บังคับให้อ้างอิงจากข้อมูลเท่านั้น
const CORRELATION_SYSTEM_PROMPT = `คุณคือผู้ช่วยวิเคราะห์ปัญหาเครือข่ายสำหรับทีม IT

กฎเหล็ก:
1. วิเคราะห์จากข้อมูลที่ให้มาเท่านั้น ห้ามสมมติอุปกรณ์หรือเหตุการณ์ที่ไม่มีในข้อมูล
2. ถ้าข้อมูลไม่พอสรุป ให้ตอบว่า "ข้อมูลไม่เพียงพอต่อการวิเคราะห์ ต้องการข้อมูลเพิ่มเติม: ..." ห้ามเดา
3. เมื่อชี้สาเหตุ ให้บอกระดับความมั่นใจ (น่าจะ/อาจจะ/ไม่แน่ใจ) และอ้างอิงว่าดูจากข้อมูลอะไร
4. ปิดท้ายทุกครั้งด้วย: "⚠️ นี่คือการวิเคราะห์เบื้องต้นโดย AI โปรดตรวจสอบหน้างานก่อนดำเนินการ"`;

// ── Internal: เรียก AI ผ่าน provider ที่เลือกไว้ (claude/gemini/openai) ────────
// retry logic (1 ครั้ง) อยู่ในตัว provider adapter เองแล้ว (services/ai-providers/*.js)
// ล้มเหลว → throw ให้ caller จัดการ (withAI ใน index.js จะไม่หัก quota)
async function callAI(systemPrompt, userPrompt, maxTokens = 500) {
  const { module: provider } = getProvider();
  return provider.complete({ systemPrompt, userPrompt, maxTokens });
}

// ── Public API ─────────────────────────────────────────────────────────────────

async function ask(userPrompt, maxTokens = 500) {
  return callAI(SYSTEM_PROMPT, userPrompt, maxTokens);
}

// ── วิเคราะห์ Alert: สาเหตุ ผลกระทบ วิธีแก้ไข วิธีป้องกัน ───────────────────
async function analyzeAlert(alertData) {
  const prompt = `วิเคราะห์ Alert นี้:
ชื่อ: ${alertData.description}
Host: ${alertData.host}
Priority: ${alertData.priorityLabel}
เวลา: ${alertData.lastChange}
${alertData.comments ? `หมายเหตุ: ${alertData.comments}` : ''}

กรุณาวิเคราะห์:
1. สาเหตุที่เป็นไปได้
2. ผลกระทบต่อระบบ
3. วิธีแก้ไขทันที
4. วิธีป้องกันในอนาคต`;

  return ask(prompt, 600);
}

// ── ตอบคำถามทั่วไปโดยอิงข้อมูล context จาก Zabbix ────────────────────────────
async function chat(message, context = null, maxTokens = 500) {
  let prompt = message;
  if (context) {
    const ctxStr = typeof context === 'string'
      ? context
      : JSON.stringify(context, null, 2).slice(0, 1000);
    prompt = `ข้อมูลระบบปัจจุบัน:\n${ctxStr}\n\nคำถาม: ${message}`;
  }
  return ask(prompt, maxTokens);
}

// ── สรุปภาพรวมระบบทั้งหมด ────────────────────────────────────────────────────
async function summarize(allData) {
  const lines = [];

  if (allData.zabbix) {
    const z = allData.zabbix;
    lines.push(`Zabbix: Alert ${z.problems?.length || 0} รายการ, Host ทั้งหมด ${z.hosts?.length || 0}`);
    const critical = (z.problems || []).filter((p) => p.priority >= 4);
    if (critical.length) {
      lines.push(`Alert วิกฤต/สูง: ${critical.map((p) => p.description).slice(0, 3).join(', ')}`);
    }
  }

  if (allData.omada) {
    const o = allData.omada;
    lines.push(`Omada: AP ${o.aps?.length || 0} เครื่อง, Client ${o.clients?.total || 0} คน`);
  }

  if (allData.hik) {
    const h = allData.hik;
    const offline = (h.cameras || []).filter((c) => !c.online).length;
    lines.push(`HikCentral: กล้อง ${h.cameras?.length || 0} ตัว (ดับ ${offline} ตัว)`);
  }

  const prompt = `สรุปสถานะระบบ IT ขององค์กร:\n${lines.join('\n')}\n\nกรุณาสรุปสถานการณ์และระบุสิ่งที่ต้องดำเนินการทันที`;
  return ask(prompt, 600);
}

// ── วิเคราะห์ Cross-System Correlation ────────────────────────────────────────
// เรียกแบบ on-demand เท่านั้น (กดปุ่มวิเคราะห์) ไม่เรียกอัตโนมัติ
// ใช้ system prompt พร้อม guardrails ป้องกัน hallucination
async function analyzeCorrelation(group) {
  const typeList    = group.types.join(', ');
  const deviceLines = group.devices.slice(0, 10)
    .map((d) => `- ${d.device} (ประเภท: ${d.type}, ระบบ: ${d.source})`)
    .join('\n');
  const timeStr = new Date(group.startTime * 1000).toLocaleString('th-TH');
  const more    = group.devices.length > 10
    ? `\n... และอีก ${group.devices.length - 10} รายการ` : '';

  const prompt = `ข้อมูลความผิดปกติแบบกลุ่ม:
โซน: ${group.zone}
เวลาเริ่ม: ${timeStr}
ประเภทอุปกรณ์: ${typeList}
ความมั่นใจของระบบ: ${group.confidence}${group.hasInfraDevice ? ' (มีอุปกรณ์โครงสร้าง switch/host)' : ''}
จำนวนอุปกรณ์: ${group.devices.length}

รายการอุปกรณ์:
${deviceLines}${more}

กรุณาวิเคราะห์:
1. สาเหตุที่น่าจะเป็น
2. สิ่งที่ต้องตรวจสอบทันที
3. ขั้นตอนแก้ไข`;

  return callAI(CORRELATION_SYSTEM_PROMPT, prompt, 600);
}

module.exports = { analyzeAlert, chat, summarize, analyzeCorrelation };
