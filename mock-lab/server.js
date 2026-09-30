'use strict';
// Mock Lab — จำลอง Zabbix + Omada (Open API) + HikCentral (artemis) ให้บอทจริงต่อเข้ามาทดสอบ
// อุปกรณ์และสถานะกำหนดด้วยไฟล์ YAML ใน scenarios/ (สลับ/สร้าง/แก้ระหว่างรันได้ผ่าน /mock/*)
//
//   node mock-lab/server.js [ไฟล์สถานการณ์.yaml]      (ค่าเริ่มต้น 01-baseline-office.yaml)
//   MOCK_PORT=4100 (ค่าเริ่มต้น)   MOCK_STRICT_AUTH=false เพื่อไม่ตรวจ token/credential
const express = require('express');
const { loadScenarioFile } = require('./lib/scenario');
const zabbixRoutes = require('./routes/zabbix');
const omadaRoutes = require('./routes/omada');
const hikRoutes = require('./routes/hikcentral');
const controlRoutes = require('./routes/control');

function loadConfig(env = process.env) {
  return {
    port: parseInt(env.MOCK_PORT || '4100', 10),
    strictAuth: env.MOCK_STRICT_AUTH !== 'false',
    zabbixToken: env.MOCK_ZABBIX_TOKEN || 'mock-zabbix-token',
    omadacId: env.MOCK_OMADAC_ID || 'mock-omadac',
    siteId: env.MOCK_OMADA_SITE_ID || 'mock-site',
    omadaClientId: env.MOCK_OMADA_CLIENT_ID || 'mock-client',
    omadaClientSecret: env.MOCK_OMADA_CLIENT_SECRET || 'mock-secret',
    hikAppKey: env.MOCK_HIK_APP_KEY || 'mock-app-key',
    hikAppSecret: env.MOCK_HIK_APP_SECRET || 'mock-app-secret',
  };
}

function createApp({ scenarioFile = '01-baseline-office.yaml', config = loadConfig() } = {}) {
  const holder = {
    state: loadScenarioFile(scenarioFile),
    source: { file: scenarioFile },
    requests: [],
    // บันทึกเฉพาะ ระบบ + method/endpoint (ไม่เก็บ header, body หรือ secret)
    log(system, what) { this.requests.push({ t: new Date().toISOString(), system, what }); if (this.requests.length > 500) this.requests.shift(); },
  };
  const app = express();
  app.use(express.json({ limit: '1mb' }));
  app.use(zabbixRoutes(holder, config));
  app.use(omadaRoutes(holder, config));
  app.use(hikRoutes(holder, config));
  app.use(controlRoutes(holder));

  app.get('/', (req, res) => res.json({
    name: 'Mock Lab', scenario: holder.state.meta, strictAuth: config.strictAuth,
    endpoints: { zabbix: 'POST /api_jsonrpc.php', omada: '/openapi/...', hikcentral: 'POST /artemis/api/...', control: '/mock/*' },
    botEnv: {
      ZABBIX_URL: `http://<host>:${config.port}/api_jsonrpc.php`, ZABBIX_API_TOKEN: config.zabbixToken,
      OMADA_URL: `http://<host>:${config.port}`, OMADA_OMADAC_ID: config.omadacId, OMADA_SITE_ID: config.siteId,
      OMADA_CLIENT_ID: config.omadaClientId, OMADA_CLIENT_SECRET: config.omadaClientSecret,
      HIKCENTRAL_URL: `http://<host>:${config.port}`, HIKCENTRAL_APP_KEY: config.hikAppKey, HIKCENTRAL_APP_SECRET: config.hikAppSecret,
    },
  }));

  // error handler: JSON พัง/ใหญ่เกิน ฯลฯ → ตอบ JSON แทน stack trace
  app.use((err, req, res, next) => res.status(err.status || 500).json({ ok: false, error: err.message }));
  return { app, holder, config };
}

module.exports = { createApp, loadConfig };

if (require.main === module) {
  const config = loadConfig();
  let created;
  try { created = createApp({ scenarioFile: process.argv[2] || '01-baseline-office.yaml', config }); }
  catch (e) { console.error(`เริ่ม mock ไม่ได้: ${e.message}`); process.exit(1); }
  created.app.listen(config.port, () => {
    const s = created.holder.state;
    console.log(`Mock Lab → http://localhost:${config.port}  สถานการณ์: ${s.meta.name} (${s.devices.size} อุปกรณ์)  strictAuth=${config.strictAuth}`);
    console.log(`ค่า .env สำหรับบอท: GET http://localhost:${config.port}/`);
  });
}
