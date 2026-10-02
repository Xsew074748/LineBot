'use strict';
// ประกอบ context/prompt "แบบเดียวกับบอทจริง" โดยให้บอทดึงข้อมูลจาก mock-lab
//
// หลักการ (ให้ผลตรงกับ production ที่สุดโดยไม่ copy โค้ดตรรกะ):
//   1) ฟังก์ชันระดับบนสุดของ index.js (gatherAnalyzeContext, getCamerasWithCache, sameSubnet, buildCameraAnalysisContext ฯลฯ)
//      ถูก "ตัดซอร์สออกมาด้วย AST แล้วรันใน sandbox" — ไม่ import index.js (เพราะ index.js เปิดเซิร์ฟเวอร์ตอน require) และไม่คัดลอกเอง
//   2) service/adapter/config/correlate/ai ของบอทถูก require จริง โดยชี้ env ไปที่ mock-lab
//   3) prompt จริงของ analyzeAlert/analyzeCorrelation/chat ได้จากการเรียก services/ai.js จริง
//      ผ่าน provider จำลองที่ "ดักจับ" prompt (ไม่ยิงเครือข่าย) แล้วค่อยส่ง prompt เดียวกันไปยัง 3 provider จริงทีหลัง
//   4) ส่วนที่ index.js เขียนแบบ inline ใน route (ข้อความ context ของ host/wifi/กล้อง/summary และ prompt ของปุ่มวิเคราะห์)
//      ต้องเขียนซ้ำที่นี่ — มี drift check (checkDrift) เทียบกับซอร์สจริงทุกครั้งที่รัน
const fs = require('fs');
const path = require('path');
const babel = require('@babel/parser');

const ROOT = path.join(__dirname, '..', '..');
// ตัด CR ออก: บน Windows (autocrlf) ไฟล์เป็น CRLF แต่ needle ของ drift check เขียนด้วย LF — ไม่งั้นล้มทุกครั้งที่ checkout ใหม่
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8').replace(/\r\n/g, '\n');

// ── 1) ตัดฟังก์ชัน/ค่าคงที่ระดับบนสุดจาก index.js ────────────────────────────────
function extractTopLevel(names) {
  const ast = babel.parse(INDEX_SRC, { sourceType: 'script', errorRecovery: false });
  const found = new Map();
  for (const node of ast.program.body) {
    if (node.type === 'FunctionDeclaration' && node.id) found.set(node.id.name, INDEX_SRC.slice(node.start, node.end));
    if (node.type === 'VariableDeclaration') {
      for (const d of node.declarations) if (d.id && d.id.name) found.set(d.id.name, INDEX_SRC.slice(node.start, node.end));
    }
  }
  const missing = names.filter((n) => !found.has(n));
  if (missing.length) throw new Error(`ไม่พบใน index.js: ${missing.join(', ')} — โครงสร้างบอทเปลี่ยน ต้องปรับ bot-context.js`);
  // คงลำดับตามที่ประกาศใน index.js (const ต้องมาก่อนที่ถูกใช้)
  return [...found.entries()].filter(([n]) => names.includes(n)).map(([, src]) => src);
}

const EXTRACTED = ['CAMERA_CACHE_TTL_MS', 'CAMERA_SITES', 'getCameraSite', 'isCamOnline', 'camIp', 'apHasIssue', 'sameSubnet',
  'cameraCache', 'getAllCameras', 'getCamerasWithCache', 'gatherAnalyzeContext', 'buildCameraAnalysisContext'];

