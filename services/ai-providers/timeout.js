'use strict';
// timeout ร่วมของ AI provider ทั้ง 3 ตัว (claude/gemini/openai)
// เหตุผล: fetch/SDK ไม่มี timeout ในตัว — ถ้าผู้ให้บริการค้างไม่ตอบ (hang ไม่ใช่ error ทันที) งาน AI จะค้าง
// ไม่รู้จบ ทำให้ผู้ใช้ไม่ได้อะไรกลับเลยและล็อก in-flight ใน index.js ค้างจนกว่าจะ stale (3 นาที)
//
// ค่า timeout เป็นต่อ 1 attempt (ครอบทั้งรอ response และอ่าน body) — override ได้ด้วย env AI_TIMEOUT_MS
// อ่านค่าตอนเรียกทุกครั้ง (ไม่ cache ตอนโหลดโมดูล) เพื่อให้ตั้งค่าใหม่/ทดสอบได้โดยไม่ต้อง reload
const DEFAULT_AI_TIMEOUT_MS = 45_000;

function getTimeoutMs() {
  const n = parseInt(process.env.AI_TIMEOUT_MS || '', 10);
  return n > 0 ? n : DEFAULT_AI_TIMEOUT_MS;
}

// label = ชื่อ provider ใช้ในข้อความ error (เช่น "Gemini")
// ใช้: const g = timeoutGuard('Gemini'); try { await fetch(url, { signal: g.signal }) ... } catch (e) { throw g.wrap(e) } finally { g.done() }
function timeoutGuard(label) {
  const ms = getTimeoutMs();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return {
    signal: controller.signal,
    done: () => clearTimeout(timer),
    // ถ้าเกิดจาก abort ของเรา → error ที่ระบุชัดว่าหมดเวลา (isTimeout) แยกจาก error อื่น; ไม่ใช่ → คืน error เดิม
    wrap: (err) => (controller.signal.aborted
      ? Object.assign(new Error(`${label} API: หมดเวลารอการตอบกลับ (timeout ${ms}ms)`), { code: 'ETIMEDOUT', isTimeout: true })
      : err),
  };
}

module.exports = { timeoutGuard, getTimeoutMs, DEFAULT_AI_TIMEOUT_MS };
