'use strict';
// สร้าง prompt ที่ "บอทจริงจะส่งให้ AI" จาก input ของ scenario — ไม่เรียก AI ใดๆ และไม่ import โค้ด bot
// (index.js เริ่มเซิร์ฟเวอร์ตอน require จึง import ไม่ได้) จึงคัดลอก template มาไว้ที่นี่
// และมี drift check ใน validate.js ตรวจว่าข้อความ template ยังตรงกับซอร์สจริงของบอท
//
//   node ai-comparison/tools/render-prompt.js NET-01        → พิมพ์ system prompt / user prompt / max tokens
//
// template อ้างอิงจาก commit 6c3b5bb: services/ai.js (SYSTEM_PROMPT, analyzeAlert, analyzeCorrelation)
// และ index.js (handleAnalyze, ai.chat ของคำสั่ง "วิเคราะห์ ...")

const SYSTEM_PROMPT = `คุณเป็น IT System Administrator ผู้เชี่ยวชาญด้าน Network Monitoring
สำหรับองค์กรในประเทศไทย ที่มีความรู้เรื่อง Zabbix, TP-Link Omada, HikCentral และ Network Infrastructure

กฎการตอบ:
- ตอบเป็นภาษาไทยเสมอ กระชับ ชัดเจน ไม่เกิน 5 ประโยค
- ระบุปัญหาเร่งด่วนก่อนเสมอ
- ให้ขั้นตอนแก้ไขที่ปฏิบัติได้จริง
- ใช้ emoji เพื่อให้อ่านง่าย
- หากไม่มีข้อมูลเพียงพอให้บอกตรงๆ`;

const CORRELATION_SYSTEM_PROMPT = `คุณคือผู้ช่วยวิเคราะห์ปัญหาเครือข่ายสำหรับทีม IT

กฎเหล็ก:
1. วิเคราะห์จากข้อมูลที่ให้มาเท่านั้น ห้ามสมมติอุปกรณ์หรือเหตุการณ์ที่ไม่มีในข้อมูล
2. ถ้าข้อมูลไม่พอสรุป ให้ตอบว่า "ข้อมูลไม่เพียงพอต่อการวิเคราะห์ ต้องการข้อมูลเพิ่มเติม: ..." ห้ามเดา
3. เมื่อชี้สาเหตุ ให้บอกระดับความมั่นใจ (น่าจะ/อาจจะ/ไม่แน่ใจ) และอ้างอิงว่าดูจากข้อมูลอะไร
4. ปิดท้ายทุกครั้งด้วย: "⚠️ นี่คือการวิเคราะห์เบื้องต้นโดย AI โปรดตรวจสอบหน้างานก่อนดำเนินการ"`;

// chat(prompt) ของคำสั่ง "วิเคราะห์ host/wifi/กล้อง/summary" — ข้อความนำหน้า context
const CONTEXT_TEXT_PROMPTS = {
  host:    (ctx) => `วิเคราะห์สถานะ Host ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:\n${ctx}`,
  wifi:    (ctx) => `วิเคราะห์สถานะ WiFi AP ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:\n${ctx}`,
  camera:  (ctx) => `วิเคราะห์ปัญหากล้อง CCTV ต่อไปนี้ บอกสาเหตุที่เป็นไปได้ วิธีแก้ไข และวิธีป้องกัน:\n${ctx}`,
  summary: (ctx) => `วิเคราะห์ภาพรวมระบบ IT ต่อไปนี้ บอกสถานการณ์ปัจจุบันและคำแนะนำ:\n${ctx}`,
};

