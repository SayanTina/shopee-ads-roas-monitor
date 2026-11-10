const $ = (id) => document.getElementById(id);
const N = window.AdsNormalize;

function download(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
const stamp = () => new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-');
const caps = async () => (await chrome.storage.local.get('caps')).caps || [];
async function tab() { return (await chrome.tabs.query({ active: true, currentWindow: true }))[0]; }
async function send(msg) {
  const t = await tab();
  try { return await chrome.tabs.sendMessage(t.id, msg); }
  catch (e) { return { error: 'ติดต่อหน้า Shopee ไม่ได้ ลองรีเฟรชหน้านั้น 1 ครั้งแล้วเปิดใหม่' }; }
}
function say(m) { $('log').textContent = m; }

async function refresh() {
  const c = await caps();
  $('count').textContent = 'ข้อมูลที่ดักไว้: ' + c.length + ' ชุด';
  const dt = (s) => (s ? new Date((+s + 7 * 3600) * 1000).toISOString().slice(0, 10) : '');
  const ps = [...new Set(c.map((x) => { const m = /from=(\d+)&to=(\d+)/.exec(x.page || ''); return m ? dt(m[1]) + ' ถึง ' + dt(m[2]) : null; }).filter(Boolean))];
  $('period').textContent = 'ช่วงวันที่ของข้อมูลที่ดักไว้: ' + (ps.length ? ps.join(' | ') : '—') + (ps.length > 1 ? ' (หลายช่วงปนกัน ควรล้างข้อมูลก่อนดึงใหม่)' : '');
  const s = await send({ type: 'status' });
  if (s && !s.error) $('log').textContent = (s.running ? '▶ กำลังทำงาน' + (s.group ? ': ' + s.group : '') + '\n' : '') + (s.log.join('\n') || '—');
}

const iso = (d) => new Date(d.getTime() + 7 * 3600e3).toISOString().slice(0, 10);   // วันที่ตามเวลาไทย
function setMonth(offset) {
  const n = new Date(Date.now() + 7 * 3600e3);
  const first = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset, 1));
  const last = new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth() + offset + 1, 0));
  $('d1').value = first.toISOString().slice(0, 10);
  $('d2').value = (offset === 0 ? n : last).toISOString().slice(0, 10);
  chrome.storage.local.set({ d1: $('d1').value, d2: $('d2').value });
}
$('lastmonth').onclick = () => setMonth(-1);
$('thismonth').onclick = () => setMonth(0);
$('setrange').onclick = async () => {
  const d1 = $('d1').value, d2 = $('d2').value;
  if (!d1 || !d2 || d1 > d2) return say('เลือกวันที่เริ่มและวันที่สิ้นสุดให้ถูกต้อง');
  await chrome.storage.local.set({ d1, d2 });
  const t = await tab();
  let u;
  try { u = new URL(t.url); } catch (e) { return say('ใช้ได้เฉพาะหน้า Shopee Ads'); }
  if (!/shopee\.co\.th$/.test(u.hostname) || !u.pathname.includes('/marketing/pas')) return say('เปิดหน้า Shopee Ads (รายการกลุ่มโฆษณา) ก่อน แล้วค่อยกดปุ่มนี้');
  u.searchParams.set('from', Math.floor(Date.parse(d1 + 'T00:00:00+07:00') / 1000));
  u.searchParams.set('to', Math.floor(Date.parse(d2 + 'T23:59:59+07:00') / 1000));
  u.searchParams.set('group', 'custom');
  await chrome.tabs.update(t.id, { url: u.toString() });
  say('โหลดหน้าใหม่ช่วง ' + d1 + ' ถึง ' + d2 + '\nรอตารางโหลด แล้วตรวจว่าตัวเลือกวันที่บนหน้าแสดงช่วงนี้ และบรรทัด "ช่วงวันที่ของข้อมูลที่ดักไว้" ด้านบนตรงกัน (ถ้าไม่ตรง ให้เลือกช่วงวันที่บนหน้าเองแล้วบอกผม)');
};
chrome.storage.local.get(['d1', 'd2']).then((v) => { if (v.d1 && v.d2) { $('d1').value = v.d1; $('d2').value = v.d2; } else setMonth(-1); });

