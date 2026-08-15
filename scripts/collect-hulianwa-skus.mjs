import { readFile, writeFile } from "node:fs/promises";

const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9445";
const catalogPath = new URL("../data/hulianwa-products.json", import.meta.url);
const outputPath = new URL("../data/hulianwa-sku-details.json", import.meta.url);
const batchStart = Number.parseInt(process.argv[2] || "0", 10);
const batchSize = Number.parseInt(process.argv[3] || "5", 10);

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const salesValue = value => {
  const raw = String(value || "0");
  const numeric = Number.parseFloat(raw.replace(/[^\d.]/g, "")) || 0;
  return raw.includes("万") ? numeric * 10000 : numeric;
};
const ordered = [...catalog.products].sort((a, b) =>
  salesValue(b.vagueSold365) - salesValue(a.vagueSold365)
);
const queue = ordered.slice(batchStart, batchStart + batchSize);

let stored = { capturedAt: null, results: [] };
try {
  stored = JSON.parse(await readFile(outputPath, "utf8"));
} catch {}
const byId = new Map(stored.results.map(result => [String(result.itemId), result]));

const targets = await fetch(`${endpoint}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === "page" && item.url.includes("detail.tmall.com/item.htm"))
  || targets.find(item => item.type === "page" && item.url.includes("tmall.com"));
if (!target) throw new Error("Tmall page target not found");

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let sequence = 0;
const pending = new Map();
socket.addEventListener("message", event => {
  const payload = JSON.parse(event.data);
  if (!payload.id || !pending.has(payload.id)) return;
  const request = pending.get(payload.id);
  pending.delete(payload.id);
  if (payload.error) request.reject(new Error(payload.error.message));
  else request.resolve(payload.result);
});

function send(method, params = {}) {
  const id = ++sequence;
  socket.send(JSON.stringify({ id, method, params }));
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}

async function evaluate(expression) {
  const result = await send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitForItem(itemId) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    let state;
    try {
      state = await evaluate(`(() => {
        const price = [...document.querySelectorAll('body *')]
          .map(node => ({ node, text: (node.innerText || node.textContent || '').trim() }))
          .find(({ node, text }) => node.offsetParent !== null && /^￥\\s*\\d+(?:\\.\\d+)?(?:\\s*起)?$/.test(text) && node.childElementCount <= 4)?.text || null;
        return {
          id: new URL(location.href).searchParams.get('id'),
          ready: !!document.querySelector('[class*="PurchasePanel"]'),
          price,
          title: document.title,
          loginPage: location.hostname === 'login.taobao.com'
        };
      })()`);
    } catch (error) {
      if (/navigat|context|target/i.test(error.message)) {
        await new Promise(resolve => setTimeout(resolve, 600));
        continue;
      }
      throw error;
    }
    if (state.loginPage) throw new Error("LOGIN_REQUIRED");
    if (state.id === itemId && state.ready && state.price) return state;
    await new Promise(resolve => setTimeout(resolve, 600));
  }
  throw new Error(`Timed out waiting for item ${itemId}`);
}

const collectExpression = `(async () => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const priceText = () => [...document.querySelectorAll('body *')]
    .map(node => ({ node, text: (node.innerText || node.textContent || '').trim() }))
    .find(({ node, text }) => node.offsetParent !== null && /^￥\\s*\\d+(?:\\.\\d+)?(?:\\s*起)?$/.test(text) && node.childElementCount <= 4)?.text || null;
  const priceNumber = () => Number.parseFloat((priceText() || '').replace(/[^\\d.]/g, '')) || null;
  const all = [...document.querySelectorAll('[data-vid]')]
    .filter(node => String(node.className || '').split(/\\s+/)[0].startsWith('valueItem--'));
  const unique = [...new Map(all.map(node => [node.dataset.vid, node])).values()];
  const startingPrice = priceNumber();
  const rows = [];
  for (const node of unique) {
    const label = node.querySelector('[class*="valueItemText"]')?.getAttribute('title')
      || node.querySelector('[class*="valueItemText"]')?.textContent?.trim()
      || node.textContent.trim();
    const disabled = node.dataset.disabled === 'true';
    if (!disabled) {
      node.scrollIntoView({ block: 'center' });
      node.click();
      let previous = null;
      let stable = 0;
      for (let tick = 0; tick < 12 && stable < 2; tick++) {
        await wait(150);
        const current = priceNumber();
        stable = current === previous && current !== null ? stable + 1 : 0;
        previous = current;
      }
    }
    rows.push({
      vid: node.dataset.vid,
      label,
      disabled,
      price: priceNumber()
    });
  }
  const soldText = [...document.querySelectorAll('body *')]
    .find(node => node.childElementCount === 0 && /^已售 /.test(node.textContent || ''))?.textContent?.trim() || null;
  return {
    itemId: new URL(location.href).searchParams.get('id'),
    title: document.querySelector('[class*="mainTitle"]')?.textContent?.trim()
      || document.title.replace(/-tmall.com天猫$/, ''),
    soldText,
    minPrice: startingPrice,
    rows
  };
})()`;

async function persist() {
  const results = ordered
    .filter(product => byId.has(String(product.itemId)))
    .map(product => byId.get(String(product.itemId)));
  await writeFile(outputPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    store: catalog.store,
    catalogCount: catalog.count,
    detailCount: results.length,
    results
  }, null, 2));
}

for (let index = 0; index < queue.length; index++) {
  const product = queue[index];
  const startedAt = Date.now();
  try {
    await send("Page.navigate", { url: `https://detail.tmall.com/item.htm?id=${product.itemId}` });
    await waitForItem(String(product.itemId));
    const detail = await evaluate(collectExpression);
    byId.set(String(product.itemId), {
      ...detail,
      catalogTitle: product.title,
      catalogUrl: product.itemUrl,
      image: product.image,
      vagueSold365: product.vagueSold365,
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt
    });
    console.log(`[${batchStart + index + 1}/${ordered.length}] ${product.itemId} ￥${detail.minPrice} ${detail.rows.length} SKU`);
  } catch (error) {
    byId.set(String(product.itemId), {
      itemId: product.itemId,
      catalogTitle: product.title,
      catalogUrl: product.itemUrl,
      image: product.image,
      vagueSold365: product.vagueSold365,
      error: error.message,
      capturedAt: new Date().toISOString(),
      elapsedMs: Date.now() - startedAt
    });
    console.log(`[${batchStart + index + 1}/${ordered.length}] ${product.itemId} ERROR ${error.message}`);
    if (error.message === "LOGIN_REQUIRED") {
      await persist();
      socket.close();
      process.exitCode = 2;
      break;
    }
  }
  await persist();
  await new Promise(resolve => setTimeout(resolve, 900));
}

if (socket.readyState === WebSocket.OPEN) socket.close();
