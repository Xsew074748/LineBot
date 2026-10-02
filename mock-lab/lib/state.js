'use strict';
// สถานะอุปกรณ์จำลองในหน่วยความจำ + กฎคำนวณสถานะจริง (effective status)
//   - own status: status ที่ตั้งในไฟล์/ผ่าน API
//   - depends_on: ถ้าอุปกรณ์แม่ (เช่น switch) down ลูกทั้งหมดจะ down ตาม (ลูกโซ่) — ปิดได้ด้วย ignore_dependency
//   - flap: {period_s, down_s} สลับ down ในช่วงต้นของทุกรอบเวลา (จำลองสัญญาณล่มๆ หายๆ)
//   - zabbix_status: override สถานะที่ "Zabbix เห็น" ต่างจากระบบอื่น (จำลองข้อมูลขัดแย้งระหว่างระบบ)
const { parseTime } = require('./time');

const KINDS = ['ap', 'switch', 'gateway', 'camera', 'host'];
const STATUSES = ['up', 'down', 'unknown'];
const OMADA_KINDS = ['ap', 'switch', 'gateway'];

function macFromName(name) {
  // deterministic MAC (รูปแบบเดียวกับ Omada: ตัวพิมพ์ใหญ่คั่นด้วย -)
  let h = 2166136261;
  const bytes = [];
  for (let i = 0; i < 6; i++) {
    for (const ch of `${name}:${i}`) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
    bytes.push((h & 0xff).toString(16).padStart(2, '0').toUpperCase());
  }
  bytes[0] = (parseInt(bytes[0], 16) & 0xfe | 0x02).toString(16).padStart(2, '0').toUpperCase(); // locally administered, unicast
  return bytes.join('-');
}

class State {
  constructor() { this.reset(); }

  reset() {
    this.devices = new Map();   // name → device
    this.explicitAlerts = [];   // { host, description, priority, since, comments }
    this.history = [];          // เหตุการณ์ที่แก้แล้วแล้ว (event.get): { host, description, priority, since, resolved }
    this.loadedAt = Math.floor(Date.now() / 1000);
    this.meta = { name: '(empty)', description: '', source: null };
  }

  // ── เพิ่ม/แก้ device (validate + normalize) ─────────────────────────────────
  upsert(input, { now = this.loadedAt } = {}) {
    const d = this.normalize(input, now);
    this.devices.set(d.name, d);
    return d;
  }

  normalize(input, now) {
    if (!input || typeof input !== 'object') throw new Error('device ต้องเป็น object');
    const name = String(input.name || '').trim();
    if (!name) throw new Error('device ต้องมี name');
    if (!KINDS.includes(input.kind)) throw new Error(`${name}: kind ต้องเป็น ${KINDS.join('/')} (ได้ "${input.kind}")`);
    const status = input.status === undefined ? 'up' : input.status;
    if (!STATUSES.includes(status)) throw new Error(`${name}: status ต้องเป็น ${STATUSES.join('/')}`);
    if (input.zabbix_status !== undefined && !STATUSES.includes(input.zabbix_status)) throw new Error(`${name}: zabbix_status ไม่ถูกต้อง`);
    if (input.flap && !(input.flap.period_s > 0 && input.flap.down_s > 0 && input.flap.down_s < input.flap.period_s)) {
      throw new Error(`${name}: flap ต้องมี period_s > down_s > 0`);
    }
    const metrics = input.metrics || {};
    for (const k of ['cpu', 'memory_used', 'disk_used']) {
      if (metrics[k] !== undefined && !(metrics[k] >= 0 && metrics[k] <= 100)) throw new Error(`${name}: metrics.${k} ต้องอยู่ 0-100`);
    }
    const mirrorZabbix = input.kind === 'host' ? true : !!input.zabbix;
    return {
      name,
      kind: input.kind,
      ip: input.ip || null,
      mac: input.mac ? String(input.mac).toUpperCase().replace(/:/g, '-') : macFromName(name),
      model: input.model || null,
      location: input.location || null,
      status,
      zabbix_status: input.zabbix_status,
      depends_on: input.depends_on || null,
      ignore_dependency: !!input.ignore_dependency,
      down_since: input.down_since !== undefined && input.down_since !== null ? parseTime(input.down_since, now) : (status === 'down' ? now : null),
      flap: input.flap || null,
      // Zabbix: host จริงเป็น host เสมอ; อุปกรณ์อื่นจะถูกสะท้อนเข้า Zabbix เมื่อระบุ zabbix: true หรือ {groups: [...]}
      zabbix: mirrorZabbix ? {
        groups: (input.zabbix && input.zabbix.groups) || input.groups || (input.kind === 'camera' ? ['Camera'] : input.kind === 'host' ? ['Servers'] : ['Network']),
      } : null,
      metrics: { cpu: metrics.cpu, memory_used: metrics.memory_used, disk_used: metrics.disk_used },
      clients: Number.isFinite(input.clients) ? input.clients : 0,
      ports: Array.isArray(input.ports) ? input.ports : null,
      alerts: Array.isArray(input.alerts) ? input.alerts : [],
      comments: input.comments || '',
    };
  }