// ── prompt ที่ index.js เขียน inline (ต้องตรงกับซอร์สจริง — ดู checkDrift) ─────────────
const INLINE = {
  analyzeDevice: ({ name, type, ip }, ctx) => `คุณเป็น Network Engineer วิเคราะห์ปัญหาของ ${name} (${type})${ip ? ` IP ${ip}` : ''}
สถานะ: ${ctx.status}

ข้อมูลอุปกรณ์ในเครือข่ายเดียวกัน:
AP ที่เกี่ยวข้อง: ${ctx.apContext}
กล้องที่เกี่ยวข้อง: ${ctx.cameraContext}

วิเคราะห์สาเหตุและแนะนำการแก้ไขเป็นภาษาไทย
ถ้าหลายอุปกรณ์มีปัญหาพร้อมกัน ให้ระบุว่าน่าจะเป็นปัญหาระดับ network/switch`,
  host:    (t) => `วิเคราะห์สถานะ Host ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:\n${t}`,
  wifi:    (t) => `วิเคราะห์สถานะ WiFi AP ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:\n${t}`,
  camera:  (t) => `วิเคราะห์ปัญหากล้อง CCTV ต่อไปนี้ บอกสาเหตุที่เป็นไปได้ วิธีแก้ไข และวิธีป้องกัน:\n${t}`,
  summary: (t) => `วิเคราะห์ภาพรวมระบบ IT ต่อไปนี้ บอกสถานการณ์ปัจจุบันและคำแนะนำ:\n${t}`,
};

const DRIFT_NEEDLES = [
  'คุณเป็น Network Engineer วิเคราะห์ปัญหาของ ${name} (${type})${ip ? ` IP ${ip}` : \'\'}', 'ai.chat(prompt, null, 800)',
  'ข้อมูลอุปกรณ์ในเครือข่ายเดียวกัน:\nAP ที่เกี่ยวข้อง: ${ctx.apContext}\nกล้องที่เกี่ยวข้อง: ${ctx.cameraContext}',
  'วิเคราะห์สถานะ Host ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:', 'วิเคราะห์สถานะ WiFi AP ต่อไปนี้ บอกสาเหตุที่เป็นไปได้และวิธีแก้ไข:',
  'วิเคราะห์ปัญหากล้อง CCTV ต่อไปนี้ บอกสาเหตุที่เป็นไปได้ วิธีแก้ไข และวิธีป้องกัน:', 'วิเคราะห์ภาพรวมระบบ IT ต่อไปนี้ บอกสถานการณ์ปัจจุบันและคำแนะนำ:',
  // สูตรข้อความ context (inline ใน route)
  '`Host ทั้งหมด ${hosts.length} เครื่อง ออนไลน์ ${hosts.filter((h) => h.available === 1).length} ออฟไลน์ ${hostOffline.length}`',
  '`: ${hostOffline.slice(0, 10).map((h) => h.name).join(\', \')}`',
  '`อุปกรณ์เครือข่าย: AP ${aps.length}, Switch ${switches.length}, Gateway ${gateways.length}`',
  '` — ปกติ ${devices.length - wifiOffline.length} มีปัญหา ${wifiOffline.length}`',
  '`: ${wifiOffline.slice(0, 10).map((d) => `${d.name}(${d.type})`).join(\', \')}`',
  '`กล้องทั้งหมด ${cameras.length} เครื่อง ปกติ ${cameras.length - cameraOffline.length} มีปัญหา ${cameraOffline.length}`',
  '`: ${cameraOffline.slice(0, 5).map((c) => c.name).join(\', \')}`',
  '`Zabbix: ${z.problems?.length || 0} alerts, ${z.hosts?.filter((h2) => h2.available === 1).length || 0}/${z.hosts?.length || 0} hosts online`',
  '`กล้อง: ${h.cameras.filter((c) => c.online).length}/${h.cameras.length} online`',
  '`WiFi: ${o.aps.length} APs, ${o.clients?.total || 0} clients`',
  "const highGroups = groups.filter((g) => g.confidence === 'high');",
  'const groups     = correlate(allProblems, config.CORRELATION_CONFIG);',
  'zabbix.pageOfflineCameras(reqPage, raw)', 'buildCameraAnalysisContext(data)',
];
function checkDrift() {
  return DRIFT_NEEDLES.filter((n) => !INDEX_SRC.includes(n));
}

