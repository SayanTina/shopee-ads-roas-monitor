// ทำงานในโลกแยกของ extension: รับข้อมูลที่ inject.js ดักได้ ส่งให้ background เก็บ
// และรับคำสั่งจาก popup (อ่านตารางบนหน้า, วนเข้าแต่ละกลุ่มโฆษณา)
const state = { group: '', stop: false, running: false, log: [], skip: false };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
let lastCaptureAt = 0;
let captureCount = 0;

window.addEventListener('message', (e) => {
  const d = e.data;
  if (e.source !== window || !d || !d.__adsReader) return;
  lastCaptureAt = Date.now();
  if (state.skip) return;   // ช่วงเข้าหน้ากลุ่มของโหมดทีละวัน: ไม่เก็บ แต่ยังนับว่ามีข้อมูลเข้า เพื่อรอให้หน้าโหลดนิ่งก่อน
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

// ---------- โหมดดึงทีละวัน (ไม่โหลดหน้าใหม่) ----------
// เข้าแต่ละกลุ่มโฆษณาก่อน แล้วเลือกวันที่ทีละวันจากตัวเลือกวันที่ในหน้ากลุ่ม หน้าเว็บ (SPA) ยิง API ดึงข้อมูลวันนั้นเอง ไม่ต้องโหลดหน้าซ้ำ
// ตัวเลือกวันที่ไม่ตอบสนองต่อ .click() เฉยๆ ต้องส่งลำดับเมาส์ (mouseover→mouseenter→mousedown→mouseup→click) ที่ตัวเลือก
const THMON = ['มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน', 'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม'];
const fireClick = (el) => { for (const t of ['mouseover', 'mouseenter', 'mousedown', 'mouseup', 'click']) el.dispatchEvent(new MouseEvent(t, { bubbles: t !== 'mouseenter', cancelable: true, view: window })); };
const pickerRoot = () => document.querySelector('.ads-date-range-picker');
const pickerPanel = () => { const p = document.querySelector('.eds-date-picker__picker'); if (!p) return null; const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? p : null; };
const readMonth = (pn) => {
  const ls = [...pn.querySelectorAll('.eds-picker-header__label.clickable')];
  if (ls.length < 2) return null;
  const m = THMON.indexOf(ls[0].innerText.trim()), y = parseInt(ls[1].innerText, 10);
  return m < 0 || !y ? null : { y, m };
};
async function openPicker() {
  if (pickerPanel()) return true;
  const s = pickerRoot() && pickerRoot().querySelector('.eds-selector');
  if (!s) return false;
  fireClick(s);
  for (let k = 0; k < 10; k++) { await sleep(300); if (pickerPanel()) return true; }
  return false;
}
// เลือกวันเดียว (กดวันเดิมสองครั้ง = ช่วงยาว 1 วัน) day = 'YYYY-MM-DD'
async function pickDay(day) {
  const [y, m, d] = day.split('-').map(Number);
  if (!(await openPicker())) throw new Error('เปิดตัวเลือกวันที่ไม่ได้ (หน้ากลุ่มโฆษณาอาจเปลี่ยนไป)');
  for (let n = 0; n < 30; n++) {
    const ps = [...pickerPanel().querySelectorAll('.eds-date-picker-panel__date')], info = ps.map(readMonth);
    const idx = info.findIndex((i) => i && i.y === y && i.m === m - 1);
    if (idx >= 0) {
      const cell = [...ps[idx].querySelectorAll('.eds-date-table__cell')].find((c) => c.classList.contains('normal') && !c.classList.contains('out-of-month') && c.innerText.trim() === String(d));
      if (!cell) throw new Error('ไม่พบวันที่ ' + day + ' ในปฏิทิน');
      if (cell.classList.contains('disabled')) throw new Error('เลือกวันที่ ' + day + ' ไม่ได้ (วันที่ยังไม่ถึงหรือนอกช่วงที่ Shopee ให้เลือก)');
      const t = cell.querySelector('.eds-date-table__cell-inner') || cell;
      fireClick(t); await sleep(400); fireClick(t);
      return;
    }
    const cur = info[0];
    if (!cur) throw new Error('อ่านเดือนในปฏิทินไม่ได้');
    const back = (y * 12 + m - 1) < (cur.y * 12 + cur.m);
    const arrows = back ? ps[0].querySelectorAll('.eds-picker-header__prev') : ps[ps.length - 1].querySelectorAll('.eds-picker-header__next');
    const a = back ? (arrows[1] || arrows[0]) : arrows[0];   // ลูกศรเดือน (ไม่ใช่ลูกศรข้ามปีที่เป็นคู่)
    if (!a) throw new Error('ไม่พบปุ่มเลื่อนเดือน');
    fireClick(a); await sleep(400);
  }
  throw new Error('เลื่อนปฏิทินไปที่ ' + day + ' ไม่สำเร็จ');
}
const shiftDay = (day, n) => new Date(Date.parse(day + 'T00:00:00Z') + n * 86400000).toISOString().slice(0, 10);

async function batchDaily(opts) {
  if (state.running) return;
  state.running = true; state.stop = false; state.log = [];
  const days = opts.days || [], startUrl = location.href;
  try {
    const n = rowLinks().length;
    if (!n) { note('ไม่พบแถวที่มีลิงก์ในตารางหน้านี้ ลองเปิดหน้ารายการกลุ่มโฆษณาก่อน'); return; }
    const from = opts.from || 0, to = Math.min(n, opts.limit ? from + opts.limit : n);
    note('ทีละวัน ' + days.length + ' วัน (' + days[0] + ' ถึง ' + days[days.length - 1] + ') กลุ่มแถวที่ ' + (from + 1) + '–' + to + ' ของ ' + n);
    for (let i = from; i < to && !state.stop; i++) {
      const links = rowLinks();
      if (!links[i]) { note('แถวที่ ' + (i + 1) + ' หายไป ข้าม'); continue; }
      state.group = links[i].label;
      note('(' + (i + 1) + '/' + to + ') เข้ากลุ่ม: ' + state.group);
      state.skip = true;   // ข้อมูลช่วงวันที่เริ่มต้นของหน้ากลุ่มไม่ใช้ ไม่เก็บ
      links[i].el.click();
      for (let k = 0; k < 60 && !pickerRoot(); k++) await sleep(400);
      if (!pickerRoot()) { note('  ไม่พบตัวเลือกวันที่ในหน้ากลุ่ม ข้ามกลุ่มนี้'); state.skip = false; }
      else {
        await settle(20000); state.skip = false;
        let got = 0, empty = 0;
        for (let di = 0; di < days.length && !state.stop; di++) {
          const day = days[di], before = captureCount;
          try {
            await pickDay(day); await settle(20000);
            if (captureCount === before && di === 0) {   // วันแรกตรงกับวันที่หน้าแสดงอยู่แล้ว จึงไม่ยิง API ใหม่ เลือกวันอื่นก่อนแล้วกลับมา
              await pickDay(shiftDay(day, day < days[days.length - 1] ? 1 : -1)); await settle(20000);
              await pickDay(day); await settle(20000);
            }
            if (captureCount === before) { empty++; note('  ' + day + ' ไม่มีข้อมูลใหม่'); } else got++;
          } catch (e) { note('  ' + day + ' ผิดพลาด: ' + e.message); empty++; if (/เปิดตัวเลือก|อ่านเดือน|เลื่อนปฏิทิน/.test(e.message)) break; }
          chrome.storage.local.set({ job: { running: true, days, msg: 'กลุ่ม ' + (i + 1) + '/' + to + ' ' + state.group + ' · วันที่ ' + (di + 1) + '/' + days.length } });
        }
        note('  ได้ข้อมูล ' + got + ' วัน' + (empty ? ' ไม่ได้ ' + empty + ' วัน' : ''));
      }
      if (location.href !== startUrl) {
        history.back();   // การเลือกวันที่ใช้ replaceState จึงย้อนกลับครั้งเดียวก็ถึงหน้ารายการ
        for (let k = 0; k < 40 && !rowLinks().length; k++) await sleep(400);
        await sleep(rnd(2500, 5000));
      }
    }
    note(state.stop ? 'หยุดตามคำสั่ง' : 'เสร็จแล้ว');
  } catch (e) {
    note('ผิดพลาด: ' + e.message);
  } finally {
    state.running = false; state.group = ''; state.skip = false;
    chrome.storage.local.set({ job: { running: false, days: opts.days || [], msg: state.log[state.log.length - 1] || 'จบ' } });
  }
}

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  switch (msg.type) {
    case 'setDebug': setDebug(!!msg.on); reply({ ok: true }); break;
    case 'scrape': reply({ rows: scrapeTables() }); break;
    case 'rowCount': reply({ n: rowLinks().length }); break;
    case 'batch': batch(msg.opts || {}); reply({ ok: true }); break;
    case 'batchDaily': batchDaily(msg.opts || {}); reply({ ok: true }); break;
    case 'stop': state.stop = true; reply({ ok: true }); break;
    case 'status': reply({ running: state.running, log: state.log, group: state.group, captures: captureCount }); break;
    default: return false;
  }
  return true;
});
