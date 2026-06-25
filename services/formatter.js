'use strict';

// ── สีธีม ──────────────────────────────────────────────────────────────────────
const COLOR = {
  blue:   '#1A73E8',
  green:  '#28A745',
  red:    '#DC3545',
  orange: '#E07B00',
  purple: '#7B2FBE',
  yellow: '#E6A817',
  teal:   '#02C39A',
  gray:   '#808080',
  white:  '#FFFFFF',
};

// ── Helpers ────────────────────────────────────────────────────────────────────
// LINE Flex Message จำกัด text component ที่ 2000 ตัวอักษร
function truncate(text, limit = 1800) {
  const s = String(text || '');
  return s.length > limit ? s.slice(0, limit) + '…' : s;
}

// LINE ไม่รับ text: "" เด็ดขาด — ใช้ '-' เป็น fallback แทน space เพื่อให้เห็นชัด
function txt(text, size = 'sm', color = '#333333', extra = {}) {
  const safe = String(text ?? '').trim() || '-';
  return { type: 'text', text: safe, size, color, ...extra };
}

// แปลง Markdown → plain text ก่อนใส่ Flex (LINE render เป็น literal ไม่ใช่ styled)
function stripMarkdown(text) {
  return String(text || '')
    .replace(/\*\*(.+?)\*\*/gs, '$1')          // **bold**
    .replace(/\*(.+?)\*/gs, '$1')               // *italic*
    .replace(/^#{1,6}\s+/gm, '')                // # Heading
    .replace(/`{3}[\s\S]*?`{3}/g, (m) => m.replace(/`/g, '').trim()) // ```block```
    .replace(/`([^`]+)`/g, '$1')                // `inline code`
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')   // [link](url)
    .replace(/^[-*+]\s+/gm, '• ')              // - list item
    .trim();
}

function sep() {
  return { type: 'separator', margin: 'sm' };
}

function vbox(bg, contents, extra = {}) {
  return { type: 'box', layout: 'vertical', backgroundColor: bg, paddingAll: '14px', ...extra, contents };
}

function hbox(contents, extra = {}) {
  return { type: 'box', layout: 'horizontal', ...extra, contents };
}

function nowTH() {
  return new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function bubble(header, body, footer = null, size = 'mega') {
  const msg = { type: 'bubble', size, header, body };
  if (footer) msg.footer = footer;
  return msg;
}

function aiFooter(analysis) {
  return vbox('#F8F9FA', [
    txt('🤖 AI วิเคราะห์', 'xs', COLOR.blue, { weight: 'bold' }),
    txt(truncate(stripMarkdown(analysis || '...')), 'xs', '#444444', { wrap: true, margin: 'sm' }),
  ], { paddingAll: '12px' });
}

function analyzeButton(actionText) {
  return vbox('#EEF2FF', [{
    type: 'button',
    action: { type: 'message', label: '🤖 วิเคราะห์ด้วย AI', text: actionText },
    style: 'primary',
    color: '#1A73E8',
    height: 'sm',
  }], { paddingAll: '10px' });
}

function resolveFooter(analysis, analyzeText) {
  if (analysis) return aiFooter(analysis);
  if (analyzeText) return analyzeButton(analyzeText);
  return null;
}

// ── Help Message ───────────────────────────────────────────────────────────────
function buildHelp(extraCmds = []) {
  const baseCmds = [
    ['📢 alert / แจ้งเตือน',  'Alert จาก Zabbix'],
    ['💻 host / เครื่อง',      'สถานะ Host ทั้งหมด'],
    ['📷 กล้อง / camera',      'สถานะกล้องทั้งหมด'],
    ['📷 กล้องดับ',             'เฉพาะกล้อง Offline'],
    ['📶 wifi / ap',            'สถานะ Access Point'],
    ['👥 client',               'จำนวน Client WiFi'],
    ['🔗 cross / ข้ามระบบ',    'วิเคราะห์ alert ข้ามระบบ'],
    ['📊 ทั้งหมด / summary',   'รวมทุก Monitor'],
    ['🧠 สรุป',                 'AI สรุปภาพรวม'],
    ['🔍 วิเคราะห์ [alert]',   'AI วิเคราะห์ละเอียด'],
    ['📜 ประวัติ',               'Alert ย้อนหลัง 24 ชม.'],
    ['🔌 status',               'Monitor ไหน Online/Offline'],
    ['❓ help / ช่วยเหลือ',     'รายการคำสั่ง'],
  ];

  const makeRows = (cmds) =>
    cmds.flatMap(([cmd, desc], i) => [
      txt(cmd,  'xs', COLOR.blue, { weight: 'bold', wrap: true, ...(i > 0 && { margin: 'md' }) }),
      txt(desc, 'xs', '#555555',  { wrap: true }),
    ]);

  const baseRows = makeRows(baseCmds);

  const authSection = extraCmds.length === 0 ? [] : [
    sep(),
    txt('🔐 การจัดการสิทธิ์', 'xs', '#888888', { margin: 'md', weight: 'bold' }),
    ...makeRows(extraCmds),
  ];

  return bubble(
    vbox(COLOR.blue, [
      txt('🤖 IT Monitor Bot', 'lg', COLOR.white, { weight: 'bold' }),
      txt('รายการคำสั่งทั้งหมด', 'xs', '#CCDDFF', { margin: 'xs' }),
    ]),
    vbox(COLOR.white, [...baseRows, ...authSection], { paddingAll: '12px' })
  );
}

// ── Alert Message ──────────────────────────────────────────────────────────────
const PRIORITY_COLOR = { 5: COLOR.purple, 4: COLOR.red, 3: COLOR.orange, 2: COLOR.yellow };

// processedData = { counts, clusters, topItems, moreCount, hiddenCount }
function buildAlerts(processedData, analysis, analyzeText = null) {
  const { counts, clusters, topItems, moreCount, hiddenCount } = processedData;
  const total  = counts.total;
  const maxSev = topItems.reduce((m, p) => Math.max(m, p.priority), 0);
  const hc     = PRIORITY_COLOR[maxSev] || (total ? COLOR.yellow : COLOR.green);

  // สรุปจำนวนแยก severity
  const summaryParts = [
    counts.disaster ? `🟣 Disaster: ${counts.disaster}` : null,
    counts.high     ? `🔴 High: ${counts.high}`         : null,
    counts.average  ? `🟠 Average: ${counts.average}`   : null,
    counts.warning  ? `🟡 Warning: ${counts.warning}`   : null,
  ].filter(Boolean);

  // แถว cluster warning
  const clusterRows = clusters.map((c) =>
    vbox('#FFF3CD', [
      txt(`⚡ ${c.zone} — ${c.count} อุปกรณ์ offline พร้อมกัน`, 'xs', '#856404', { weight: 'bold', wrap: true }),
      txt('น่าจะเป็นปัญหาต้นทาง (switch/ไฟ)', 'xxs', '#856404', { margin: 'xs' }),
    ], { margin: 'sm', paddingAll: '8px', cornerRadius: '8px' })
  );

  // รายการ Disaster + High (max 10)
  const items = topItems.map((p) => {
    const c = PRIORITY_COLOR[p.priority] || COLOR.gray;
    return vbox(c + '15', [
      hbox([
        txt(`${p.priorityIcon} ${p.priorityLabel.toUpperCase()}`, 'xxs', c, { weight: 'bold', flex: 0 }),
        txt(p.lastChange, 'xxs', '#888888', { align: 'end', flex: 1 }),
      ]),
      txt(p.description, 'sm', '#222222', { weight: 'bold', wrap: true, margin: 'xs' }),
      txt(`📍 ${p.host}`, 'xs', '#666666', { margin: 'xs' }),
    ], { margin: 'sm', paddingAll: '10px', cornerRadius: '8px' });
  });

  if (moreCount > 0) {
    items.push(txt(`… Disaster+High อีก ${moreCount} รายการ`, 'xs', COLOR.red,
      { align: 'center', margin: 'sm', weight: 'bold' }));
  }
  if (!items.length) {
    items.push(txt('✅ ไม่มีการแจ้งเตือน Disaster/High', 'sm', COLOR.green, { align: 'center' }));
  }
  if (hiddenCount > 0) {
    items.push(vbox('#F8F9FA', [
      txt(`ℹ️ ซ่อน Average/Warning อีก ${hiddenCount} รายการ`, 'xs', '#666666', { align: 'center' }),
      txt('พิมพ์ "alert warning" เพื่อดู', 'xs', COLOR.blue, { align: 'center', margin: 'xs' }),
    ], { margin: 'sm', paddingAll: '8px', cornerRadius: '6px' }));
  }

  const headerContents = [
    txt(total ? '⚠️ การแจ้งเตือนระบบ' : '✅ ระบบปกติ', 'lg', COLOR.white, { weight: 'bold' }),
    hbox([
      txt(`พบ ${total} รายการ`, 'sm', COLOR.white, { flex: 1 }),
      txt(nowTH(), 'xs', '#FFFFFF99', { align: 'end', flex: 0 }),
    ], { margin: 'sm' }),
  ];
  if (summaryParts.length) {
    headerContents.push(txt(summaryParts.join('  '), 'xs', '#FFFFFFCC', { wrap: true, margin: 'xs' }));
  }

  return bubble(
    vbox(hc, headerContents),
    vbox(COLOR.white, [...clusterRows, ...items], { spacing: 'sm', paddingAll: '12px' }),
    resolveFooter(analysis, analyzeText)
  );
}

// แสดง Average / Warning (subcommand "alert warning")
function buildAlertWarning(items) {
  const shown = items.slice(0, 15);
  const rows  = shown.map((p) => {
    const c = PRIORITY_COLOR[p.priority] || COLOR.gray;
    return vbox(c + '10', [
      hbox([
        txt(`${p.priorityIcon} ${p.priorityLabel.toUpperCase()}`, 'xxs', c, { weight: 'bold', flex: 0 }),
        txt(p.lastChange, 'xxs', '#888888', { align: 'end', flex: 1 }),
      ]),
      txt(p.description, 'xs', '#222222', { weight: 'bold', wrap: true, margin: 'xs' }),
      txt(`📍 ${p.host}`, 'xxs', '#666666', { margin: 'xs' }),
    ], { margin: 'sm', paddingAll: '8px', cornerRadius: '6px' });
  });

  if (items.length > 15) {
    rows.push(txt(`… และอีก ${items.length - 15} รายการ`, 'xs', '#888888', { align: 'center', margin: 'sm' }));
  }
  if (!items.length) {
    rows.push(txt('✅ ไม่มีการแจ้งเตือน Average/Warning', 'sm', COLOR.green, { align: 'center' }));
  }

  return bubble(
    vbox(COLOR.orange, [
      txt('🟠 Alert: Average / Warning', 'lg', COLOR.white, { weight: 'bold' }),
      hbox([
        txt(`พบ ${items.length} รายการ`, 'sm', COLOR.white, { flex: 1 }),
        txt(nowTH(), 'xs', '#FFFFFF99', { align: 'end', flex: 0 }),
      ], { margin: 'sm' }),
    ]),
    vbox(COLOR.white, rows, { spacing: 'xs', paddingAll: '12px' })
  );
}

// ── Host / Camera Message ──────────────────────────────────────────────────────
function buildHosts(hosts, analysis, title = 'สถานะ Host', icon = '💻', analyzeText = null) {
  const isOnline = (h) =>
    h.available === 1 || h.online === true || h.status === '🟢 เชื่อมต่อ';

  const total   = hosts.length;
  const online  = hosts.filter(isOnline).length;
  const offline = total - online;
  const hc      = offline ? COLOR.red : COLOR.green;

  const rows = hosts.slice(0, 10).map((h) => {
    const on  = isOnline(h);
    const statusIcon  = on ? '🟢' : '🔴';
    const rawLabel    = (h.status || '').replace(/[🟢🔴⚪❓]/g, '').trim();
    const statusLabel = rawLabel || (on ? 'เชื่อมต่อ' : 'ออฟไลน์');
    const healthSuffix = h.health ? ` · ${h.health}` : '';
    const sub  = h.groups || h.location || '';
    const dur  = h.duration ? ` (ดับ ${h.duration})` : '';

    return hbox([
      txt(statusIcon, 'md', COLOR.white, { flex: 0, gravity: 'center' }),
      { type: 'box', layout: 'vertical', margin: 'sm', flex: 1, contents: [
        txt(h.name, 'sm', '#222222', { weight: 'bold' }),
        txt(sub + dur || 'N/A', 'xxs', '#888888'),
      ]},
      txt(statusLabel + healthSuffix, 'xs', on ? COLOR.green : COLOR.red,
        { weight: 'bold', align: 'end', gravity: 'center', flex: 0 }),
    ], { margin: 'sm', paddingAll: '8px', backgroundColor: '#FAFAFA', cornerRadius: '6px' });
  });

  if (total > 10) rows.push(txt(`… และอีก ${total - 10} รายการ`, 'xs', '#888888', { align: 'center', margin: 'sm' }));
  if (!rows.length) rows.push(txt('ℹ️ ไม่พบข้อมูล', 'sm', '#888888', { align: 'center' }));

  return bubble(
    vbox(hc, [
      txt(`${icon} ${title}`, 'lg', COLOR.white, { weight: 'bold' }),
      hbox([
        txt(`ทั้งหมด ${total}`, 'xs', COLOR.white, { flex: 1 }),
        txt(nowTH(), 'xs', '#FFFFFF99', { align: 'end', flex: 0 }),
      ], { margin: 'sm' }),
      hbox([
        txt(`🟢 ${online} เชื่อมต่อ`, 'xs', COLOR.white, { flex: 1 }),
        txt(`🔴 ${offline} ไม่เชื่อมต่อ`, 'xs', COLOR.white, { flex: 1 }),
      ], { margin: 'xs' }),
    ]),
    vbox(COLOR.white, rows, { spacing: 'xs', paddingAll: '12px' }),
    resolveFooter(analysis, analyzeText)
  );
}

// ── Camera Buildings Summary ────────────────────────────────────────────────────
// สรุปกล้องแยกตามอาคาร — แต่ละแถวกดได้เพื่อดูรายละเอียดกล้องในอาคารนั้น
function buildCameraBuildings(cameras, offline, analyzeText = null) {
  const total      = cameras.length;
  const offCount   = offline.length;
  const hc         = offCount > 0 ? COLOR.red : COLOR.green;

  // จัดกลุ่มตามอาคาร — ดึง "อาคาร X" จาก location field
  const bldMap = {};
  for (const cam of cameras) {
    const m = String(cam.location || '').match(/อาคาร\s*([A-E])/i);
    if (!m) continue;
    const b = m[1].toUpperCase();
    if (!bldMap[b]) bldMap[b] = { total: 0, offline: 0 };
    bldMap[b].total++;
    if (!cam.online) bldMap[b].offline++;
  }

  const rows = Object.entries(bldMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([b, s]) => {
      const hasOff = s.offline > 0;
      const pct    = Math.round(s.offline / s.total * 100);
      return {
        type: 'box', layout: 'horizontal',
        margin: 'sm', paddingAll: '12px',
        backgroundColor: hasOff ? '#FFF5F5' : '#F0FFF4',
        cornerRadius: '8px',
        // กดแถวนี้ → ส่งข้อความ "กล้อง อาคาร X"
        action: { type: 'message', label: `อาคาร ${b}`, text: `กล้อง อาคาร ${b}` },
        contents: [
          txt(hasOff ? '🔴' : '🟢', 'lg', COLOR.white, { flex: 0, gravity: 'center' }),
          {
            type: 'box', layout: 'vertical', flex: 1, margin: 'sm',
            contents: [
              txt(`🏢 อาคาร ${b}`, 'sm', '#222222', { weight: 'bold' }),
              txt(
                hasOff
                  ? `ดับ ${s.offline} / ${s.total} ตัว (${pct}%)`
                  : `ออนไลน์ทั้งหมด ${s.total} ตัว`,
                'xs', hasOff ? COLOR.red : COLOR.green
              ),
            ],
          },
          txt('›', 'xl', '#BBBBBB', { gravity: 'center', flex: 0 }),
        ],
      };
    });

  if (!rows.length) {
    rows.push(txt('ℹ️ ไม่พบข้อมูลกล้อง', 'sm', '#888888', { align: 'center' }));
  }
  rows.push(txt('กดที่อาคารเพื่อดูรายละเอียดกล้องที่ดับ', 'xs', '#AAAAAA', {
    align: 'center', margin: 'md',
  }));

  return bubble(
    vbox(hc, [
      txt('📷 สถานะกล้อง CCTV', 'lg', COLOR.white, { weight: 'bold' }),
      hbox([
        txt(`ทั้งหมด ${total} ตัว`, 'xs', COLOR.white, { flex: 1 }),
        txt(nowTH(), 'xs', '#FFFFFF99', { align: 'end', flex: 0 }),
      ], { margin: 'sm' }),
      hbox([
        txt(`🟢 ${total - offCount} ออนไลน์`, 'xs', COLOR.white, { flex: 1 }),
        txt(`🔴 ${offCount} ออฟไลน์`, 'xs', COLOR.white, { flex: 1 }),
      ], { margin: 'xs' }),
    ]),
    vbox(COLOR.white, rows, { spacing: 'xs', paddingAll: '12px' }),
    resolveFooter(null, analyzeText)
  );
}

// ── Camera Detail (กล้องที่ดับในอาคาร) ────────────────────────────────────────
// รองรับ pagination: "กล้อง อาคาร A 2" = หน้า 2 ของอาคาร A
// เรียงจากดับนานสุด → เพิ่งดับ เพื่อให้เห็น priority ชัดขึ้น
const CAMERA_DETAIL_PAGE = 4; // 4 ตัว/หน้า — เว้นที่ให้ 🤖 icon + pagination ไม่เกิน 4500 chars

function buildCameraDetail(bldCams, offlineCams, building, page = 1, analyzeText = null) {
  const total    = bldCams.length;
  const offCount = offlineCams.length;
  const onCount  = total - offCount;
  // เรียงจากดับนานสุดก่อน (offlineTime น้อย = ดับนาน = เร่งด่วนกว่า)
  const sorted   = [...offlineCams].sort((a, b) => (a.offlineTime || 0) - (b.offlineTime || 0));
  const totalPgs = Math.max(1, Math.ceil(offCount / CAMERA_DETAIL_PAGE));
  const pg       = Math.min(Math.max(1, page), totalPgs);
  const shown    = sorted.slice((pg - 1) * CAMERA_DETAIL_PAGE, pg * CAMERA_DETAIL_PAGE);
  const hc       = offCount > 0 ? COLOR.red : COLOR.green;

  // แต่ละแถว: กดได้เพื่อส่ง "วิเคราะห์กล้อง CAM-xxx"
  const rows = shown.map(cam => {
    const floor = String(cam.location || '').match(/ชั้น\s*(\d+)/)?.[1] || '-';
    return {
      type: 'box', layout: 'horizontal',
      margin: 'sm', paddingAll: '8px',
      backgroundColor: '#FFF5F5', cornerRadius: '6px',
      action: { type: 'message', label: 'วิเคราะห์', text: `วิเคราะห์กล้อง ${cam.name}` },
      contents: [
        txt('🔴', 'md', COLOR.red, { flex: 0, gravity: 'center' }),
        { type: 'box', layout: 'vertical', flex: 1, margin: 'sm', contents: [
          txt(`${cam.name} · ชั้น ${floor}`, 'sm', '#222222', { weight: 'bold', wrap: true }),
          txt(`ดับ ${cam.duration || '-'}  ·  ${cam.offlineSince || '-'}`, 'xxs', '#888888'),
        ]},
        txt('🤖', 'sm', COLOR.blue, { gravity: 'center', flex: 0 }),
      ],
    };
  });

  if (!offCount) {
    rows.push(txt('✅ กล้องทุกตัวในอาคารนี้ออนไลน์', 'sm', COLOR.green, {
      align: 'center', weight: 'bold',
    }));
  }

  // แถว pagination (กดได้)
  if (totalPgs > 1 && pg < totalPgs) {
    rows.push({
      type: 'box', layout: 'horizontal', margin: 'sm', paddingAll: '8px',
      backgroundColor: '#EEF2FF', cornerRadius: '8px',
      action: { type: 'message', label: 'หน้าถัดไป', text: `กล้อง อาคาร ${building} ${pg + 1}` },
      contents: [
        txt(`หน้า ${pg}/${totalPgs}`, 'xs', COLOR.blue, { flex: 1 }),
        txt('ถัดไป →', 'xs', COLOR.blue, { weight: 'bold', align: 'end', flex: 0 }),
      ],
    });
  }

  return bubble(
    vbox(hc, [
      txt(`📷 กล้องดับ อาคาร ${building}`, 'lg', COLOR.white, { weight: 'bold' }),
      hbox([
        txt(`ดับ ${offCount} / ${total} ตัว`, 'xs', COLOR.white, { flex: 1 }),
        txt(nowTH(), 'xs', '#FFFFFF99', { align: 'end', flex: 0 }),
      ], { margin: 'sm' }),
      hbox([
        txt(`🟢 ${onCount} ออนไลน์`, 'xs', COLOR.white, { flex: 1 }),
        txt(`🔴 ${offCount} ออฟไลน์`, 'xs', COLOR.white, { flex: 1 }),
      ], { margin: 'xs' }),
      txt('กดที่กล้องเพื่อวิเคราะห์รายตัว', 'xxs', '#FFFFFF88', { margin: 'xs' }),
    ]),
    vbox(COLOR.white, rows, { spacing: 'xs', paddingAll: '12px' }),
    vbox('#F8F9FA', [
      {
        type: 'button',
        action: { type: 'message', label: '🏢 ดูทุกอาคาร', text: 'กล้อง' },
        style: 'secondary', height: 'sm',
      },
      {
        type: 'button',
        action: { type: 'message', label: '🤖 วิเคราะห์ทั้งหมด', text: 'วิเคราะห์กล้อง' },
        style: 'primary', color: COLOR.blue, height: 'sm',
      },
    ], { spacing: 'sm', paddingAll: '10px' })
  );
}

// ── Camera Summary (สรุป + เฉพาะตัว offline) ──────────────────────────────────
// หลักคิด: แสดงจำนวนรวม + online/offline count ก่อน แล้ว list เฉพาะตัวที่ดับ
const CAMERA_OFFLINE_LIMIT = 10; // แสดง offline สูงสุด 10 ตัว

function buildCameraSummary(cameras, offline, analysis, analyzeText = null) {
  const total        = cameras.length;
  const onlineCount  = total - offline.length;
  const offlineCount = offline.length;
  const hc           = offlineCount > 0 ? COLOR.red : COLOR.green;

  const shown     = offline.slice(0, CAMERA_OFFLINE_LIMIT);
  const remaining = offlineCount - shown.length;

  const rows = shown.map((c) => {
    const sub = c.groups || c.location || '-';
    return hbox([
      txt('🔴', 'md', COLOR.red, { flex: 0, gravity: 'center' }),
      { type: 'box', layout: 'vertical', margin: 'sm', flex: 1, contents: [
        txt(c.name, 'sm', '#222222', { weight: 'bold' }),
        txt(sub, 'xxs', '#888888'),
      ]},
    ], { margin: 'sm', paddingAll: '8px', backgroundColor: '#FFF5F5', cornerRadius: '6px' });
  });

  if (remaining > 0) {
    rows.push(txt(`… และอีก ${remaining} ตัวที่ออฟไลน์`, 'xs', COLOR.red,
      { align: 'center', margin: 'sm', weight: 'bold' }));
  }
  if (!offlineCount) {
    rows.push(txt('✅ กล้องทุกตัวออนไลน์', 'sm', COLOR.green,
      { align: 'center', weight: 'bold' }));
  }

  return bubble(
    vbox(hc, [
      txt('📷 สถานะกล้อง CCTV', 'lg', COLOR.white, { weight: 'bold' }),
      hbox([
        txt(`ทั้งหมด ${total} ตัว`, 'xs', COLOR.white, { flex: 1 }),
        txt(nowTH(), 'xs', '#FFFFFF99', { align: 'end', flex: 0 }),
      ], { margin: 'sm' }),
      hbox([
        txt(`🟢 ${onlineCount} ออนไลน์`, 'xs', COLOR.white, { flex: 1 }),
        txt(`🔴 ${offlineCount} ออฟไลน์`, 'xs', COLOR.white, { flex: 1 }),
      ], { margin: 'xs' }),
    ]),
    vbox(COLOR.white, rows, { spacing: 'xs', paddingAll: '12px' }),
    resolveFooter(analysis, analyzeText)
  );
}

// ── Offline Camera Detail (รองรับ 2000+ ตัว) ──────────────────────────────────
// total ≤ 10: แสดงทุกตัวพร้อม IP/เวลา | 11-30: 10 ตัวแรก + pagination hint
// > 30 (cameras=[]): grouped view ตามโซน/อาคาร เพื่อชี้ปัญหาต้นทาง
function buildOfflineCameras(data, cacheAgeMin = null, analyzeText = null) {
  const { cameras, total, groups, page, pageSize, totalPages } = data;
  const hc = total > 0 ? COLOR.red : COLOR.green;

  let rows = [];

  if (total === 0) {
    rows = [txt('✅ ไม่มีกล้องออฟไลน์', 'sm', COLOR.green, { align: 'center', weight: 'bold' })];

  } else if (cameras.length === 0) {
    // > 30 ตัว: grouped view
    const groupRows = groups.slice(0, 12).map((g) =>
      hbox([
        txt('🔴', 'sm', COLOR.red, { flex: 0, gravity: 'center' }),
        txt(g.location, 'sm', '#333333', { flex: 1, weight: 'bold', margin: 'sm', wrap: true }),
        txt(`${g.count} ตัว`, 'sm', COLOR.red, { weight: 'bold', align: 'end', flex: 0 }),
      ], { margin: 'xs', paddingAll: '8px', backgroundColor: '#FFF5F5', cornerRadius: '6px' })
    );
    if (groups.length > 12) {
      groupRows.push(txt(`… และอีก ${groups.length - 12} โซน`, 'xs', '#888888',
        { align: 'center', margin: 'sm' }));
    }
    rows = groupRows;

  } else {
    // ≤ 30 ตัว: detail list
    const detailRows = cameras.map((c) =>
      vbox('#FFF5F5', [
        hbox([
          txt(`🔴 ${c.name}`, 'sm', '#222222', { weight: 'bold', flex: 1, wrap: true }),
          txt(c.duration || 'N/A', 'xs', COLOR.red, { weight: 'bold', align: 'end', flex: 0 }),
        ]),
        hbox([
          txt(`📍 ${c.location || '-'}`, 'xxs', '#888888', { flex: 1, wrap: true }),
          txt(c.ip || '-', 'xxs', '#888888', { flex: 0 }),
        ], { margin: 'xs' }),
        txt(`⏱ ${c.offlineSince}`, 'xxs', '#AAAAAA', { margin: 'xs' }),
      ], { margin: 'sm', cornerRadius: '8px', paddingAll: '10px' })
    );
    if (totalPages > 1 && page < totalPages) {
      const remaining = total - page * pageSize;
      detailRows.push(
        txt(`📄 ยังมีอีก ${remaining} ตัว — พิมพ์ "กล้องดับ ${page + 1}" ดูหน้าถัดไป`,
          'xs', COLOR.orange, { align: 'center', margin: 'sm', wrap: true, weight: 'bold' })
      );
    }
    rows = detailRows;
  }

  const ageSuffix = cacheAgeMin !== null ? ` · ข้อมูล ${cacheAgeMin} นาทีที่แล้ว` : '';
  const subText   = cameras.length === 0 && total > 0
    ? `⚠️ ดับ ${total} ตัว — น่าจะเป็นปัญหาต้นทาง (switch/ไฟ)`
    : `ดับ ${total} ตัว${ageSuffix}`;

  return bubble(
    vbox(hc, [
      txt('📷 กล้องออฟไลน์', 'lg', COLOR.white, { weight: 'bold' }),
      txt(subText, 'xs', '#FFFFFF99', { margin: 'sm', wrap: true }),
    ]),
    vbox(COLOR.white, rows, { spacing: 'xs', paddingAll: '12px' }),
    analyzeText ? analyzeButton(analyzeText) : null
  );
}

// ── Summary (ทุก Monitor) ──────────────────────────────────────────────────────
function buildSummary(data, analysis, analyzeText = null) {
  const z = data.zabbix || {};
  const o = data.omada  || {};
  const h = data.hik    || {};

  function statCard(title, bg, tc, stats) {
    return vbox(bg, [
      txt(title, 'sm', tc, { weight: 'bold' }),
      hbox(stats.map(([lbl, val, c]) => ({
        type: 'box', layout: 'vertical', flex: 1, alignItems: 'center',
        contents: [
          txt(String(val), 'xxl', c, { weight: 'bold', align: 'center' }),
          txt(lbl, 'xxs', '#888888', { align: 'center' }),
        ],
      })), { margin: 'sm' }),
    ], { cornerRadius: '10px', paddingAll: '12px' });
  }

  const totalProblems = z.problems?.length || 0;
  const critProblems  = (z.problems || []).filter((p) => p.priority >= 4).length;
  const totalHosts    = z.hosts?.length || 0;
  const onlineHosts   = (z.hosts || []).filter((h2) => h2.available === 1).length;
  const totalCams     = h.cameras?.length || 0;
  const offlineCams   = (h.cameras || []).filter((c) => !c.online).length;
  const totalAPs      = o.aps?.length || 0;
  const clients       = o.clients?.total || 0;

  const overallOk = totalProblems === 0 && offlineCams === 0;
  const hc = overallOk ? COLOR.green : (critProblems ? COLOR.purple : COLOR.orange);

  const cards = [
    statCard('💻 Zabbix Host', '#F0F7FF', COLOR.blue, [
      ['ทั้งหมด', totalHosts,  '#555'],
      ['ออนไลน์', onlineHosts, COLOR.green],
      ['Alert',  totalProblems, totalProblems ? COLOR.red : COLOR.green],
    ]),
  ];

  if (totalCams > 0) cards.push(
    statCard('📷 กล้อง (HikCentral)', '#FFF4E6', COLOR.orange, [
      ['ทั้งหมด', totalCams, '#555'],
      ['ออนไลน์', totalCams - offlineCams, COLOR.green],
      ['ดับ',     offlineCams, offlineCams ? COLOR.red : COLOR.green],
    ])
  );

  if (totalAPs > 0) cards.push(
    statCard('📶 WiFi (Omada)', '#F0FFF4', COLOR.green, [
      ['AP', totalAPs, '#555'],
      ['Client', clients, COLOR.blue],
    ])
  );

  return bubble(
    vbox(hc, [
      hbox([
        txt('📊 สรุปภาพรวมระบบ', 'lg', COLOR.white, { weight: 'bold', flex: 1 }),
        txt(overallOk ? '✅ ปกติ' : '⚠️ มีปัญหา', 'sm', COLOR.white, { align: 'end', flex: 0 }),
      ]),
      txt(nowTH(), 'xs', '#FFFFFF99', { margin: 'sm' }),
    ]),
    vbox(COLOR.white, cards, { spacing: 'md', paddingAll: '14px' }),
    resolveFooter(analysis, analyzeText)
  );
}

// ── Monitor Status ─────────────────────────────────────────────────────────────
function buildStatus(statuses) {
  const rows = statuses.flatMap(({ name, ok, error }, i) => {
    const row = hbox([
      txt(ok ? '🟢' : '🔴', 'md', COLOR.white, { flex: 0 }),
      { type: 'box', layout: 'vertical', margin: 'sm', flex: 1, contents: [
        txt(name, 'sm', '#222222', { weight: 'bold' }),
        txt(ok ? 'เชื่อมต่อได้' : (error || 'ไม่ตอบสนอง'), 'xs', ok ? COLOR.green : COLOR.red),
      ]},
    ], { margin: 'sm', paddingAll: '8px', backgroundColor: '#FAFAFA', cornerRadius: '6px' });
    return i === 0 ? [row] : [sep(), row];
  });

  return bubble(
    vbox(COLOR.blue, [
      txt('🔌 สถานะ Monitor', 'lg', COLOR.white, { weight: 'bold' }),
      txt(nowTH(), 'xs', '#FFFFFF99', { margin: 'xs' }),
    ]),
    vbox(COLOR.white, rows, { paddingAll: '12px' })
  );
}

// ── AI Response ────────────────────────────────────────────────────────────────
function buildAiResponse(text) {
  return bubble(
    vbox(COLOR.blue, [txt('🤖 AI ตอบกลับ', 'md', COLOR.white, { weight: 'bold' })]),
    vbox(COLOR.white, [txt(truncate(stripMarkdown(text)), 'sm', '#333333', { wrap: true })], { paddingAll: '14px' })
  );
}

// ── User List ──────────────────────────────────────────────────────────────────
// ── Pending List (with approve buttons) ──────────────────────────────────────
function buildPendingList(pendingUsers) {
  if (!pendingUsers.length) {
    return bubble(
      vbox(COLOR.orange, [txt('⏳ รออนุมัติ', 'lg', COLOR.white, { weight: 'bold' })]),
      vbox(COLOR.white, [txt('ไม่มีผู้รออนุมัติในขณะนี้', 'sm', '#888888', { align: 'center' })],
        { paddingAll: '20px' })
    );
  }

  const shown = pendingUsers.slice(0, 8);
  const more  = pendingUsers.length - shown.length;

  const rows = shown.flatMap((u, i) => {
    const name = u.displayName || (u.id.slice(0, 12) + '…');
    const row  = hbox([
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        txt(name, 'sm', '#333333', { weight: 'bold', wrap: false }),
        txt(u.id.slice(0, 18) + '…', 'xxs', '#aaaaaa'),
        txt('รอตั้งแต่ ' + (u.addedAt?.slice(0, 10) || '?'), 'xxs', '#aaaaaa'),
      ]},
      { type: 'button', style: 'primary', color: COLOR.teal, height: 'sm',
        flex: 0, margin: 'md',
        action: { type: 'message', label: 'อนุมัติ', text: `approve:${u.id}` } },
    ], { paddingAll: '10px', backgroundColor: '#F9FFF9', cornerRadius: '8px',
         margin: i === 0 ? 'none' : 'sm', alignItems: 'center' });
    return [row];
  });

  const footer = more > 0
    ? [sep(), txt(`และอีก ${more} คน — ดูทั้งหมดในระบบ`, 'xxs', '#888888', { margin: 'sm' })]
    : [];

  return bubble(
    vbox(COLOR.orange, [txt(`⏳ รออนุมัติ (${pendingUsers.length} คน)`, 'lg', COLOR.white, { weight: 'bold' })]),
    vbox(COLOR.white, [...rows, ...footer], { paddingAll: '12px' })
  );
}

// ── Role Select Card (กด approve:id หรือ changerole:id) ───────────────────────
function buildRoleSelectCard(displayName, userId) {
  return bubble(
    vbox('#1E2761', [txt('🔑 เลือก Role', 'lg', COLOR.white, { weight: 'bold' })]),
    vbox(COLOR.white, [
      txt(displayName, 'md', '#333333', { weight: 'bold' }),
      txt(userId.slice(0, 18) + '…', 'xs', '#aaaaaa', { margin: 'xs' }),
      sep(),
      txt('กดปุ่มด้านล่างเพื่อเลือก role', 'xs', '#888888', { margin: 'sm', wrap: true }),
    ], { paddingAll: '14px' })
  );
}

// ── User List (with manage tap) ───────────────────────────────────────────────
function buildUserList(users) {
  const ROLE_COLOR = { ADMIN: COLOR.red, IT_STAFF: COLOR.blue, VIEWER: COLOR.gray, PENDING: COLOR.orange };
  const ROLE_ICON  = { ADMIN: '👑', IT_STAFF: '👔', VIEWER: '👤', PENDING: '⏳' };

  if (!users.length) {
    return bubble(
      vbox(COLOR.purple, [txt('👥 รายชื่อผู้ใช้', 'lg', COLOR.white, { weight: 'bold' })]),
      vbox(COLOR.white, [txt('ไม่มีผู้ใช้ในระบบ', 'sm', '#888888', { align: 'center' })], { paddingAll: '20px' })
    );
  }

  const shown = users.slice(0, 10);
  const more  = users.length - shown.length;

  const rows = shown.map((u, i) => {
    const name  = u.displayName || (u.id.slice(0, 12) + '…');
    const rColor = ROLE_COLOR[u.role] || COLOR.gray;
    const rIcon  = ROLE_ICON[u.role]  || '❓';
    return hbox([
      { type: 'box', layout: 'vertical', flex: 1, contents: [
        txt(name, 'sm', '#333333', { weight: 'bold', wrap: false }),
        txt(u.id.slice(0, 18) + '…', 'xxs', '#aaaaaa'),
      ]},
      txt(`${rIcon} ${u.role}`, 'xs', rColor, { weight: 'bold', align: 'end', flex: 0 }),
    ], {
      paddingAll: '10px', backgroundColor: '#FAFAFA', cornerRadius: '8px',
      margin: i === 0 ? 'none' : 'sm',
      // กดแถวเพื่อจัดการ (เปลี่ยน role / ลบ)
      action: u.role !== 'PENDING'
        ? { type: 'message', label: 'จัดการ', text: `manage:${u.id}` }
        : { type: 'message', label: 'อนุมัติ',  text: `approve:${u.id}` },
    });
  });

  const footer = more > 0
    ? [sep(), txt(`และอีก ${more} คน`, 'xxs', '#888888', { margin: 'sm' })]
    : [sep(), txt('กดชื่อเพื่อเปลี่ยน role หรืออนุมัติ', 'xxs', '#aaaaaa', { margin: 'sm' })];

  return bubble(
    vbox(COLOR.purple, [txt(`👥 รายชื่อผู้ใช้ (${users.length} คน)`, 'lg', COLOR.white, { weight: 'bold' })]),
    vbox(COLOR.white, [...rows, ...footer], { paddingAll: '12px' })
  );
}

// ── My ID Card ────────────────────────────────────────────────────────────────
function buildMyId(userId, displayName, role) {
  const ROLE_COLOR = { ADMIN: COLOR.red, IT_STAFF: COLOR.blue, VIEWER: COLOR.gray, PENDING: COLOR.orange };
  return bubble(
    vbox('#1E2761', [txt('🪪 ข้อมูลของคุณ', 'lg', COLOR.white, { weight: 'bold' })]),
    vbox(COLOR.white, [
      txt(displayName, 'md', '#333333', { weight: 'bold' }),
      sep(),
      hbox([
        txt('LINE User ID', 'xs', '#888888', { flex: 0 }),
        txt(userId, 'xs', '#333333', { weight: 'bold', wrap: true, margin: 'sm', flex: 1 }),
      ], { margin: 'sm' }),
      hbox([
        txt('Role', 'xs', '#888888', { flex: 0 }),
        txt(role, 'xs', ROLE_COLOR[role] || COLOR.gray, { weight: 'bold', align: 'end', flex: 1 }),
      ], { margin: 'sm' }),
    ], { paddingAll: '14px' })
  );
}

// ── Cross-System Correlation ───────────────────────────────────────────────────
const TYPE_ICON = { camera: '📷', ap: '📶', switch: '🔌', host: '💻', other: '🔧' };

function buildCorrelation(groups, analyzeText = null) {
  const highGroups = groups.filter((g) => g.confidence === 'high');

  // ไม่พบกลุ่มใดเลย
  if (!groups.length) {
    return bubble(
      vbox(COLOR.green, [
        txt('✅ Cross-System Correlation', 'lg', COLOR.white, { weight: 'bold' }),
        txt(nowTH(), 'xs', '#CCFFDD', { margin: 'xs' }),
      ]),
      vbox(COLOR.white, [
        txt('ไม่พบความผิดปกติแบบกลุ่ม', 'sm', '#444444', { align: 'center', weight: 'bold' }),
        txt('ใน 5 นาทีที่ผ่านมา ไม่มี alert หลายระบบในพื้นที่เดียวกัน',
          'xs', '#888888', { align: 'center', margin: 'sm', wrap: true }),
      ], { paddingAll: '20px' })
    );
  }

  const hc    = highGroups.length ? COLOR.red : COLOR.orange;
  const title = highGroups.length
    ? `🔴 ตรวจพบความผิดปกติแบบกลุ่ม — ${highGroups.length} โซน`
    : `⚠️ พบสัญญาณผิดปกติ — ${groups.length} กลุ่ม`;

  const cards = groups.slice(0, 3).map((g) => {
    const timeStr = new Date(g.startTime * 1000).toLocaleTimeString('th-TH', {
      hour: '2-digit', minute: '2-digit', second: '2-digit',
    });

    // รวมจำนวนตาม type
    const byType = {};
    for (const d of g.devices) {
      const entry = (byType[d.type] = byType[d.type] || { count: 0, sources: new Set() });
      entry.count++;
      entry.sources.add(d.source);
    }

    const typeRows = Object.entries(byType).map(([type, info]) =>
      hbox([
        txt(TYPE_ICON[type] || '🔧', 'sm', '#555555', { flex: 0 }),
        txt(`${type} × ${info.count}`, 'xs', '#333333', { flex: 1, margin: 'sm' }),
        txt([...info.sources].join(', '), 'xxs', '#999999', { align: 'end', flex: 0 }),
      ], {
        margin: 'xs', paddingAll: '6px',
        backgroundColor: '#FFF3F3', cornerRadius: '4px',
      })
    );

    const confColor = g.confidence === 'high' ? COLOR.red : COLOR.orange;
    const confLabel = g.confidence === 'high'
      ? (g.hasInfraDevice ? '🔴 สูงมาก (มีอุปกรณ์โครงสร้าง)' : '🔴 ความเชื่อมั่นสูง')
      : '🟠 ความเชื่อมั่นปานกลาง';

    return vbox('#FFF5F5', [
      hbox([
        txt(`📍 ${g.zone}`, 'sm', '#222222', { weight: 'bold', flex: 1, wrap: true }),
        txt(timeStr, 'xxs', '#888888', { align: 'end', flex: 0 }),
      ]),
      ...typeRows,
      hbox([
        txt(confLabel, 'xs', confColor, { weight: 'bold', flex: 1 }),
        txt(`${g.devices.length} อุปกรณ์`, 'xxs', '#666666', { align: 'end', flex: 0 }),
      ], { margin: 'sm' }),
    ], { margin: 'sm', cornerRadius: '8px', paddingAll: '10px' });
  });

  if (groups.length > 3) {
    cards.push(txt(`… และอีก ${groups.length - 3} กลุ่ม`, 'xs', '#888888',
      { align: 'center', margin: 'sm' }));
  }

  return bubble(
    vbox(hc, [
      txt('🔗 Cross-System Correlation', 'lg', COLOR.white, { weight: 'bold' }),
      txt(title, 'xs', '#FFFFFF99', { margin: 'sm', wrap: true }),
      txt(nowTH(), 'xs', '#FFFFFF77', { margin: 'xs' }),
    ]),
    vbox(COLOR.white, cards, { spacing: 'sm', paddingAll: '12px' }),
    resolveFooter(null, analyzeText)
  );
}

// ── Error Message ──────────────────────────────────────────────────────────────
function buildError(message) {
  const safe = (message || '').slice(0, 150);
  return bubble(
    vbox(COLOR.red, [txt('❌ เกิดข้อผิดพลาด', 'md', COLOR.white, { weight: 'bold' })]),
    vbox(COLOR.white, [
      txt('ไม่สามารถดำเนินการได้ กรุณาลองใหม่', 'sm', '#333333', { wrap: true }),
      txt(safe, 'xs', '#888888', { wrap: true, margin: 'sm' }),
    ], { paddingAll: '14px' })
  );
}

// ── Quick Reply ────────────────────────────────────────────────────────────────
// extras: array of additional quick reply items (LINE รองรับสูงสุด 13 ตัว)
function quickReply(extras = []) {
  const items = [
    { type: 'action', action: { type: 'message', label: '📢 Alert',  text: 'alert'    } },
    { type: 'action', action: { type: 'message', label: '📷 กล้อง', text: 'กล้อง'   } },
    { type: 'action', action: { type: 'message', label: '📶 WiFi',   text: 'wifi'     } },
    { type: 'action', action: { type: 'message', label: '📊 สรุป',  text: 'ทั้งหมด' } },
    { type: 'action', action: { type: 'message', label: '❓ Help',   text: 'help'     } },
    ...extras,
  ];
  return { items: items.slice(0, 13) };
}

module.exports = {
  buildHelp,
  buildAlerts,
  buildAlertWarning,
  buildHosts,
  buildCameraBuildings,
  buildCameraDetail,
  buildCameraSummary,
  buildOfflineCameras,
  buildSummary,
  buildStatus,
  buildCorrelation,
  buildAiResponse,
  buildUserList,
  buildPendingList,
  buildRoleSelectCard,
  buildMyId,
  buildError,
  quickReply,
};
