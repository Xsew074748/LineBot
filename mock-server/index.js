'use strict';

const express       = require('express');
const omadaRoutes   = require('./routes/omada');
const hikRoutes     = require('./routes/hikcentral');
const controlRoutes = require('./routes/control');

const app  = express();
const PORT = process.env.MOCK_PORT || 4000;

app.use(express.json());
app.use(express.urlencoded({ extended: true })); // สำหรับ HikCentral OAuth form-encoded

// ── Mount routes ────────────────────────────────────────────────────────────
app.use(omadaRoutes);
app.use(hikRoutes);
app.use(controlRoutes);

// ── Root: แสดง endpoint ที่มีทั้งหมด ──────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    name:    'IT Monitor Mock Server',
    version: '1.0.0',
    data:    { cameras: 500, aps: 50 },
    endpoints: {
      omada: [
        'POST /api/v2/hotspot/login',
        'GET  /api/v2/:siteId/eaps',
        'GET  /api/v2/:siteId/clients',
        'GET  /api/v2/:siteId/events',
      ],
      hikcentral: [
        'POST /api/v1/oauth/token',
        'GET  /api/v1/cameras[?pageNo&pageSize&areaId]',
        'GET  /api/v1/cameras/:id/status',
        'GET  /api/v1/events[?pageSize]',
      ],
      control: [
        'GET  /mock/status',
        'POST /mock/camera/outage  body:{building?,count?}',
        'POST /mock/camera/reset',
        'POST /mock/ap/outage      body:{count?,building?}',
        'POST /mock/group-outage   body:{building?,cameraCount?,apCount?}',
        'POST /mock/reset',
      ],
    },
  });
});

app.listen(PORT, () => {
  console.log('');
  console.log('┌─────────────────────────────────────────────────┐');
  console.log(`│  Mock Server running → http://localhost:${PORT}     │`);
  console.log('├─────────────────────────────────────────────────┤');
  console.log('│  Omada      POST /api/v2/hotspot/login           │');
  console.log('│             GET  /api/v2/:siteId/eaps            │');
  console.log('│             GET  /api/v2/:siteId/clients         │');
  console.log('│             GET  /api/v2/:siteId/events          │');
  console.log('│  HikCentral POST /api/v1/oauth/token             │');
  console.log('│             GET  /api/v1/cameras                 │');
  console.log('│             GET  /api/v1/cameras/:id/status      │');
  console.log('│             GET  /api/v1/events                  │');
  console.log('│  Control    GET  /mock/status                    │');
  console.log('│             POST /mock/camera/outage             │');
  console.log('│             POST /mock/camera/reset              │');
  console.log('│             POST /mock/ap/outage                 │');
  console.log('│             POST /mock/group-outage              │');
  console.log('│             POST /mock/reset                     │');
  console.log('└─────────────────────────────────────────────────┘');
  console.log('');
});
