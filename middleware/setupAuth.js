'use strict';
const crypto = require('crypto');
const fs     = require('fs');
const path   = require('path');

const sessions  = new Map(); // token → { expireAt }
const SESSION_TTL = 24 * 60 * 60 * 1000; // 24h

function sha256(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex');
}

function isLanIp(ip) {
  const c = (ip || '').replace('::ffff:', '');
  return (
    c === '127.0.0.1' || c === '::1' || c === '' ||
    /^192\.168\./.test(c) ||
    /^10\./.test(c) ||
    /^172\.(1[6-9]|2[0-9]|3[01])\./.test(c)
  );
}

// Returns true if host looks like an external domain (Cloudflare tunnel, etc.)
function isExternalHost(host) {
  if (!host) return false;
  const h = (host.split(':')[0] || '').toLowerCase();
  if (h === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(h)) return false;
  return h.includes('.');
}

function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { expireAt: Date.now() + SESSION_TTL });
  return token;
}

function verifySession(token) {
  if (!token) return false;
  const s = sessions.get(token);
  if (!s) return false;
  if (Date.now() > s.expireAt) { sessions.delete(token); return false; }
  s.expireAt = Date.now() + SESSION_TTL; // refresh
  return true;
}

function clearSession(token) {
  sessions.delete(token);
}

function getSessionToken(req) {
  const cookie = req.headers.cookie || '';
  const m = cookie.match(/setup_session=([a-f0-9]{64})/);
  return m ? m[1] : null;
}

function verifyPassword(password) {
  const envPath = path.join(__dirname, '..', '.env');
  let stored = '';
  try {
    const m = fs.readFileSync(envPath, 'utf8').match(/^SETUP_PASSWORD_HASH=(.+)$/m);
    stored = m ? m[1].trim() : '';
  } catch {}
  if (!stored) stored = sha256('admin'); // default password before first setup
  // timingSafeEqual บังคับให้ทั้งสอง buffer ยาวเท่ากัน — ตรวจก่อนเรียกเสมอ
  // (stored อาจไม่ใช่ sha256 hex 64 ตัว ถ้า .env ถูกแก้มือ)
  const a = Buffer.from(sha256(password));
  const b = Buffer.from(stored);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function lanOnly(req, res, next) {
  const ip   = (req.ip || req.socket?.remoteAddress || '').replace('::ffff:', '');
  const host = req.headers.host || '';
  if (isExternalHost(host)) {
    return res.status(403).type('text').send('403: Setup/Settings ไม่สามารถเข้าถึงได้จากภายนอก LAN');
  }
  if (!isLanIp(ip)) {
    return res.status(403).type('text').send(
      `403: Setup เข้าได้เฉพาะจาก LAN เท่านั้น (IP: ${ip})`
    );
  }
  next();
}

function requireLogin(req, res, next) {
  const token = getSessionToken(req);
  if (verifySession(token)) return next();
  const isApi = req.originalUrl.startsWith('/api/') || (req.headers.accept || '').includes('application/json');
  if (isApi) return res.status(401).json({ ok: false, error: 'กรุณา Login ก่อน' });
  res.redirect('/setup/login?next=' + encodeURIComponent(req.originalUrl));
}

module.exports = { lanOnly, requireLogin, createSession, verifySession, clearSession, getSessionToken, verifyPassword, sha256 };
