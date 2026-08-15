import { CdpClient, listTargets } from "./lib/cdp-client.mjs";

const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9445";
const targets = await listTargets(endpoint);
const target = targets.find(entry => entry.type === "page" && entry.url.includes("detail.tmall.com/item.htm"));
if (!target) throw new Error("DETAIL_TARGET_NOT_FOUND");

const page = await CdpClient.connect(target.webSocketDebuggerUrl);
await page.send("Runtime.enable");
const result = await page.evaluate(`(() => {
  const scriptHits = Array.from(document.scripts).flatMap((script, index) => {
    const text = script.textContent || '';
    const hit = text.search(/skuBase|skuCore|sku2info|pcdetail/i);
    return hit < 0 ? [] : [{
      index,
      id: script.id,
      type: script.type,
      src: script.src,
      length: text.length,
      start: text.slice(0, 1200),
      end: text.slice(-800),
      excerpt: text.slice(Math.max(0, hit - 500), hit + 4000)
    }];
  }).slice(0, 30);
  const globals = Object.getOwnPropertyNames(window).filter(key => /data|state|detail|sku|item|config/i.test(key)).map(key => {
    let value;
    try {
      const raw = window[key];
      value = raw && typeof raw === 'object' ? { type: Object.prototype.toString.call(raw), keys: Object.keys(raw).slice(0, 80) } : String(raw).slice(0, 500);
    } catch (error) { value = String(error); }
    return { key, value };
  }).slice(0, 200);
  const resources = performance.getEntriesByType('resource').map(entry => entry.name).filter(name => /mtop|detail|sku|item/i.test(name));
  return {
    href: location.href,
    title: document.title,
    body: (document.body?.innerText || '').slice(0, 5000),
    dataVidCount: document.querySelectorAll('[data-vid]').length,
    scriptHits,
    globals,
    resources
  };
})()`);

process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
page.close();