$('save').onclick = async () => {
  const c = await caps();
  const all = N.shopeeRows(c);
  const wp = N.widestPeriod(all);
  const rows = N.inPeriod(all, wp);
  if (!rows.length) return say('ยังไม่พบข้อมูลโฆษณา ลองรีเฟรชหน้า Ads (หน้ารายการกลุ่มหรือหน้าในกลุ่ม) แล้วลองใหม่');
  download('ads_' + stamp() + '.csv', N.toCSV(rows, N.SHOPEE_COLS));
  const daily = N.dailyRows(c);
  if (daily.length) setTimeout(() => download('ads_daily_' + stamp() + '.csv', N.toCSV(daily, N.DAILY_COLS)), 400);
  const nDays = new Set(daily.filter((d) => d.scope === 'shop').map((d) => d.date)).size;
  const camp = rows.filter((r) => r.level === 'campaign'), it = rows.filter((r) => r.level === 'item');
  const sum = (a) => a.reduce((s, r) => s + r.cost, 0);
  const visited = new Set(it.map((r) => r.campaign_id));
  const miss = camp.filter((r) => !r.item_id && r.cost > 0 && !visited.has(r.campaign_id));
  const others = new Set(all.map((r) => r.period_from + '..' + r.period_to)).size - 1;
  say((wp ? 'ช่วง ' + wp.from + ' ถึง ' + wp.to + (others > 0 ? ' (ข้ามอีก ' + others + ' ช่วงที่แคบกว่า เพื่อไม่ให้นับซ้ำ)' : '') + '\n' : '') + 'บันทึกแล้ว: รายวัน ' + nDays + ' วัน (ทั้งร้าน' + ' + ' + new Set(daily.filter((d) => d.scope === 'campaign').map((d) => d.campaign_id)).size + ' กลุ่ม)\nแคมเปญ ' + camp.length + ' แถว (ค่าโฆษณา ฿' + sum(camp).toFixed(0) + ') รายสินค้า ' + it.length + ' แถว (฿' + sum(it).toFixed(0) + ')'
    + (miss.length ? '\nกลุ่มที่มีค่าโฆษณาแต่ยังไม่ได้เข้าไปอ่านรายสินค้า ' + miss.length + ' กลุ่ม:\n- ' + miss.map((r) => r.campaign_name + ' ฿' + r.cost.toFixed(0)).join('\n- ') : '\nอ่านรายสินค้าครบทุกกลุ่มที่มีค่าโฆษณา'));
};
$('scrape').onclick = async () => {
  const r = await send({ type: 'scrape' });
  if (r.error) return say(r.error);
  if (!r.rows.length) return say('ไม่พบตารางบนหน้านี้');
  download('ads_screen_' + stamp() + '.csv', N.toCSV(r.rows));
  say('บันทึกตารางบนหน้าแล้ว ' + r.rows.length + ' แถว');
};
$('batch').onclick = async () => {
  const n = await send({ type: 'rowCount' });
  if (n.error) return say(n.error);
  if (!n.n) return say('ไม่พบแถวที่มีลิงก์ในตารางหน้านี้');
  const r = await send({ type: 'batch', opts: { from: Math.max(0, +$('from').value - 1), limit: +$('limit').value } });
  say(r.error || 'เริ่มแล้ว (พบ ' + n.n + ' แถว) ปิด popup ได้ ข้อมูลจะถูกเก็บไว้ ค่อยเปิดกลับมากดบันทึก');
};
$('stop').onclick = async () => { await send({ type: 'stop' }); say('สั่งหยุดแล้ว'); };
$('rawdump').onclick = async () => { download('ads_dump_' + stamp() + '.json', JSON.stringify(await caps()), 'application/json'); };
$('clear').onclick = async () => { await chrome.runtime.sendMessage({ type: 'clear' }); refresh(); };
$('debug').onchange = async () => {
  await chrome.storage.local.set({ debug: $('debug').checked });
  await send({ type: 'setDebug', on: $('debug').checked });
};
$('ver').textContent = 'v' + chrome.runtime.getManifest().version;
chrome.storage.local.get('debug').then((v) => { $('debug').checked = !!v.debug; });
refresh(); setInterval(refresh, 4000);
