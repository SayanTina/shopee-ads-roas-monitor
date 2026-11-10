// ทำงานในหน้าเว็บ (MAIN world): ดักคำตอบ JSON ที่หน้า Shopee Ads เรียกเอง แล้วส่งต่อให้ content.js
// ไม่แก้คำขอ ไม่ยิง API เพิ่ม แค่ "อ่านสำเนา" คำตอบที่หน้าเว็บโหลดอยู่แล้ว
(function () {
  if (window.__adsReaderHooked) return;
  window.__adsReaderHooked = true;

  // ดักเฉพาะ URL ที่ดูเหมือนข้อมูลโฆษณา ถ้าเปิดโหมด debug จะดักทุก JSON
  const AD_URL = /\/(pas|ads?|marketing|mkt|campaign|report)\b|\/api\/.*(pas|ad_|campaign|report)/i;
  const MAX = 4 * 1024 * 1024;
  let debug = false;
  window.addEventListener('message', (e) => {
    if (e.source === window && e.data && e.data.__adsReaderCfg) debug = !!e.data.debug;
  });

  function send(url, method, status, text) {
    if (!text || text.length > MAX) return;
    if (text[0] !== '{' && text[0] !== '[') return;
    if (!debug && !AD_URL.test(url)) return;
    window.postMessage({ __adsReader: 1, url, method, status, body: text, ts: Date.now(), page: location.pathname + location.search }, '*');
  }

  const f = window.fetch;
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    const method = (init && init.method) || (input && input.method) || 'GET';
    return f.apply(this, arguments).then((res) => {
      try {
        res.clone().text().then((t) => send(new URL(url, location.href).href, method, res.status, t)).catch(() => {});
      } catch (e) {}
      return res;
    });
  };

  const open = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ar = { method, url };
    return open.apply(this, arguments);
  };
  const sendX = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      try {
        if (this.responseType && this.responseType !== 'text') return;
        send(new URL(this.__ar.url, location.href).href, this.__ar.method, this.status, this.responseText);
      } catch (e) {}
    });
    return sendX.apply(this, arguments);
  };
})();
