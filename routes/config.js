'use strict';
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const axios   = require('axios');
const auth    = require('../middleware/setupAuth');

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
function updateConfigEnabled(service, enabled) {
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
      enabled:  e.OMADA_ENABLED !== 'false' && !!e.OMADA_URL,
      url:      e.OMADA_URL      || '',
      username: e.OMADA_USERNAME || '',
      siteId:   e.OMADA_SITE_ID  || '',
      password: { masked: mask(e.OMADA_PASSWORD), set: !!e.OMADA_PASSWORD },
    },
    hikcentral: {
      enabled:      e.HIKCENTRAL_ENABLED !== 'false' && !!e.HIKCENTRAL_URL,
      url:          e.HIKCENTRAL_URL           || '',
      clientId:     e.HIKCENTRAL_CLIENT_ID     || '',
      clientSecret: { masked: mask(e.HIKCENTRAL_CLIENT_SECRET), set: !!e.HIKCENTRAL_CLIENT_SECRET },
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

  // Omada
  if (b.omadaEnabled !== undefined) updates['OMADA_ENABLED'] = b.omadaEnabled ? 'true' : 'false';
  set('OMADA_URL',      b.omadaUrl);
  set('OMADA_USERNAME', b.omadaUsername);
  set('OMADA_PASSWORD', b.omadaPassword);
  set('OMADA_SITE_ID',  b.omadaSiteId);

  // HikCentral
  if (b.hikcentralEnabled !== undefined) updates['HIKCENTRAL_ENABLED'] = b.hikcentralEnabled ? 'true' : 'false';
  set('HIKCENTRAL_URL',           b.hikcentralUrl);
  set('HIKCENTRAL_CLIENT_ID',     b.hikcentralClientId);
  set('HIKCENTRAL_CLIENT_SECRET', b.hikcentralClientSecret);

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
    res.json({ ok: true, message: 'บันทึกเรียบร้อย — กรุณา Restart Bot เพื่อให้ค่าใหม่มีผล' });
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
      const url  = get('url', 'OMADA_URL');
      const user = get('username', 'OMADA_USERNAME');
      const pass = get('password', 'OMADA_PASSWORD');
      if (!url || !user || !pass) return res.json({ ok: false, message: 'กรุณากรอก URL, Username และ Password' });
      const r = await axios.post(`${url.replace(/\/$/, '')}/api/v2/hotspot/login`,
        { username: user, password: pass }, { timeout: 6000 });
      const ok = r.data?.errorCode === 0;
      return res.json({ ok, message: ok ? '✅ เชื่อมต่อ Omada สำเร็จ' : (r.data?.msg || 'Login ล้มเหลว') });
    }

    if (svc === 'hikcentral') {
      const url    = get('url', 'HIKCENTRAL_URL');
      const id     = get('clientId', 'HIKCENTRAL_CLIENT_ID');
      const secret = get('clientSecret', 'HIKCENTRAL_CLIENT_SECRET');
      if (!url || !id || !secret) return res.json({ ok: false, message: 'กรุณากรอก URL, Client ID และ Secret' });
      const r = await axios.post(`${url.replace(/\/$/, '')}/api/v1/oauth/token`,
        new URLSearchParams({ grant_type: 'client_credentials', client_id: id, client_secret: secret }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 6000 }
      );
      const ok = !!r.data?.access_token;
      return res.json({ ok, message: ok ? '✅ เชื่อมต่อ HikCentral สำเร็จ' : 'ไม่ได้รับ access_token' });
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

    res.status(400).json({ ok: false, error: `ไม่รู้จัก service: ${b.service}` });
  } catch (err) {
    const msg = err.response?.data?.message || err.response?.data?.msg || err.message || 'เชื่อมต่อไม่ได้';
    res.json({ ok: false, message: `❌ ${msg}` });
  }
});

module.exports = router;