// ── 2) โหลด service ของบอทให้ชี้ mock ─────────────────────────────────────────────
const SILENT_LOGGER = Object.fromEntries(['info', 'warn', 'error', 'apiCall', 'aiCall', 'audit', 'message'].map((k) => [k, () => {}]));

function purgeBotModules() {
  for (const k of Object.keys(require.cache)) {
    const rel = path.relative(ROOT, k);
    if (/^(services|adapters|middleware)[\\/]/.test(rel) || rel === 'config.js') delete require.cache[k];
  }
}

// ต้องชี้ไปที่ 127.0.0.1/localhost เท่านั้น — กันพลาดไปยิงอุปกรณ์จริง (dotenv ไม่ทับค่าที่ตั้งไว้แล้ว)
function assertLocal(env) {
  for (const k of ['ZABBIX_URL', 'OMADA_URL', 'HIKCENTRAL_URL']) {
    if (!/^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(env[k] || '')) throw new Error(`${k} ต้องชี้ไปที่ mock บนเครื่องนี้ (ได้ "${env[k]}")`);
  }
}

// สร้างชุด "บอทเสมือน" ต่อ 1 สถานการณ์ — เรียกใหม่ทุกเคสเพื่อล้าง cache ภายใน (region cache, token, cameraCache)
function loadBot(mockBase, mockCfg) {
  const env = {
    ZABBIX_URL: `${mockBase}/api_jsonrpc.php`, ZABBIX_API_TOKEN: mockCfg.zabbixToken,
    OMADA_URL: mockBase, OMADA_OMADAC_ID: mockCfg.omadacId, OMADA_SITE_ID: mockCfg.siteId, OMADA_CLIENT_ID: mockCfg.omadaClientId, OMADA_CLIENT_SECRET: mockCfg.omadaClientSecret,
    HIKCENTRAL_URL: mockBase, HIKCENTRAL_APP_KEY: mockCfg.hikAppKey, HIKCENTRAL_APP_SECRET: mockCfg.hikAppSecret,
    OMADA_ENABLED: 'true', HIKCENTRAL_ENABLED: 'true',
  };
  Object.assign(process.env, env);
  assertLocal(process.env);
  purgeBotModules();
  const loggerPath = require.resolve(path.join(ROOT, 'services', 'logger'));
  require.cache[loggerPath] = { id: loggerPath, filename: loggerPath, loaded: true, exports: SILENT_LOGGER };

  const zabbix = require(path.join(ROOT, 'services', 'zabbix'));
  const omada = require(path.join(ROOT, 'services', 'omada'));
  const hikcentral = require(path.join(ROOT, 'services', 'hikcentral'));

  // provider จำลอง: ดักจับ prompt ที่ services/ai.js ประกอบ (ไม่ยิงเครือข่าย)
  let captured = null;
  const aiProviders = require(path.join(ROOT, 'services', 'ai-providers'));
  aiProviders.getProvider = () => ({ name: 'capture', module: { complete: async (p) => { captured = p; return 'ok'; } } });
  const ai = require(path.join(ROOT, 'services', 'ai'));
  const capture = async (fn) => { captured = null; await fn(); if (!captured) throw new Error('ไม่ได้ prompt จาก services/ai.js'); return { system: captured.systemPrompt, user: captured.userPrompt, maxTokens: captured.maxTokens }; };

  // sandbox ของฟังก์ชันที่ตัดจาก index.js
  const src = extractTopLevel(EXTRACTED).join('\n');
  // cameraIdentity: getAllCameras ใน index.js เรียกผ่านโมดูลนี้ (dedup กล้องข้ามระบบ) — ต้องส่งเข้า sandbox ด้วย
  const cameraIdentity = require(path.join(ROOT, 'services', 'camera-identity'));
  const ext = new Function('omada', 'zabbix', 'hikcentral', 'logger', 'cameraIdentity', `${src}\nreturn { CAMERA_SITES, getCameraSite, isCamOnline, camIp, apHasIssue, sameSubnet, cameraCache, getAllCameras, getCamerasWithCache, gatherAnalyzeContext, buildCameraAnalysisContext };`)(omada, zabbix, hikcentral, SILENT_LOGGER, cameraIdentity);

  const config = require(path.join(ROOT, 'config'));
  const correlate = require(path.join(ROOT, 'services', 'correlate')).correlate || require(path.join(ROOT, 'services', 'correlate'));
  return { zabbix, omada, hikcentral, ai, capture, ext, config, correlate };
}

