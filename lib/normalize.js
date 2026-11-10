// แปลง JSON ที่ดักได้จาก Shopee Ads ให้เป็นตาราง (ใช้ทั้งใน popup และทดสอบด้วย node)
(function (root) {
  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function flatten(o, prefix, out) {
    for (const [k, v] of Object.entries(o)) {
      const key = prefix ? prefix + '.' + k : k;
      if (isObj(v)) flatten(v, key, out);
      else if (Array.isArray(v)) {
        if (v.every((x) => x === null || typeof x !== 'object')) out[key] = v.join('|');
        // อาร์เรย์ของออบเจ็กต์ซ้อนอยู่ข้างใน: ข้าม (ถูกดึงเป็นตารางแยกอยู่แล้ว)
      } else out[key] = v;
    }
    return out;
  }

  // หาอาร์เรย์ของออบเจ็กต์ทุกชั้นใน JSON (เช่น data.entry_list)
  function findTables(node, path, found) {
    if (Array.isArray(node)) {
      const objs = node.filter(isObj);
      if (objs.length && objs.length === node.length && Object.keys(objs[0]).length >= 3) found.push({ path, rows: objs });
      node.forEach((x, i) => { if (isObj(x) || Array.isArray(x)) findTables(x, path + '[]', found); });
    } else if (isObj(node)) {
      for (const [k, v] of Object.entries(node)) if (v && typeof v === 'object') findTables(v, path ? path + '.' + k : k, found);
    }
    return found;
  }

  function rawRows(caps) {
    const rows = [];
    for (const c of caps) {
      let j;
      try { j = JSON.parse(c.body); } catch (e) { continue; }
      const u = new URL(c.url, 'https://x');
      const tag = { _api: u.pathname, _captured_at: new Date(c.ts).toISOString(), _page: c.page || '', _group: c.group || '' };
      for (const t of findTables(j, '', [])) {
        for (const r of t.rows) rows.push(Object.assign({}, tag, { _table: t.path }, flatten(r, '', {})));
      }
    }
    return rows;
  }

  // ชื่อฟิลด์ปลายทาง -> รูปแบบชื่อคอลัมน์ที่น่าจะเป็น (เรียงตามลำดับความสำคัญ)
  const MAP = {
    item_id: [/(^|\.)item_?id$/i, /(^|\.)product_?id$/i],
    campaign_id: [/(^|\.)campaign_?id$/i, /(^|\.)ad_?id$/i],
    name: [/(^|\.)(ad_?name|campaign_?name|item_?name|product_?name|title|name)$/i],
    status: [/(^|\.)(state|status)$/i],
    expense: [/(^|\.)report\.expense$/i, /(^|\.)(expense|spend|cost)$/i],
    gmv: [/(^|\.)broad_gmv$/i, /(^|\.)gmv$/i, /(^|\.)direct_gmv$/i],
    orders: [/(^|\.)broad_order$/i, /(^|\.)order(s)?$/i, /(^|\.)direct_order$/i],
    clicks: [/(^|\.)click(s)?$/i],
    impressions: [/(^|\.)impression(s)?$/i],
    roas: [/(^|\.)broad_roi$/i, /(^|\.)roas$/i, /(^|\.)direct_roi$/i]
  };

  function pick(row, pats) {
    const keys = Object.keys(row);
    for (const p of pats) {
      const k = keys.find((x) => p.test(x) && row[x] !== '' && row[x] != null);
      if (k) return row[k];
    }
    return '';
  }

  function normalize(raw) {
    const out = [];
    for (const r of raw) {
      const n = {};
      for (const [f, pats] of Object.entries(MAP)) n[f] = pick(r, pats);
      // เก็บเฉพาะแถวที่มีตัวเลขโฆษณาจริง และระบุสินค้า/แคมเปญได้
      if ((n.expense === '' && n.gmv === '') || (n.item_id === '' && n.campaign_id === '')) continue;
      n._group = r._group; n._api = r._api; n._captured_at = r._captured_at; n._page = r._page;
      out.push(n);
    }
    // ตัดแถวซ้ำที่เกิดจากการดักซ้ำของคำขอเดียวกัน เก็บอันที่ใหม่สุด
    const seen = new Map();
    for (const n of out) seen.set([n._api, n._group, n.item_id, n.campaign_id, n.expense, n.gmv, n.clicks].join('|'), n);
    return [...seen.values()];
  }

  function toCSV(rows, cols) {
    if (!rows.length) return '';
    cols = cols || [...rows.reduce((s, r) => { Object.keys(r).forEach((k) => s.add(k)); return s; }, new Set())];
    const esc = (v) => {
      v = v == null ? '' : String(v);
      return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
    };
    return '﻿' + [cols.join(',')].concat(rows.map((r) => cols.map((c) => esc(r[c])).join(','))).join('\r\n');
  }

  // ---------- ตัวอ่านเฉพาะ Shopee Ads (โครงสร้างจริงที่ตรวจจากไฟล์ dump) ----------
  // หน่วยเงินใน API เป็น 1/100000 บาท (เช่น cost 13858918 = ฿138.59)
  const MONEY_DIV = 100000;
  const pathOf = (u) => { try { return new URL(u, 'https://x').pathname; } catch (e) { return u; } };
  const periodOf = (page) => {
    const p = new URLSearchParams((page || '').split('?')[1] || '');
    const d = (s) => (s ? new Date((s + 7 * 3600) * 1000).toISOString().slice(0, 10) : '');
    return { from: d(+p.get('from')), to: d(+p.get('to')) };
  };
  const metricRow = (rep) => ({
    cost: (rep.cost || 0) / MONEY_DIV, gmv: (rep.broad_gmv || 0) / MONEY_DIV, orders: rep.broad_order || 0,
    clicks: rep.click || 0, impressions: rep.impression || 0, roas: rep.broad_roi || 0,
    atc: rep.atc || 0, voucher: (rep.voucher_amount || 0) / MONEY_DIV
  });

  function shopeeRows(caps) {
    const rows = [], campName = {}, parsed = [];
    for (const c of caps) {
      let j; try { j = JSON.parse(c.body); } catch (e) { continue; }
      if (!j || j.code !== 0 || !j.data) continue;
      parsed.push({ c, j, path: pathOf(c.url), per: periodOf(c.page) });
    }
    for (const { j, path } of parsed) {
      if (path.endsWith('/pas/v1/product/get/') && j.data.campaign) campName[j.data.campaign.campaign_id] = j.data.campaign.name;
      if (path.endsWith('/pas/v1/homepage/query/') && j.data.entry_list)
        for (const e of j.data.entry_list) campName[e.campaign.campaign_id] = e.title;
    }
    for (const { c, j, path, per } of parsed) {
      const base = { period_from: per.from, period_to: per.to, captured_at: new Date(c.ts).toISOString() };
      if (path.endsWith('/pas/v1/homepage/query/') && j.data.entry_list) {
        for (const e of j.data.entry_list) {
          const items = ((e.mpd && e.mpd.item_list) || []).map((x) => x.item_id);
          const single = e.manual_product_ads && e.manual_product_ads.item_id;
          rows.push(Object.assign({}, base, {
            level: 'campaign', campaign_id: e.campaign.campaign_id, campaign_name: e.title, state: e.state, type: e.type,
            item_id: single || '', item_name: single ? e.title : '', member_items: items.join('|')
          }, metricRow(e.report || {})));
        }
      }
      if (path.endsWith('/product/mpd/list_item_product_performance/') && j.data.result_list) {
        const m = /manual-mpd\/(\d+)/.exec(c.page || '');
        const cid = m ? +m[1] : '';
        for (const r of j.data.result_list) {
          rows.push(Object.assign({}, base, {
            level: 'item', campaign_id: cid, campaign_name: campName[cid] || c.group || '', state: '', type: 'product_mpd',
            item_id: r.item_id, item_name: r.name, member_items: ''
          }, metricRow(r.report || {})));
        }
      }
    }
    const best = new Map();
    for (const r of rows) {
      const k = [r.level, r.campaign_id, r.item_id, r.period_from, r.period_to].join('|');
      if (!best.has(k) || best.get(k).captured_at <= r.captured_at) best.set(k, r);
    }
    return [...best.values()];
  }
  // ข้อมูลรายวัน: report/get_time_graph แบ่งเป็นช่วงเวลา (วันเดียวแบ่งทุก 15 นาที) รวมเป็นรายวันตามเวลาไทย
  // หน้ารายการ = ทั้งร้าน (scope 'shop'), หน้าในกลุ่ม = กลุ่มโฆษณานั้น (ไม่แยกรายสินค้า API ไม่ให้ข้อมูลรายวันต่อสินค้า)
  function dailyRows(caps) {
    const names = {}, buckets = new Map();
    for (const c of caps) {
      let j; try { j = JSON.parse(c.body); } catch (e) { continue; }
      if (!j || j.code !== 0 || !j.data) continue;
      const p = pathOf(c.url);
      if (p.endsWith('/pas/v1/product/get/') && j.data.campaign) names[j.data.campaign.campaign_id] = j.data.campaign.name;
      if (p.endsWith('/pas/v1/homepage/query/') && j.data.entry_list) for (const e of j.data.entry_list) names[e.campaign.campaign_id] = e.title;
    }
    for (const c of caps) {
      if (!pathOf(c.url).endsWith('/pas/v1/report/get_time_graph/')) continue;
      let j; try { j = JSON.parse(c.body); } catch (e) { continue; }
      const rb = j && j.data && j.data.report_by_time;
      if (!rb) continue;
      const m = /manual-mpd\/(\d+)/.exec(c.page || '');
      const cid = m ? m[1] : '';
      const per = periodOf(c.page);
      for (const b of rb) {
        const k = [cid, per.from, per.to, b.key].join('|');
        const prev = buckets.get(k);
        if (!prev || prev.ts <= c.ts) buckets.set(k, { ts: c.ts, cid, per, key: +b.key, met: b.metrics || {} });
      }
    }
    // ช่วงวันที่หลายช่วงอาจซ้อนกัน (เช่น 1 วัน กับ 1–9 พ.ย.) เลือกช่วงที่กว้างที่สุดต่อ (กลุ่ม, วัน) กันนับซ้ำ
    const span = (per) => (per.from && per.to ? Date.parse(per.to) - Date.parse(per.from) : -1);
    const win = new Map();
    for (const b of buckets.values()) {
      const date = new Date((b.key + 7 * 3600) * 1000).toISOString().slice(0, 10);
      const k = b.cid + '|' + date, ps = span(b.per) + '|' + b.per.from + '|' + b.per.to;
      if (!win.has(k) || win.get(k) < ps) win.set(k, ps);
      b.date = date; b.ps = ps;
    }
    const days = new Map();
    for (const b of buckets.values()) {
      const date = b.date;
      const k = b.cid + '|' + date;
      if (b.ps !== win.get(k) || span(b.per) < 0) continue;
      if (!days.has(k)) days.set(k, { scope: b.cid ? 'campaign' : 'shop', campaign_id: b.cid, campaign_name: b.cid ? (names[b.cid] || '') : 'ทั้งร้าน', date, cost: 0, gmv: 0, orders: 0, clicks: 0, impressions: 0, atc: 0 });
      const d = days.get(k), r = metricRow(b.met);
      d.cost += r.cost; d.gmv += r.gmv; d.orders += r.orders; d.clicks += r.clicks; d.impressions += r.impressions; d.atc += r.atc;
    }
    const out = [...days.values()];
    out.forEach((d) => { d.roas = d.cost > 0 ? d.gmv / d.cost : 0; });
    return out.sort((a, b) => (a.campaign_id + a.date < b.campaign_id + b.date ? -1 : 1));
  }
  const DAILY_COLS = ['scope', 'campaign_id', 'campaign_name', 'date', 'cost', 'gmv', 'orders', 'clicks', 'impressions', 'atc', 'roas'];

  // เลือกช่วงวันที่ที่กว้างที่สุด (เท่ากันเอาช่วงที่ใหม่กว่า) ใช้กันนับซ้ำเมื่อดักข้อมูลหลายช่วงปนกัน
  function widestPeriod(rows) {
    let best = null;
    for (const r of rows) {
      if (!r.period_from || !r.period_to) continue;
      const s = Date.parse(r.period_to) - Date.parse(r.period_from);
      if (!best || s > best.s || (s === best.s && r.period_to > best.to)) best = { s, from: r.period_from, to: r.period_to };
    }
    return best;
  }
  const inPeriod = (rows, p) => (p ? rows.filter((r) => r.period_from === p.from && r.period_to === p.to) : rows);

  const SHOPEE_COLS = ['level', 'period_from', 'period_to', 'campaign_id', 'campaign_name', 'state', 'type', 'item_id', 'item_name',
    'cost', 'gmv', 'orders', 'clicks', 'impressions', 'roas', 'atc', 'voucher', 'member_items', 'captured_at'];

  const api = { flatten, findTables, rawRows, normalize, toCSV, MAP, shopeeRows, SHOPEE_COLS, dailyRows, DAILY_COLS, widestPeriod, inPeriod };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.AdsNormalize = api;
})(typeof self !== 'undefined' ? self : this);
