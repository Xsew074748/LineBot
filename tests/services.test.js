'use strict';
// Unit Tests ด้วย Jest
// รัน: npm test

// ── Mock modules ที่ต้องการ Network/File ──────────────────────────────────────
jest.mock('../services/logger', () => ({
  info: jest.fn(), error: jest.fn(), warn: jest.fn(),
  apiCall: jest.fn(), aiCall: jest.fn(), audit: jest.fn(), message: jest.fn(),
}));

jest.mock('fs', () => ({
  ...jest.requireActual('fs'),
  existsSync:     jest.fn(() => true),
  readFileSync:   jest.fn(() => '{}'),
  writeFileSync:  jest.fn(),
  appendFileSync: jest.fn(),
  mkdirSync:      jest.fn(),
}));

// ── validator.js ───────────────────────────────────────────────────────────────
const { validateIP, validateLineUserId, validateRole, sanitizeText, isTimestampFresh } =
  require('../services/validator');

describe('validator', () => {
  describe('validateIP', () => {
    it('ยอมรับ IP ที่ถูกต้องใน prefix', () => {
      process.env.ALLOWED_IP_PREFIX = '192.168.';
      expect(validateIP('192.168.1.100').valid).toBe(true);
    });

    it('ปฏิเสธ IP นอก prefix', () => {
      process.env.ALLOWED_IP_PREFIX = '192.168.';
      expect(validateIP('10.0.0.1').valid).toBe(false);
    });

    it('ปฏิเสธ IP format ผิด', () => {
      expect(validateIP('999.999.999.999').valid).toBe(false);
      expect(validateIP('abc.def.ghi.jkl').valid).toBe(false);
      expect(validateIP('').valid).toBe(false);
    });

    it('ปฏิเสธ octet เกิน 255', () => {
      process.env.ALLOWED_IP_PREFIX = '192.168.';
      expect(validateIP('192.168.300.1').valid).toBe(false);
    });
  });

  describe('validateLineUserId', () => {
    it('ยอมรับ LINE UserID ที่ถูกต้อง', () => {
      expect(validateLineUserId('U' + 'a'.repeat(32))).toBe(true);
    });

    it('ปฏิเสธ UserID ที่ผิดรูปแบบ', () => {
      expect(validateLineUserId('invalid')).toBe(false);
      expect(validateLineUserId('')).toBe(false);
      expect(validateLineUserId(null)).toBe(false);
    });
  });

  describe('validateRole', () => {
    it('ยอมรับ role ที่ถูกต้อง', () => {
      expect(validateRole('ADMIN')).toBe(true);
      expect(validateRole('IT_STAFF')).toBe(true);
      expect(validateRole('VIEWER')).toBe(true);
    });

    it('ปฏิเสธ role ที่ไม่มีอยู่', () => {
      expect(validateRole('SUPERUSER')).toBe(false);
      expect(validateRole('')).toBe(false);
    });
  });

  describe('sanitizeText', () => {
    it('ตัด whitespace และจำกัดความยาว', () => {
      expect(sanitizeText('  hello  ')).toBe('hello');
      expect(sanitizeText('a'.repeat(600), 500)).toHaveLength(500);
    });
  });

  describe('isTimestampFresh', () => {
    it('ยอมรับ timestamp ที่เพิ่งสร้าง', () => {
      expect(isTimestampFresh(Date.now())).toBe(true);
    });

    it('ปฏิเสธ timestamp เก่าเกิน 5 นาที', () => {
      expect(isTimestampFresh(Date.now() - 6 * 60 * 1000)).toBe(false);
    });
  });
});

// ── auth.js ────────────────────────────────────────────────────────────────────
const auth = require('../services/auth');

describe('auth', () => {
  const VALID_ID = 'U' + 'b'.repeat(32);

  beforeEach(() => {
    // Reset mock ก่อนทุก test
    const fs = require('fs');
    fs.readFileSync.mockReturnValue('{}');
  });

  describe('getUserRole', () => {
    it('คืน PENDING สำหรับ User ใหม่ที่ยังไม่ได้รับอนุมัติ', () => {
      expect(auth.getUserRole('unknown_user')).toBe('PENDING');
    });
  });

  describe('hasPermission', () => {
    it('ADMIN มีสิทธิ์ทุกอย่าง', () => {
      expect(auth.hasPermission('ADMIN', 'VIEWER')).toBe(true);
      expect(auth.hasPermission('ADMIN', 'IT_STAFF')).toBe(true);
      expect(auth.hasPermission('ADMIN', 'ADMIN')).toBe(true);
    });

    it('VIEWER ไม่มีสิทธิ์ IT_STAFF', () => {
      expect(auth.hasPermission('VIEWER', 'IT_STAFF')).toBe(false);
      expect(auth.hasPermission('VIEWER', 'ADMIN')).toBe(false);
    });

    it('IT_STAFF มีสิทธิ์ VIEWER แต่ไม่มีสิทธิ์ ADMIN', () => {
      expect(auth.hasPermission('IT_STAFF', 'VIEWER')).toBe(true);
      expect(auth.hasPermission('IT_STAFF', 'ADMIN')).toBe(false);
    });
  });

  describe('addUser', () => {
    it('ปฏิเสธ LINE UserID ที่ไม่ถูกต้อง', () => {
      const result = auth.addUser('invalid_id', 'VIEWER');
      expect(result.ok).toBe(false);
    });

    it('ปฏิเสธ Role ที่ไม่มีอยู่', () => {
      const result = auth.addUser(VALID_ID, 'SUPERUSER');
      expect(result.ok).toBe(false);
    });

    it('เพิ่ม User สำเร็จ', () => {
      const result = auth.addUser(VALID_ID, 'IT_STAFF');
      expect(result.ok).toBe(true);
    });
  });

  describe('PIN session', () => {
    it('isPinVerified คืน false ก่อน verify', () => {
      expect(auth.isPinVerified('some_user')).toBe(false);
    });

    it('isPinVerified คืน true หลัง setPinVerified', () => {
      auth.setPinVerified('some_user');
      expect(auth.isPinVerified('some_user')).toBe(true);
    });
  });
});

// ── config.js ─────────────────────────────────────────────────────────────────
const config = require('../config');

describe('config', () => {
  it('getEnabledMonitors คืน object ที่ถูกต้อง', () => {
    const enabled = config.getEnabledMonitors();
    expect(typeof enabled).toBe('object');
  });

  it('ROLES มีครบ 4 roles (รวม PENDING)', () => {
    expect(Object.keys(config.ROLES)).toHaveLength(4);
  });

  it('ROLE_HIERARCHY เรียงถูกต้อง (ADMIN อันดับแรก)', () => {
    expect(config.ROLE_HIERARCHY[0]).toBe('ADMIN');
    expect(config.ROLE_HIERARCHY[2]).toBe('VIEWER');
  });
});
