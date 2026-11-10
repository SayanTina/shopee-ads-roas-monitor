// เก็บข้อมูลที่ดักได้ไว้ใน chrome.storage.local จนกว่าผู้ใช้จะกดล้าง
// เก็บเฉพาะ API ที่ใช้จริง (ยกเว้นเปิดโหมดตรวจสอบ) และตัดซ้ำ เพื่อไม่ให้ข้อมูลกลุ่มแรกๆ ถูกดันทิ้งตอนวนอ่านหลายกลุ่ม
const KEY = 'caps';
const MAX_ITEMS = 600;
const WANT = /\/pas\/v1\/(homepage\/query|product\/get|product\/mpd\/list_item_product_performance|report\/get_time_graph)\/$/;
let queue = Promise.resolve();

const pathOf = (u) => { try { return new URL(u).pathname; } catch (e) { return u; } };
function hash(s) { let h = 5381; for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0; return h; }

chrome.runtime.onMessage.addListener((msg, _s, reply) => {
  if (msg.type === 'capture') {
    queue = queue.then(async () => {
      const { [KEY]: caps = [], debug } = await chrome.storage.local.get([KEY, 'debug']);
      const cap = msg.cap;
      if (!debug && !WANT.test(pathOf(cap.url))) return;
      cap.key = pathOf(cap.url) + '|' + cap.page + '|' + hash(cap.body);
      const i = caps.findIndex((c) => c.key === cap.key);
      if (i >= 0) caps.splice(i, 1);   // ข้อมูลเดิมซ้ำ เก็บอันใหม่
      caps.push(cap);
      while (caps.length > MAX_ITEMS) caps.shift();
      await chrome.storage.local.set({ [KEY]: caps });
      await chrome.action.setBadgeText({ text: String(caps.length) });
    });
    return false;
  }
  if (msg.type === 'clear') {
    queue = queue.then(async () => {
      await chrome.storage.local.set({ [KEY]: [] });
      await chrome.action.setBadgeText({ text: '' });
      reply({ ok: true });
    });
    return true;
  }
  return false;
});
