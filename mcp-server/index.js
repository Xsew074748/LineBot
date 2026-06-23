import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import path from 'path';
import { config as dotenvConfig } from 'dotenv';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ── Bootstrap ─────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// โหลด .env ของ project root ก่อน config.js (ซึ่ง require dotenv อีกครั้ง แต่จะ no-op)
dotenvConfig({ path: path.join(__dirname, '..', '.env') });

// ESM → CJS bridge: ให้ ESM โหลด CJS modules ของโปรเจค
const require = createRequire(import.meta.url);
const appConfig = require('../config.js');
const { correlate } = require('../services/correlate.js');

// ── MCP Server ────────────────────────────────────────────────────────────────
const server = new McpServer({
  name: 'it-monitor',
  version: '1.0.0',
});

// ── Tool 1: get_problems ──────────────────────────────────────────────────────
server.tool(
  'get_problems',
  'ดึงรายการ alert/ปัญหาที่กำลังเกิดขึ้นจากระบบเฝ้าระวังทั้งหมด',
  {
    zone: z.string().min(1).optional().describe('กรองตามพื้นที่/โซน เช่น "A", "B", "ตึก1"'),
  },
  async ({ zone }) => {
    try {
      const adapters = appConfig.getAdapters();
      if (adapters.length === 0) {
        return { content: [{ type: 'text', text: 'ไม่มี adapter ที่เปิดใช้งาน กรุณาตรวจสอบ .env' }] };
      }

      const results = await Promise.allSettled(
        adapters.map(async ({ name, adapter }) => {
          const problems = await adapter.getProblems();
          return problems.map(p => ({ ...p, _source: name }));
        })
      );

      const errors = [];
      let allProblems = [];
      for (const [i, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          allProblems.push(...result.value);
        } else {
          errors.push(`${adapters[i].name}: ${result.reason?.message ?? String(result.reason)}`);
        }
      }

      if (zone) {
        allProblems = allProblems.filter(p => p.zone && p.zone.includes(zone));
      }

      const out = { total: allProblems.length, zone: zone ?? 'ทั้งหมด', problems: allProblems };
      if (errors.length > 0) out.errors = errors;

      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 2: get_devices ───────────────────────────────────────────────────────
server.tool(
  'get_devices',
  'ดึงรายการอุปกรณ์และสถานะ (กล้อง/AP/switch/host)',
  {
    type: z.enum(['camera', 'ap', 'switch', 'host']).optional()
      .describe('ประเภทอุปกรณ์: camera | ap | switch | host'),
  },
  async ({ type }) => {
    try {
      const adapters = appConfig.getAdapters();
      if (adapters.length === 0) {
        return { content: [{ type: 'text', text: 'ไม่มี adapter ที่เปิดใช้งาน กรุณาตรวจสอบ .env' }] };
      }

      const results = await Promise.allSettled(
        adapters.map(async ({ name, adapter }) => {
          const devices = await adapter.getDevices();
          return devices.map(d => ({ ...d, _source: name }));
        })
      );

      const errors = [];
      let allDevices = [];
      for (const [i, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          allDevices.push(...result.value);
        } else {
          errors.push(`${adapters[i].name}: ${result.reason?.message ?? String(result.reason)}`);
        }
      }

      if (type) {
        allDevices = allDevices.filter(d => d.type === type);
      }

      const out = { total: allDevices.length, filter: type ?? 'ทั้งหมด', devices: allDevices };
      if (errors.length > 0) out.errors = errors;

      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 3: get_status_summary ────────────────────────────────────────────────
server.tool(
  'get_status_summary',
  'ดึงภาพรวมสถานะระบบทั้งหมด มีอุปกรณ์ออนไลน์/ออฟไลน์เท่าไหร่',
  {},
  async () => {
    try {
      const adapters = appConfig.getAdapters();
      if (adapters.length === 0) {
        return { content: [{ type: 'text', text: 'ไม่มี adapter ที่เปิดใช้งาน กรุณาตรวจสอบ .env' }] };
      }

      const [deviceResults, problemResults] = await Promise.all([
        Promise.allSettled(
          adapters.map(async ({ name, adapter }) => ({ name, devices: await adapter.getDevices() }))
        ),
        Promise.allSettled(
          adapters.map(async ({ name, adapter }) => ({ name, problems: await adapter.getProblems() }))
        ),
      ]);

      const summary = {
        timestamp: new Date().toISOString(),
        sources: [],
        total: { up: 0, down: 0, devices: 0, problems: 0 },
      };

      for (const [i, result] of deviceResults.entries()) {
        if (result.status === 'fulfilled') {
          const { name, devices } = result.value;
          const up   = devices.filter(d => d.status === 'up').length;
          const down = devices.filter(d => d.status === 'down').length;
          summary.sources.push({ source: name, up, down, total: devices.length });
          summary.total.up      += up;
          summary.total.down    += down;
          summary.total.devices += devices.length;
        } else {
          summary.sources.push({
            source: adapters[i].name,
            error: result.reason?.message ?? String(result.reason),
          });
        }
      }

      for (const result of problemResults) {
        if (result.status === 'fulfilled') {
          summary.total.problems += result.value.problems.length;
        }
      }

      return { content: [{ type: 'text', text: JSON.stringify(summary, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Tool 4: analyze_correlation ───────────────────────────────────────────────
server.tool(
  'analyze_correlation',
  'วิเคราะห์ว่ามีอุปกรณ์หลายระบบขัดข้องพร้อมกันเป็นกลุ่มหรือไม่ เพื่อหาต้นเหตุร่วม',
  {},
  async () => {
    try {
      const adapters = appConfig.getAdapters();
      if (adapters.length === 0) {
        return { content: [{ type: 'text', text: 'ไม่มี adapter ที่เปิดใช้งาน กรุณาตรวจสอบ .env' }] };
      }

      const results = await Promise.allSettled(
        adapters.map(({ adapter }) => adapter.getProblems())
      );

      const errors = [];
      const allProblems = [];
      for (const [i, result] of results.entries()) {
        if (result.status === 'fulfilled') {
          allProblems.push(...result.value);
        } else {
          errors.push(`${adapters[i].name}: ${result.reason?.message ?? String(result.reason)}`);
        }
      }

      const groups = correlate(allProblems, appConfig.CORRELATION_CONFIG);

      const out = {
        totalProblems: allProblems.length,
        correlationGroups: groups.length,
        groups,
      };
      if (errors.length > 0) out.errors = errors;

      return { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }] };
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true };
    }
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('IT Monitor MCP Server ready (stdio)\n');