// ── 3) ประกอบ prompt ตามเส้นทางของบอท ────────────────────────────────────────────
// คืน { system, user, maxTokens, trace }  — trace = อธิบายว่าได้จากฟังก์ชันไหน (ใช้แสดงใน raw/review)
async function derive(bot, spec, state) {
  const { zabbix, omada, hikcentral, ai, capture, ext } = bot;
  const sel = spec.select || {};
  switch (spec.path) {
    case 'analyze_device': {
      const dev = state.get(sel.name);
      if (!dev) throw new Error(`select.name "${sel.name}" ไม่มีในสถานการณ์`);
      const ip = sel.ip !== undefined ? sel.ip : dev.ip;
      const ctx = await ext.gatherAnalyzeContext(sel.type, sel.name, ip);
      const prompt = INLINE.analyzeDevice({ name: sel.name, type: sel.type, ip }, ctx);
      const r = await capture(() => ai.chat(prompt, null, 800));
      return { ...r, trace: { via: 'index.js gatherAnalyzeContext + handleAnalyze prompt', context: ctx } };
    }
    case 'alert': {
      const problems = await zabbix.getProblems(200);
      const p = problems.find((x) => x.host === sel.host && (!sel.descriptionIncludes || x.description.includes(sel.descriptionIncludes)));
      if (!p) throw new Error(`ไม่พบ alert host=${sel.host} description~"${sel.descriptionIncludes}" (มี ${problems.map((x) => `${x.host}:${x.description}`).join(' | ')})`);
      const r = await capture(() => ai.analyzeAlert(p));
      return { ...r, trace: { via: 'zabbix.getProblems → ai.analyzeAlert', alert: p, otherAlerts: problems.length - 1 } };
    }
    case 'cross': {
      const adapters = bot.config.getAdapters();
      const results = await Promise.allSettled(adapters.map(({ adapter }) => adapter.getProblems()));
      const all = results.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
      const groups = bot.correlate(all, bot.config.CORRELATION_CONFIG);
      const high = groups.filter((g) => g.confidence === 'high');
      const pool = sel.include_medium ? groups : high;
      const g = pool[0];
      if (!g) throw new Error(`correlate() ไม่พบกลุ่ม${sel.include_medium ? '' : ' high-confidence'} (ปัญหาทั้งหมด ${all.length} รายการ; กลุ่ม ${groups.length})`);
      const r = await capture(() => ai.analyzeCorrelation(g));
      return { ...r, trace: { via: 'adapters.getProblems → correlate → ai.analyzeCorrelation', group: { zone: g.zone, types: g.types, confidence: g.confidence, devices: g.devices.map((d) => d.device), groupsTotal: groups.length, highGroups: high.length, bypassedHighFilter: !!sel.include_medium && g.confidence !== 'high' } } };
    }
    case 'camera_off': { // "กล้องดับ" แล้ว "วิเคราะห์กล้อง"
      const raw = await zabbix.fetchOfflineCamerasRaw();
      const data = zabbix.pageOfflineCameras(1, raw);
      const text = ext.buildCameraAnalysisContext(data);
      const r = await capture(() => ai.chat(INLINE.camera(text)));
      return { ...r, trace: { via: 'zabbix.fetchOfflineCamerasRaw → pageOfflineCameras → buildCameraAnalysisContext', context: text } };
    }
    case 'ctx_host': {
      const hosts = await zabbix.getHosts(50);
      const hostOffline = hosts.filter((h) => h.available !== 1);
      const text = `Host ทั้งหมด ${hosts.length} เครื่อง ออนไลน์ ${hosts.filter((h) => h.available === 1).length} ออฟไลน์ ${hostOffline.length}` +
        (hostOffline.length > 0 ? `: ${hostOffline.slice(0, 10).map((h) => h.name).join(', ')}` : '');
      const r = await capture(() => ai.chat(INLINE.host(text)));
      return { ...r, trace: { via: 'zabbix.getHosts(50) → hostCtxText', context: text } };
    }
    case 'ctx_wifi': {
      const { aps, switches, gateways } = await omada.getAPs();
      const devices = [...gateways, ...switches, ...aps];
      const wifiOffline = devices.filter((d) => d.status === 'down');
      const text = `อุปกรณ์เครือข่าย: AP ${aps.length}, Switch ${switches.length}, Gateway ${gateways.length}` +
        ` — ปกติ ${devices.length - wifiOffline.length} มีปัญหา ${wifiOffline.length}` +
        (wifiOffline.length > 0 ? `: ${wifiOffline.slice(0, 10).map((d) => `${d.name}(${d.type})`).join(', ')}` : '');
      const r = await capture(() => ai.chat(INLINE.wifi(text)));
      return { ...r, trace: { via: 'omada.getAPs → wifiCtxText', context: text } };
    }
    case 'ctx_camera': {
      const cameras = await ext.getCamerasWithCache();
      const cameraOffline = cameras.filter((c) => !ext.isCamOnline(c));
      const text = `กล้องทั้งหมด ${cameras.length} เครื่อง ปกติ ${cameras.length - cameraOffline.length} มีปัญหา ${cameraOffline.length}` +
        (cameraOffline.length > 0 ? `: ${cameraOffline.slice(0, 5).map((c) => c.name).join(', ')}` : '');
      const r = await capture(() => ai.chat(INLINE.camera(text)));
      return { ...r, trace: { via: 'getCamerasWithCache (Zabbix+HikCentral) → cameraCtxText', context: text } };
    }
    case 'ctx_summary': {
      const [zData, apsResult, clientsResult, hData] = await Promise.allSettled([zabbix.getSummary(), omada.getAPs(), omada.getClients(), hikcentral.getCameras()]);
      const allData = {
        zabbix: zData.status === 'fulfilled' ? zData.value : null,
        omada: { aps: apsResult.status === 'fulfilled' ? (apsResult.value?.aps || null) : null, clients: clientsResult.status === 'fulfilled' ? (clientsResult.value || null) : null },
        hik: hData.status === 'fulfilled' ? { cameras: hData.value } : null,
      };
      const z = allData.zabbix || {}; const h = allData.hik || {}; const o = allData.omada || {};
      const text = [
        `Zabbix: ${z.problems?.length || 0} alerts, ${z.hosts?.filter((h2) => h2.available === 1).length || 0}/${z.hosts?.length || 0} hosts online`,
        h.cameras ? `กล้อง: ${h.cameras.filter((c) => c.online).length}/${h.cameras.length} online` : null,
        o.aps ? `WiFi: ${o.aps.length} APs, ${o.clients?.total || 0} clients` : null,
      ].filter(Boolean).join('. ');
      const r = await capture(() => ai.chat(INLINE.summary(text)));
      return { ...r, trace: { via: 'zabbix.getSummary + omada.getAPs/getClients + hikcentral.getCameras → summaryCtxText', context: text } };
    }
    default:
      throw new Error(`path ไม่รู้จัก: ${spec.path}`);
  }
}

module.exports = { loadBot, derive, checkDrift, EXTRACTED };
