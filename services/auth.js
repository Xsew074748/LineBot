'use strict';
const fs   = require('fs');
const path = require('path');
const { ROLES, ROLE_HIERARCHY, COMMAND_PERMISSIONS, AI_CONFIG } = require('../config');
const { validateLineUserId, validateRole } = require('./validator');
const logger = require('./logger');

// ── ที่เก็บข้อมูล User ────────────────────────────────────────────────────────
const USERS_FILE = path.join(__dirname, '..', 'data', 'users.json');

// PIN session: userId → { pin, expireAt }
// เก็บใน memory เท่านั้น (ไม่บันทึกลงไฟล์)
const pinSessions = new Map();
const PIN_TTL_MS  = 5 * 60 * 1000; // PIN ใช้ได้ 5 นาทีหลัง verify

// ── Read/Write users.json ─────────────────────────────────────────────────────
function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'));
  } catch (err) {
    logger.error('auth: โหลด users.json ล้มเหลว', err);
    return {};
  }
}

function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    logger.error('auth: บันทึก users.json ล้มเหลว', err);
  }
}

const todayStr = () => new Date().toISOString().slice(0, 10); // YYYY-MM-DD

// ── ดึง Role ของ User ─────────────────────────────────────────────────────────
// User ที่ไม่มีในระบบถือว่า PENDING (ต้องรอ admin อนุมัติ)
function getUserRole(userId) {
  const users = loadUsers();
  return users[userId]?.role || ROLES.PENDING;
}

function isPending(userId) {
  return getUserRole(userId) === ROLES.PENDING;
}

// ── Auto-register user ใหม่เป็น PENDING ─────────────────────────────────────
function registerPending(userId) {
  if (!validateLineUserId(userId)) return;
  const users = loadUsers();
  if (users[userId]) return; // มีในระบบแล้ว ไม่ต้องสร้างใหม่
  users[userId] = { role: ROLES.PENDING, addedAt: new Date().toISOString() };
  saveUsers(users);
  logger.info(`auth: new pending user auto-registered: ${userId}`);
}

// ── ตรวจสอบว่า Role มีสิทธิ์ใช้คำสั่งไหม ─────────────────────────────────────
function hasPermission(userRole, requiredRole) {
  const userLevel     = ROLE_HIERARCHY.indexOf(userRole);
  const requiredLevel = ROLE_HIERARCHY.indexOf(requiredRole);
  // index น้อยกว่า = สิทธิ์สูงกว่า (ADMIN = 0, VIEWER = 2)
  return userLevel !== -1 && userLevel <= requiredLevel;
}

// ── ตรวจสอบสิทธิ์คำสั่งจาก command key ──────────────────────────────────────
function canExecute(userId, commandKey) {
  const userRole    = getUserRole(userId);
  const required    = COMMAND_PERMISSIONS[commandKey] || ROLES.VIEWER;
  return hasPermission(userRole, required);
}

// ── Approve pending user ───────────────────────────────────────────────────────
function approvePending(targetId, role) {
  if (!validateLineUserId(targetId)) return { ok: false, msg: 'LINE UserID ไม่ถูกต้อง' };
  if (!validateRole(role))           return { ok: false, msg: 'Role ต้องเป็น: ADMIN, IT_STAFF, VIEWER' };
  const users = loadUsers();
  if (!users[targetId]) return { ok: false, msg: 'ไม่พบ UserID นี้ในระบบ (ยังไม่เคย chat มา)' };
  if (users[targetId].role !== ROLES.PENDING) return { ok: false, msg: `User นี้ไม่ได้อยู่สถานะ pending (role: ${users[targetId].role})` };
  const normalizedRole = role.toUpperCase();
  users[targetId] = { ...users[targetId], role: normalizedRole, approvedAt: new Date().toISOString() };
  saveUsers(users);
  return { ok: true, msg: `อนุมัติ ${targetId} เป็น ${normalizedRole} แล้ว` };
}

// ── รายชื่อ pending users ──────────────────────────────────────────────────────
function getPendingUsers() {
  const users = loadUsers();
  return Object.entries(users)
    .filter(([, d]) => d.role === ROLES.PENDING)
    .map(([id, d]) => ({ id, addedAt: d.addedAt }));
}

// ── เพิ่ม User ────────────────────────────────────────────────────────────────
function addUser(targetId, role) {
  if (!validateLineUserId(targetId)) return { ok: false, msg: 'LINE UserID ไม่ถูกต้อง' };
  if (!validateRole(role))           return { ok: false, msg: `Role ต้องเป็น: ${Object.values(ROLES).join(', ')}` };

  const users = loadUsers();
  const normalizedRole = role.toUpperCase();
  users[targetId] = { ...(users[targetId] || {}), role: normalizedRole, addedAt: new Date().toISOString() };
  saveUsers(users);
  return { ok: true, msg: `เพิ่ม ${targetId} เป็น ${normalizedRole} แล้ว` };
}

// ── AI Quota ───────────────────────────────────────────────────────────────────
function canUseAI(userId) {
  const role = getUserRole(userId);
  if (!AI_CONFIG.allowedRoles.includes(role)) {
    return { ok: false, reason: 'role' };
  }
  const users = loadUsers();
  const u = users[userId] || {};
  const used = (u.aiQuotaDate === todayStr()) ? (u.aiUsedToday || 0) : 0;
  if (used >= AI_CONFIG.dailyQuota) {
    return { ok: false, reason: 'quota', used, limit: AI_CONFIG.dailyQuota };
  }
  return { ok: true, used, limit: AI_CONFIG.dailyQuota };
}

function incrementAIUsage(userId) {
  const users = loadUsers();
  if (!users[userId]) return;
  const u   = users[userId];
  const day = todayStr();
  if (u.aiQuotaDate !== day) { u.aiQuotaDate = day; u.aiUsedToday = 0; }
  u.aiUsedToday = (u.aiUsedToday || 0) + 1;
  saveUsers(users);
}

// ── ลบ User ───────────────────────────────────────────────────────────────────
function removeUser(targetId) {
  const users = loadUsers();
  if (!users[targetId]) return { ok: false, msg: 'ไม่พบ UserID นี้ในระบบ' };
  delete users[targetId];
  saveUsers(users);
  return { ok: true, msg: `ลบ ${targetId} ออกจากระบบแล้ว` };
}

// ── แสดง User ทั้งหมด ─────────────────────────────────────────────────────────
function listUsers() {
  const users = loadUsers();
  return Object.entries(users).map(([id, data]) => ({
    id,
    role: data.role,
    addedAt: data.addedAt,
  }));
}

// ── PIN Session Management ─────────────────────────────────────────────────────
// เรียกเมื่อ User พิมพ์ PIN ถูกต้อง → เปิดสิทธิ์ดู sensitive data 5 นาที
function setPinVerified(userId) {
  pinSessions.set(userId, { expireAt: Date.now() + PIN_TTL_MS });
}

// ตรวจสอบว่า PIN session ยังใช้ได้ไหม
function isPinVerified(userId) {
  const session = pinSessions.get(userId);
  if (!session) return false;
  if (Date.now() > session.expireAt) {
    pinSessions.delete(userId); // หมดอายุแล้ว ลบทิ้ง
    return false;
  }
  return true;
}

module.exports = {
  getUserRole,
  hasPermission,
  canExecute,
  isPending,
  registerPending,
  approvePending,
  getPendingUsers,
  addUser,
  removeUser,
  listUsers,
  canUseAI,
  incrementAIUsage,
  setPinVerified,
  isPinVerified,
};
