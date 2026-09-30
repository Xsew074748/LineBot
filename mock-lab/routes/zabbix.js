'use strict';
// จำลอง Zabbix JSON-RPC (POST /api_jsonrpc.php) เฉพาะ method ที่ services/zabbix.js ของบอทเรียกใช้จริง:
//   apiinfo.version · hostgroup.get · host.get · trigger.get · problem.get · item.get · history.get
// Auth: Authorization: Bearer <MOCK_ZABBIX_TOKEN> (apiinfo.version เป็น public — เหมือน Zabbix จริง)
const { Router } = require('express');
const { parseTime } = require('../lib/time');

const PRIORITY_DEFAULT = { cpu: 4, memory: 4, disk: 3, icmp: 4 };

module.exports = function zabbixRoutes(holder, cfg) {
  const router = Router();

  const err = (id, data) => ({ jsonrpc: '2.0', error: { code: -32602, message: 'Invalid params.', data }, id });
  const ok  = (id, result) => ({ jsonrpc: '2.0', result, id });

  // ── helpers ──────────────────────────────────────────────────────────────────
  function groupRegistry(state) {
    const names = [];
    for (const d of state.inZabbix()) for (const g of d.zabbix.groups) if (!names.includes(g)) names.push(g);
    return names.map((name, i) => ({ groupid: String(i + 1), name }));
  }
  function hostRecords(state) {
    const groups = groupRegistry(state);
    const now = Math.floor(Date.now() / 1000);
    return state.inZabbix().map((d, i) => {
      const st = state.viewStatus(d, 'zabbix', now);
      return {
        hostid: String(10001 + i),
        host: d.name,
        name: d.name,
        status: '0', // 0 = monitored
        groups: d.zabbix.groups.map((g) => groups.find((x) => x.name === g)),
        interfaces: [{ ip: d.ip || '', available: st === 'up' ? '1' : st === 'down' ? '2' : '0', main: '1', type: '1' }],
        inventory: { location: d.location || '' },
        _device: d,
      };
    });
  }
  const strip = (h, p) => {
    const out = { hostid: h.hostid };
    for (const f of Array.isArray(p.output) ? p.output : ['host', 'name', 'status']) if (f !== 'extend' && h[f] !== undefined) out[f] = h[f];
    if (p.output === 'extend') Object.assign(out, { host: h.host, name: h.name, status: h.status });
    if (p.selectGroups) out.groups = h.groups.map((g) => (Array.isArray(p.selectGroups) ? Object.fromEntries(p.selectGroups.map((k) => [k, g[k]])) : g));
    if (p.selectInterfaces) out.interfaces = h.interfaces.map((i) => Object.fromEntries(p.selectInterfaces.map((k) => [k, i[k]])));
    if (p.selectInventory) out.inventory = h.inventory.location ? { location: h.inventory.location } : [];
    return out;
  };
  const contains = (hay, needle) => String(hay).toLowerCase().includes(String(needle).toLowerCase());

  function methods(state) {
    const now = Math.floor(Date.now() / 1000);
    return {
      'hostgroup.get': (p) => {
        let list = groupRegistry(state);
        if (p.search && p.search.name) list = list.filter((g) => contains(g.name, [].concat(p.search.name)[0]));
        if (p.limit) list = list.slice(0, p.limit);
        return list.map((g) => (Array.isArray(p.output) ? Object.fromEntries(p.output.map((k) => [k, g[k]])) : g));
      },

      'host.get': (p) => {
        let hosts = hostRecords(state);
        if (p.groupids) {
          const ids = [].concat(p.groupids).map(String);
          hosts = hosts.filter((h) => h.groups.some((g) => ids.includes(g.groupid)));
        }
        if (p.search) {
          const checks = Object.entries(p.search).map(([field, needle]) => (h) => contains(h[field], [].concat(needle)[0]));
          hosts = hosts.filter((h) => (p.searchByAny ? checks.some((c) => c(h)) : checks.every((c) => c(h))));
        }
        if (p.hostids) hosts = hosts.filter((h) => [].concat(p.hostids).map(String).includes(h.hostid));
        if (p.sortfield === 'name') hosts.sort((a, b) => a.name.localeCompare(b.name));
        if (p.limit) hosts = hosts.slice(0, p.limit);
        return hosts.map((h) => strip(h, p));
      },

      // trigger ที่กำลัง active: ICMP ล่ม (auto) + metrics เกินเกณฑ์ (auto) + alerts ที่กำหนดเอง
      'trigger.get': (p) => {
        const hosts = hostRecords(state);
        const byName = new Map(hosts.map((h) => [h.host, h]));
        const trig = [];
        const push = (h, description, priority, since, comments) => trig.push({
          triggerid: String(20000 + trig.length + 1), description, priority: String(priority),
          lastchange: String(since), comments: comments || '', value: '1',
          hosts: [{ hostid: h.hostid, host: h.host, name: h.name }],
        });
        for (const h of hosts) {
          const d = h._device;
          if (state.viewStatus(d, 'zabbix', now) === 'down') push(h, 'Unavailable by ICMP ping', PRIORITY_DEFAULT.icmp, state.downSince(d, now), d.comments);
          const m = d.metrics;
          if (m.cpu >= 90) push(h, 'High CPU utilization (over 90% for 5m)', PRIORITY_DEFAULT.cpu, state.loadedAt - 600, `CPU util ${m.cpu}%`);
          if (m.memory_used >= 90) push(h, 'Lack of available memory (<10% of total)', PRIORITY_DEFAULT.memory, state.loadedAt - 600, `หน่วยความจำใช้ ${m.memory_used}%`);
          if (m.disk_used >= 90) push(h, 'Free disk space is less than 10% on volume /', PRIORITY_DEFAULT.disk, state.loadedAt - 600, `พื้นที่ใช้ ${m.disk_used}%`);
          for (const a of d.alerts) push(h, a.description, a.priority ?? 3, a.since !== undefined ? parseTime(a.since, state.loadedAt) : state.loadedAt, a.comments);
        }
        for (const a of state.explicitAlerts) {
          const h = byName.get(a.host);
          if (h) push(h, a.description, a.priority ?? 3, a.since !== undefined ? parseTime(a.since, state.loadedAt) : state.loadedAt, a.comments);
        }
        trig.sort((a, b) => Number(b.lastchange) - Number(a.lastchange));
        const out = p.limit ? trig.slice(0, p.limit) : trig;
        return out.map((t) => Object.fromEntries(Object.entries(t).filter(([k]) => k === 'hosts' || !Array.isArray(p.output) || p.output.includes(k))));
      },

      'problem.get': (p) => {
        const ids = p.hostids ? [].concat(p.hostids).map(String) : null;
        const res = [];
        for (const h of hostRecords(state)) {
          if (ids && !ids.includes(h.hostid)) continue;
          if (state.viewStatus(h._device, 'zabbix', now) === 'down') {
            res.push({ eventid: String(30000 + res.length + 1), clock: String(state.downSince(h._device, now)), name: 'Unavailable by ICMP ping', hosts: [{ hostid: h.hostid }] });
          }
        }
        return p.limit ? res.slice(0, p.limit) : res;
      },

      // item: 3 ตัวต่อ host ที่มี metrics — itemid = hostid*10 + (1 cpu, 2 memory pavailable, 3 disk pused)
      'item.get': (p) => {
        const ids = [].concat(p.hostids || []).map(String);
        const keys = p.filter && p.filter.key_ ? [].concat(p.filter.key_) : null;
        const items = [];
        for (const h of hostRecords(state)) {
          if (ids.length && !ids.includes(h.hostid)) continue;
          const m = h._device.metrics;
          const defs = [
            [1, 'system.cpu.util', 'CPU utilization', m.cpu],
            [2, 'vm.memory.size[pavailable]', 'Available memory in %', m.memory_used === undefined ? undefined : 100 - m.memory_used],
            [3, 'vfs.fs.size[/,pused]', 'Space utilization on /', m.disk_used],
          ];
          for (const [k, key, name, value] of defs) {
            if (value === undefined || (keys && !keys.includes(key))) continue;
            items.push({ itemid: String(Number(h.hostid) * 10 + k), key_: key, name, lastvalue: String(value), lastclock: String(now), value_type: '0', units: '%' });
          }
        }
        return items;
      },

      'history.get': (p) => {
        const item = methods(state)['item.get']({}).find((i) => i.itemid === String([].concat(p.itemids)[0]));
        return item ? [{ itemid: item.itemid, clock: item.lastclock, value: item.lastvalue }] : [];
      },
    };
  }

  router.post('/api_jsonrpc.php', (req, res) => {
    const { method, params = {}, id = 1 } = req.body || {};
    holder.log('zabbix', method || '(no method)');
    if (method === 'apiinfo.version') return res.json(ok(id, '7.0.0'));

    const auth = req.headers.authorization || '';
    if (cfg.strictAuth ? auth !== `Bearer ${cfg.zabbixToken}` : !/^Bearer\s+\S+/.test(auth)) {
      return res.json(err(id, 'Not authorized.'));
    }
    const handler = methods(holder.state)[method];
    if (!handler) return res.json({ jsonrpc: '2.0', error: { code: -32601, message: 'Method not found.', data: `Incorrect API "${String(method).split('.')[0]}".` }, id });
    try { return res.json(ok(id, handler(params))); }
    catch (e) { return res.json(err(id, e.message)); }
  });

  return router;
};
