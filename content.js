// ทำงานในโลกแยกของ extension: รับข้อมูลที่ inject.js ดักได้ ส่งให้ background เก็บ
// และรับคำสั่งจาก popup (อ่านตารางบนหน้า, วนเข้าแต่ละกลุ่มโฆษณา)
const state = { group: '', stop: false, running: false, log: [] };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
let lastCaptureAt = 0;
let captureCount = 0;

window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d || !d.__adsReader) return;
  lastCaptureAt = Date.now();
  captureCount++;
  chrome.runtime.sendMessage({
    type: 'capture',
    cap: { url: d.url, method: d.method, status: d.status, body: d.body, ts: d.ts, page: d.page, group: state.group }
  }).catch(() => {});
});

const setDebug = (on) => window.postMessage({ __adsReaderCfg: 1, debug: on }, '*');
chrome.storage.local.get('debug').then((v) => setDebug(!!v.debug)).catch(() => {});

function visible(el) {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden';
}

// อ่านตารางที่เห็นบนหน้า (สำรองเผื่อคำตอบ API ไม่ครบ) รองรับ <table> และตารางแบบ div role=row
function scrapeTables() {
  const out = [];
  document.querySelectorAll('table').forEach((t, ti) => {
    if (!visible(t)) return;
    const head = [...t.querySelectorAll('thead th')].map((x) => x.innerText.trim());
    t.querySelectorAll('tbody tr').forEach((tr) => {
      const cells = [...tr.children].map((x) => x.innerText.replace(/\s+/g, ' ').trim());
      if (!cells.some(Boolean)) return;
      const row = { _table: 'table' + ti, _group: state.group };
      cells.forEach((c, i) => { row[head[i] || 'col' + i] = c; });
      const a = tr.querySelector('a[href]');
      if (a) row._href = a.getAttribute('href');
      out.push(row);
    });
  });
  document.querySelectorAll('[role="row"]').forEach((r) => {
    if (r.closest('table') || !visible(r)) return;
    const cells = [...r.querySelectorAll('[role="cell"],[role="gridcell"],[role="columnheader"]')].map((x) => x.innerText.replace(/\s+/g, ' ').trim());
    if (cells.length > 2) out.push(Object.assign({ _table: 'aria', _group: state.group }, ...cells.map((c, i) => ({ ['col' + i]: c }))));
  });
  return out;
}

// ลิงก์ของแต่ละแถวในตารางหลัก (เช่น รายชื่อกลุ่มโฆษณา)
function rowLinks() {
  const links = [];
  document.querySelectorAll('table tbody tr').forEach((tr) => {
    if (!visible(tr)) return;
    const a = [...tr.querySelectorAll('a[href]')].find((x) => visible(x) && x.innerText.trim());
    if (a) links.push({ label: a.innerText.replace(/\s+/g, ' ').trim().slice(0, 80), el: a });
  });
  return links;
}

async function settle(maxMs) {
  const t0 = Date.now();
  await sleep(1500);
  while (Date.now() - t0 < maxMs) {
    if (Date.now() - lastCaptureAt > 2500) return true;
    await sleep(400);
  }
  return false;
}
const note = (m) => { state.log.push(new Date().toLocaleTimeString() + ' ' + m); state.log = state.log.slice(-40); };

// วนเข้าแต่ละแถว -> รอข้อมูลโหลด -> ย้อนกลับ ช้าๆ แบบคนใช้งาน
async function batch(opts) {
  if (state.running) return;
  state.running = true; state.stop = false; state.log = [];
  const startUrl = location.href;
  try {
    const n = rowLinks().length;
    if (!n) { note('ไม่พบแถวที่มีลิงก์ในตารางหน้านี้ ลองเปิดหน้ารายการกลุ่มโฆษณาก่อน'); return; }
    const from = opts.from || 0;
    const to = Math.min(n, opts.limit ? from + opts.limit : n);
    note('พบ ' + n + ' แถว จะอ่านแถวที่ ' + (from + 1) + '–' + to);
    for (let i = from; i < to && !state.stop; i++) {
      const links = rowLinks();
      if (!links[i]) { note('แถวที่ ' + (i + 1) + ' หายไป ข้าม'); continue; }
      state.group = links[i].label;
      note('(' + (i + 1) + '/' + to + ') เข้า: ' + state.group);
      const before = captureCount;
      links[i].el.click();
      const ok = await settle(20000);
      note('  ดักข้อมูลได้ ' + (captureCount - before) + ' ชุด' + (ok ? '' : ' (หมดเวลารอ)'));
      if (location.href !== startUrl) {
        history.back();
        for (let k = 0; k < 40 && !rowLinks().length; k++) await sleep(400);
        await sleep(rnd(2500, 5000));
      }
    }
    note(state.stop ? 'หยุดตามคำสั่ง' : 'เสร็จแล้ว');
  } catch (e) {
    note('ผิดพลาด: ' + e.message);
  } finally {
    state.running = false; state.group = '';
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  switch (msg.type) {
    case 'setDebug': setDebug(!!msg.on); reply({ ok: true }); break;
    case 'scrape': reply({ rows: scrapeTables() }); break;
    case 'rowCount': reply({ n: rowLinks().length }); break;
    case 'batch': batch(msg.opts || {}); reply({ ok: true }); break;
    case 'stop': state.stop = true; reply({ ok: true }); break;
    case 'status': reply({ running: state.running, log: state.log, group: state.group, captures: captureCount }); break;
    default: return false;
  }
  return true;
});
