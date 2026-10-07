'use strict';
// ตัดข้อมูลลับออกจากข้อความก่อนลง log / ส่ง LINE (เช่น ข้อความ error ตอน process ล้ม)
// ใช้รูปแบบกว้างๆ ไม่ผูกกับค่าที่อ่านจาก .env — ครอบ AppKey/AppSecret/StringToSign (Artemis สะท้อนกลับมาใน msg),
// LINE channel secret / access token, Bearer token, header x-health-token, LINE userId
// ข้อความธรรมดา (ไม่มีรูปแบบข้างบน) ต้องไม่ถูกแก้ — มีเทสต์คุม

// ชื่อ key ที่บ่งว่าค่าที่ตามมาเป็นความลับ (appKey, x-ca-key, x-health-token, channelSecret, accessToken, password ฯลฯ)
const KEY_WORDS = '[\\w-]*(?:secret|token|password|passwd|api[_-]?key|app[_-]?key|x-ca-key)[\\w-]*';

const RULES = [
  [/StringToSign:[\s\S]*?(?=, apiName|$)/gi, 'StringToSign:(ตัด)'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  // key: value / key=value / "key":"value" (รวม header)
  [new RegExp(`(["']?${KEY_WORDS}["']?\\s*[:=]\\s*["']?)[^\\s,;"'}\\]]+`, 'gi'), '$1[redacted]'],
  [/\bU[0-9a-f]{32}\b/g, 'U[redacted]'],                 // LINE userId
  [/\b[0-9a-f]{32,}\b/gi, '[redacted-hex]'],              // hex ยาว (channel secret ฯลฯ)
  // สตริงยาวแบบ token (base64/URL-safe) ต้องมีทั้งตัวเลขและตัวพิมพ์ใหญ่ — กัน path/ชื่อไฟล์ใน stack ถูกตัด
  [/(?=[A-Za-z0-9+/_=-]*\d)(?=[A-Za-z0-9+/_=-]*[A-Z])[A-Za-z0-9+/_=-]{40,}/g, '[redacted-token]'],
];

function redact(text) {
  let out = String(text ?? '');
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

module.exports = redact;
module.exports.redact = redact;
