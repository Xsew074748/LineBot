'use strict';
const express    = require('express');
const fs         = require('fs');
const path       = require('path');
const axios      = require('axios');
const auth       = require('../middleware/setupAuth');
const logger     = require('../services/logger');
// testConnection: ฟังก์ชัน test ของ Omada — Open API client credentials flow
// เดียวกับ service จริง (POST /openapi/authorize/token) + httpsAgent เดียวกัน
const { testConnection: omadaTestConn } = require('../services/omada');
// healthCheck: ทดสอบ HikCentral ด้วย AK/SK signature flow เดียวกับ service จริง
const hik = require('../services/hikcentral');

const router   = express.Router();
const ENV_PATH = path.join(__dirname, '..', '.env');
const CFG_PATH = path.join(__dirname, '..', 'config.js');

// ── .env helpers ──────────────────────────────────────────────────────────────
function readEnv() {
  const obj = {};
  try {
    fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/).forEach(line => {
      const m = line.match(/^([^#=][^=]*)=(.*)$/);
      if (m) obj[m[1].trim()] = m[2].trim();
    });
  } catch {}
  return obj;
}

function writeEnv(updates) {
  // กัน env injection — ค่าที่มี newline ตรงกลางจะกลายเป็น key ใหม่ใน .env ได้
  for (const k of Object.keys(updates)) {
    updates[k] = String(updates[k]).replace(/[\r\n]/g, ' ');
  }

  let lines = [];
  try { lines = fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/); } catch {}

  const written = new Set();
  const updated = lines.map(line => {
    const m = line.match(/^([^#=][^=]*)=(.*)$/);
    if (!m) return line;
    const key = m[1].trim();
    if (key in updates) { written.add(key); return `${key}=${updates[key]}`; }
    return line;
  });

  for (const [k, v] of Object.entries(updates)) {
    if (!written.has(k)) updated.push(`${k}=${v}`);
  }

  // Remove trailing blank lines, add one newline at end
  fs.writeFileSync(ENV_PATH, updated.filter((l, i, a) => l.trim() || i < a.length - 1).join('\n') + '\n', 'utf8');
}

function mask(val) {
  if (!val) return '';
  if (val.length <= 8) return '••••••••';
  return '••••' + val.slice(-4);
}

// ── Update enabled flag in config.js ────────────────────────────────────────
const ALLOWED_SERVICES = ['omada', 'hikcentral'];

function updateConfigEnabled(service, enabled) {
  if (!ALLOWED_SERVICES.includes(service)) return;
  if (enabled === undefined || enabled === null) return;
  try {
    let src = fs.readFileSync(CFG_PATH, 'utf8');
    const val = (enabled === true || enabled === 'true') ? 'true' : 'false';
    // Match  service: {  ... enabled: true/false  (with any whitespace/newlines between)
    const re = new RegExp(`(${service}:[\\s\\S]*?enabled:\\s*)(true|false)`, '');
    if (re.test(src)) {
      src = src.replace(re, `$1${val}`);
      fs.writeFileSync(CFG_PATH, src, 'utf8');
    }
  } catch (e) {
    console.warn('[config.js] updateConfigEnabled failed:', e.message);
  }
}

// ── GET /api/config/current ───────────────────────────────────────────────────
router.get('/current', (req, res) => {
  const e = readEnv();
  res.json({
    line: {
      channelSecret:      { masked: mask(e.LINE_CHANNEL_SECRET),      set: !!e.LINE_CHANNEL_SECRET },
      channelAccessToken: { masked: mask(e.LINE_CHANNEL_ACCESS_TOKEN), set: !!e.LINE_CHANNEL_ACCESS_TOKEN },
    },
    zabbix: {
      url:      e.ZABBIX_URL || '',
      apiToken: { masked: mask(e.ZABBIX_API_TOKEN), set: !!e.ZABBIX_API_TOKEN },
    },
    omada: {
      enabled:      e.OMADA_ENABLED !== 'false' && !!e.OMADA_URL,
      url:          e.OMADA_URL       || '',
      omadacId:     e.OMADA_OMADAC_ID || '',
      siteId:       e.OMADA_SITE_ID   || '',
      clientId:     e.OMADA_CLIENT_ID || '',
      clientSecret: { masked: mask(e.OMADA_CLIENT_SECRET), set: !!e.OMADA_CLIENT_SECRET },
    },
    hikcentral: {
      enabled:   e.HIKCENTRAL_ENABLED !== 'false' && !!e.HIKCENTRAL_URL,
      url:       e.HIKCENTRAL_URL      || '',
      appKey:    e.HIKCENTRAL_APP_KEY  || '',
      appSecret: { masked: mask(e.HIKCENTRAL_APP_SECRET), set: !!e.HIKCENTRAL_APP_SECRET },
    },
    claude: {
      apiKey: { masked: mask(e.ANTHROPIC_API_KEY), set: !!e.ANTHROPIC_API_KEY },
    },
    setup: {
      hasPassword: !!e.SETUP_PASSWORD_HASH,
      port: e.PORT || '3000',
    },
  });
});

// ── POST /api/config/save ─────────────────────────────────────────────────────
router.post('/save', (req, res) => {
  const b = req.body || {};
  const updates = {};

  const set = (envKey, val) => {
    // Skip if empty or still masked (user didn't change it)
    if (val !== undefined && val !== null && val !== '' && !String(val).includes('••••')) {
      updates[envKey] = String(val).trim();
    }
  };

  // LINE
  set('LINE_CHANNEL_SECRET',       b.lineChannelSecret);
  set('LINE_CHANNEL_ACCESS_TOKEN', b.lineChannelAccessToken);

  // Zabbix
  set('ZABBIX_URL',       b.zabbixUrl);
  set('ZABBIX_API_TOKEN', b.zabbixApiToken);

  // Omada (Open API — OAuth2 client credentials)
  if (b.omadaEnabled !== undefined) updates['OMADA_ENABLED'] = b.omadaEnabled ? 'true' : 'false';
  set('OMADA_URL',           b.omadaUrl);
  set('OMADA_OMADAC_ID',     b.omadaOmadacId);
  set('OMADA_CLIENT_ID',     b.omadaClientId);
  set('OMADA_CLIENT_SECRET', b.omadaClientSecret);
  set('OMADA_SITE_ID',       b.omadaSiteId);

  // HikCentral (AK/SK)
  if (b.hikcentralEnabled !== undefined) updates['HIKCENTRAL_ENABLED'] = b.hikcentralEnabled ? 'true' : 'false';
  set('HIKCENTRAL_URL',        b.hikcentralUrl);
  set('HIKCENTRAL_APP_KEY',    b.hikcentralAppKey);
  set('HIKCENTRAL_APP_SECRET', b.hikcentralAppSecret);

  // Claude
  set('ANTHROPIC_API_KEY', b.claudeApiKey);

  // Port
  if (b.port) updates['PORT'] = String(parseInt(b.port, 10) || 3000);

  // Setup password
  if (b.setupPassword && b.setupPassword.length >= 4) {
    updates['SETUP_PASSWORD_HASH'] = auth.sha256(b.setupPassword);
  }

  try {
    writeEnv(updates);
    if (b.omadaEnabled !== undefined)      updateConfigEnabled('omada',      b.omadaEnabled);
    if (b.hikcentralEnabled !== undefined) updateConfigEnabled('hikcentral', b.hikcentralEnabled);
    res.json({ ok: true, message: 'บันทึกสำเร็จ — กำลัง restart bot อัตโนมัติ...' });

    // ออกจาก process หลังส่ง response แล้ว — docker-compose ตั้ง restart:always ไว้
    // จึงจะ start container ใหม่ให้เอง และโหลด .env ที่เพิ่งบันทึกเข้ามาแทน
    // (ข้ามตอนรัน test เพราะไม่ได้รันภายใต้ docker restart policy)
    if (process.env.NODE_ENV !== 'test') {
      res.on('finish', () => {
        logger.info('Config saved — restarting process for new .env to take effect');
        setTimeout(() => process.exit(0), 200);
      });
    }
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ── POST /api/config/test ─────────────────────────────────────────────────────
router.post('/test', async (req, res) => {
  const b   = req.body || {};
  const env = readEnv();

  // Use values from request body first, fall back to .env
  const get = (bodyKey, envKey) => b[bodyKey] || env[envKey] || '';

  try {
    const svc = b.service;
    const ALLOWED_TEST_SERVICES = ['zabbix', 'omada', 'hikcentral', 'claude', 'line'];
    if (!ALLOWED_TEST_SERVICES.includes(svc)) {
      return res.status(400).json({ ok: false, error: 'ไม่รู้จัก service' });
    }

    if (svc === 'zabbix') {
      const url   = get('url', 'ZABBIX_URL');
      const token = get('apiToken', 'ZABBIX_API_TOKEN');
      if (!url || !token) return res.json({ ok: false, message: 'กรุณากรอก URL และ API Token' });
      const r = await axios.post(`${url.replace(/\/$/, '')}/api_jsonrpc.php`, {
        jsonrpc: '2.0', method: 'apiinfo.version', params: [], id: 1,
      }, { timeout: 6000 });
      const ver = r.data?.result;
      return res.json({ ok: !!ver, message: ver ? `✅ Zabbix ${ver}` : 'ไม่สามารถเชื่อมต่อได้' });
    }

    if (svc === 'omada') {
      // Open API ใช้ OMADAC_ID/CLIENT_ID/CLIENT_SECRET จาก .env (service อ่านตอนโหลดโมดูล)
      const url = get('url', 'OMADA_URL');
      if (!url) return res.json({ ok: false, message: 'กรุณากรอก URL' });
      // ใช้ testConnection จาก service — flow และ httpsAgent เดียวกับที่ใช้จริง
      return res.json(await omadaTestConn(url));
    }

    if (svc === 'hikcentral') {
      // ทดสอบด้วยค่าใน .env ปัจจุบัน (service อ่าน HIKCENTRAL_URL/APP_KEY/APP_SECRET ตอนโหลดโมดูล)
      const r = await hik.healthCheck();
      return res.json({ ok: r.ok, message: r.ok ? '✅ เชื่อมต่อ HikCentral สำเร็จ' : (r.error || 'เชื่อมต่อไม่สำเร็จ') });
    }

    if (svc === 'claude') {
      const key = get('apiKey', 'ANTHROPIC_API_KEY');
      if (!key) return res.json({ ok: false, message: 'กรุณากรอก API Key' });
      const r = await axios.post('https://api.anthropic.com/v1/messages', {
        model: 'claude-haiku-4-5-20251001', max_tokens: 10,
        messages: [{ role: 'user', content: 'Hi' }],
      }, { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, timeout: 12000 });
      const ok = r.status === 200;
      return res.json({ ok, message: ok ? '✅ Claude API ใช้งานได้' : 'ไม่สามารถเชื่อมต่อได้' });
    }

    if (svc === 'line') {
      const token = get('channelAccessToken', 'LINE_CHANNEL_ACCESS_TOKEN');
      if (!token) return res.json({ ok: false, message: 'กรุณากรอก Channel Access Token' });
      const r = await axios.get('https://api.line.me/v2/bot/info',
        { headers: { Authorization: `Bearer ${token}` }, timeout: 6000 });
      const name = r.data?.displayName;
      return res.json({ ok: !!name, message: name ? `✅ Bot: ${name}` : 'Token ไม่ถูกต้อง' });
    }

    res.status(400).json({ ok: false, error: 'ไม่รู้จัก service' });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.msg || err.message || 'เชื่อมต่อไม่ได้';
    res.json({ ok: false, message: `❌ ${msg}` });
  }
});

module.exports = router;