// คืน { system, user, maxTokens, productionCall } ตาม prompt_kind
function renderPrompt(scenario) {
  const i = scenario.input;
  switch (scenario.prompt_kind) {
    case 'analyze_device': // ปุ่ม 🤖 วิเคราะห์ (postback analyze:{type}:{name}:{ip}) → ai.chat(prompt, null, 800)
      return {
        system: SYSTEM_PROMPT, maxTokens: 800, productionCall: "ai.chat(prompt, null, 800)  [handleAnalyze]",
        user: `คุณเป็น Network Engineer วิเคราะห์ปัญหาของ ${i.name} (${i.type})${i.ip ? ` IP ${i.ip}` : ''}
สถานะ: ${i.status}

ข้อมูลอุปกรณ์ในเครือข่ายเดียวกัน:
AP ที่เกี่ยวข้อง: ${i.apContext}
กล้องที่เกี่ยวข้อง: ${i.cameraContext}

วิเคราะห์สาเหตุและแนะนำการแก้ไขเป็นภาษาไทย
ถ้าหลายอุปกรณ์มีปัญหาพร้อมกัน ให้ระบุว่าน่าจะเป็นปัญหาระดับ network/switch`,
      };
    case 'camera_single': { // "วิเคราะห์กล้อง CAM-xxx" → ai.chat(prompt) (500)
      const ctx = `กล้อง ${i.name} ตำแหน่ง ${i.location || '-'} สถานะ ${i.status} ดับมา ${i.duration || '-'} ตั้งแต่ ${i.offlineSince || 'N/A'}`;
      return {
        system: SYSTEM_PROMPT, maxTokens: 500, productionCall: "ai.chat(prompt)  [วิเคราะห์กล้อง CAM-xxx]",
        user: `วิเคราะห์ปัญหากล้อง CCTV รายตัว บอกสาเหตุที่น่าจะเป็นและวิธีแก้ไข:\n${ctx}`,
      };
    }
    case 'alert': // ai.analyzeAlert(alertData) → 600
      return {
        system: SYSTEM_PROMPT, maxTokens: 600, productionCall: "ai.analyzeAlert(alert)",
        user: `วิเคราะห์ Alert นี้:
ชื่อ: ${i.description}
Host: ${i.host}
Priority: ${i.priorityLabel}
เวลา: ${i.lastChange}
${i.comments ? `หมายเหตุ: ${i.comments}` : ''}

กรุณาวิเคราะห์:
1. สาเหตุที่เป็นไปได้
2. ผลกระทบต่อระบบ
3. วิธีแก้ไขทันที
4. วิธีป้องกันในอนาคต`,
      };
    case 'correlation': { // ai.analyzeCorrelation(group) → 600 พร้อม CORRELATION_SYSTEM_PROMPT
      const g = i.group;
      const deviceLines = g.devices.slice(0, 10)
        .map((d) => `- ${d.device} (ประเภท: ${d.type}, ระบบ: ${d.source})`).join('\n');
      const more = g.devices.length > 10 ? `\n... และอีก ${g.devices.length - 10} รายการ` : '';
      return {
        system: CORRELATION_SYSTEM_PROMPT, maxTokens: 600, productionCall: "ai.analyzeCorrelation(group)",
        user: `ข้อมูลความผิดปกติแบบกลุ่ม:
โซน: ${g.zone}
เวลาเริ่ม: ${g.startTimeText}
ประเภทอุปกรณ์: ${g.types.join(', ')}
ความมั่นใจของระบบ: ${g.confidence}${g.hasInfraDevice ? ' (มีอุปกรณ์โครงสร้าง switch/host)' : ''}
จำนวนอุปกรณ์: ${g.devices.length}

รายการอุปกรณ์:
${deviceLines}${more}

กรุณาวิเคราะห์:
1. สาเหตุที่น่าจะเป็น
2. สิ่งที่ต้องตรวจสอบทันที
3. ขั้นตอนแก้ไข`,
      };
    }
    case 'context_text': // ai.chat(`วิเคราะห์ ... ต่อไปนี้:\n${ctx}`) → 500
      return {
        system: SYSTEM_PROMPT, maxTokens: 500, productionCall: `ai.chat(prompt)  [วิเคราะห์ ${i.topic}]`,
        user: CONTEXT_TEXT_PROMPTS[i.topic](i.context),
      };
    default:
      throw new Error(`prompt_kind ไม่รู้จัก: ${scenario.prompt_kind}`);
  }
}

module.exports = { renderPrompt, SYSTEM_PROMPT, CORRELATION_SYSTEM_PROMPT, CONTEXT_TEXT_PROMPTS };

// CLI: node render-prompt.js <ID>
if (require.main === module) {
  const { loadScenarios } = require('./load');
  const id = process.argv[2];
  const s = loadScenarios().find((x) => x.id === id);
  if (!s) { console.error(`ไม่พบเคส ${id || '(ไม่ได้ระบุ)'}`); process.exit(1); }
  const r = renderPrompt(s);
  console.log(`# ${s.id} — ${s.title}\n# ผู้เรียกในบอทจริง: ${r.productionCall} · max_tokens=${r.maxTokens}\n`);
  console.log('── SYSTEM PROMPT ──\n' + r.system + '\n\n── USER PROMPT ──\n' + r.user);
}
