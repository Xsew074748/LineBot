'use strict';
const express = require('express');
const path    = require('path');
const auth    = require('../middleware/setupAuth');

const router = express.Router();
const PUBLIC = path.join(__dirname, '..', 'public');

// GET /setup → redirect based on login state
router.get('/', (req, res) => {
  if (auth.verifySession(auth.getSessionToken(req))) return res.redirect('/setup/wizard');
  res.redirect('/setup/login');
});

// GET /setup/login
router.get('/login', (req, res) => {
  if (auth.verifySession(auth.getSessionToken(req))) return res.redirect('/setup/wizard');
  res.sendFile(path.join(PUBLIC, 'setup-login.html'));
});

// POST /setup/login
router.post('/login', express.urlencoded({ extended: false }), (req, res) => {
  const { password } = req.body || {};
  if (!auth.verifyPassword(password || '')) {
    return res.redirect('/setup/login?error=1');
  }
  const token = auth.createSession();
  const next  = req.query.next && req.query.next.startsWith('/') ? req.query.next : '/setup/wizard';
  res.setHeader('Set-Cookie', `setup_session=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`);
  res.redirect(next);
});

// GET /setup/wizard
router.get('/wizard', auth.requireLogin, (req, res) => {
  res.sendFile(path.join(PUBLIC, 'setup-wizard.html'));
});

// GET /setup/logout
router.get('/logout', (req, res) => {
  auth.clearSession(auth.getSessionToken(req));
  res.setHeader('Set-Cookie', 'setup_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
  res.redirect('/setup/login');
});

module.exports = router;