  // แก้เฉพาะฟิลด์ของอุปกรณ์ที่มีอยู่ (ใช้ทั้งใน patch: ของไฟล์ และ PATCH /mock/devices/:name)
  patch(name, set = {}) {
    const cur = this.devices.get(name);
    if (!cur) throw new Error(`ไม่พบอุปกรณ์ "${name}"`);
    const merged = { ...cur, zabbix: cur.zabbix ? { groups: cur.zabbix.groups } : undefined, ...set, metrics: { ...cur.metrics, ...(set.metrics || {}) } };
    if (set.status === 'down' && set.down_since === undefined) merged.down_since = Math.floor(Date.now() / 1000);
    if (set.status === 'up' && set.down_since === undefined) delete merged.down_since;
    return this.upsert(merged, { now: Math.floor(Date.now() / 1000) });
  }

  get(name) { return this.devices.get(name); }
  remove(name) { return this.devices.delete(name); }
  list() { return [...this.devices.values()]; }

  // ตรวจว่า depends_on ทุกตัวมีอยู่จริงและไม่วนลูป (เรียกหลังโหลดทั้งชุด)
  validateDependencies() {
    for (const d of this.devices.values()) {
      if (d.depends_on && !this.devices.has(d.depends_on)) throw new Error(`${d.name}: depends_on "${d.depends_on}" ไม่มีในชุด device`);
      const seen = new Set([d.name]);
      for (let p = d.depends_on && this.devices.get(d.depends_on); p; p = p.depends_on && this.devices.get(p.depends_on)) {
        if (seen.has(p.name)) throw new Error(`${d.name}: depends_on วนลูป (${[...seen, p.name].join(' → ')})`);
        seen.add(p.name);
      }
    }
  }

  // ── สถานะ ────────────────────────────────────────────────────────────────────
  // สถานะของตัวเอง (ไม่รวม dependency): flap ทับ status
  ownStatus(d, nowSec) {
    if (d.status === 'up' && d.flap) return (nowSec % d.flap.period_s) < d.flap.down_s ? 'down' : 'up';
    return d.status;
  }

  // สถานะ "ทางกายภาพ" (รวมอุปกรณ์แม่) — ใช้ตัดสินลูกโซ่
  physicalStatus(d, nowSec = Math.floor(Date.now() / 1000)) {
    const own = this.ownStatus(d, nowSec);
    if (own === 'down' || d.ignore_dependency) return own;
    for (let p = d.depends_on && this.devices.get(d.depends_on); p; p = p.depends_on && this.devices.get(p.depends_on)) {
      if (this.ownStatus(p, nowSec) === 'down') return 'down';
    }
    return own;
  }

  // สถานะที่แต่ละระบบ "เห็น": view = 'omada' | 'hikcentral' | 'zabbix'
  viewStatus(d, view, nowSec = Math.floor(Date.now() / 1000)) {
    if (view === 'zabbix' && d.zabbix_status !== undefined) return d.zabbix_status;
    return this.physicalStatus(d, nowSec);
  }

  // เวลาที่เริ่ม down (epoch วินาที) — ถ้าดับเพราะอุปกรณ์แม่ ใช้เวลาของแม่
  downSince(d, nowSec = Math.floor(Date.now() / 1000)) {
    if (this.ownStatus(d, nowSec) === 'down' || d.ignore_dependency) return d.down_since || this.loadedAt;
    for (let p = d.depends_on && this.devices.get(d.depends_on); p; p = p.depends_on && this.devices.get(p.depends_on)) {
      if (this.ownStatus(p, nowSec) === 'down') return p.down_since || this.loadedAt;
    }
    return d.down_since || this.loadedAt;
  }

  byKinds(kinds) { return this.list().filter((d) => kinds.includes(d.kind)); }
  inOmada() { return this.byKinds(OMADA_KINDS); }
  inHik()   { return this.byKinds(['camera']); }
  inZabbix() { return this.list().filter((d) => d.zabbix); }
}

module.exports = { State, KINDS, STATUSES, OMADA_KINDS, macFromName };
