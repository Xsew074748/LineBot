'use strict';
// สแกนซอร์สหาจุดที่เรียก logger.<level>(...) แล้วส่งข้อมูล error "ดิบ" เข้าไป
//  (ก) rawErrorArg  — ส่ง error object ตรงๆ เป็นอาร์กิวเมนต์ (logger.error จะพิมพ์ err.stack ซึ่งมีข้อความ error เดิม เช่น connect ECONNREFUSED <IP>:พอร์ต)
//  (ข) messageInterp — เอา err.message / err.stack / ${err} ไปต่อในข้อความ log
// ใช้ทั้งในเทสต์ guard และนับก่อน/หลังแก้ (ไม่ใช่โค้ด production)

const fs = require('fs');
const path = require('path');

const LEVELS = 'error|warn|info|debug';
const CALL_RE = new RegExp(`\\blogger\\.(${LEVELS})\\s*\\(`, 'g');
const ERR_NAME = '(?:err|error|e|ex|\\w*Err|\\w*Error)';
const BARE_ERR = new RegExp(`^${ERR_NAME}$`);
const MSG_RE = new RegExp(`\\b${ERR_NAME}\\s*(?:&&\\s*${ERR_NAME}\\s*)?\\??\\.(?:message|stack)\\b`);
const STRINGIFY_RE = new RegExp('\\$\\{\\s*' + ERR_NAME + '\\s*\\}');

// อ่านอาร์กิวเมนต์ของการเรียกที่เริ่มหลังวงเล็บเปิดที่ตำแหน่ง start; คืน { args, end }
function readArgs(src, start) {
  const args = [];
  let depth = 0;
  let cur = '';
  let i = start;
  const stack = []; // 'tpl' เมื่ออยู่ใน template literal ที่เปิด ${ ไว้
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2); i = i < 0 ? src.length : i + 2; continue; }
    if (c === '\'' || c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      cur += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '`') {
      let j = i + 1; let d = 0;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (d === 0 && src[j] === '`') break;
        if (src[j] === '$' && src[j + 1] === '{') { d++; j += 2; continue; }
        if (d > 0 && src[j] === '{') d++;
        if (d > 0 && src[j] === '}') d--;
        j++;
      }
      cur += src.slice(i, j + 1); i = j + 1; continue;
    }
    if (c === '(' || c === '[' || c === '{') depth++;
    if (c === ')' || c === ']' || c === '}') {
      if (depth === 0 && c === ')') { args.push(cur.trim()); return { args, end: i }; }
      depth--;
    }
    if (c === ',' && depth === 0) { args.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  return { args, end: i };
}

function scanSource(src) {
  const hits = [];
  CALL_RE.lastIndex = 0;
  let m;
  while ((m = CALL_RE.exec(src))) {
    const { args } = readArgs(src, CALL_RE.lastIndex);
    const line = src.slice(0, m.index).split('\n').length;
    const rawErrorArg = args.some((a) => BARE_ERR.test(a));
    const messageInterp = args.some((a) => MSG_RE.test(a) || STRINGIFY_RE.test(a));
    hits.push({ level: m[1], line, rawErrorArg, messageInterp, text: args.join(', ').replace(/\s+/g, ' ').slice(0, 110) });
  }
  return hits;
}

function listJs(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) { if (ent.name !== 'node_modules') listJs(p, out); } else if (ent.name.endsWith('.js')) out.push(p);
  }
  return out;
}

// ไฟล์ production ที่ต้องคุม (ไม่รวม tests/scripts/mock-*)
function productionFiles(root) {
  const files = [path.join(root, 'index.js')];
  for (const d of ['services', 'adapters', 'routes', 'middleware']) {
    const dir = path.join(root, d);
    if (fs.existsSync(dir)) listJs(dir, files);
  }
  return files.filter((f) => fs.existsSync(f));
}

function scanProject(root) {
  const found = [];
  for (const f of productionFiles(root)) {
    const rel = path.relative(root, f).split(path.sep).join('/');
    for (const h of scanSource(fs.readFileSync(f, 'utf8'))) found.push({ file: rel, ...h });
  }
  return found;
}

module.exports = { scanSource, scanProject, productionFiles };
