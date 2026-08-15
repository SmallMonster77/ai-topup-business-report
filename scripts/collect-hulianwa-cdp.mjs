import { mkdir, readFile, writeFile } from "node:fs/promises";
import { CdpClient, getBrowserInfo, listTargets, waitForTarget } from "./lib/cdp-client.mjs";

const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9445";
const catalogPath = new URL("../data/hulianwa-products.json", import.meta.url);
const outputPath = new URL("../data/hulianwa-sku-details.json", import.meta.url);
const rawDirectory = new URL("../.runtime/hulianwa-raw/", import.meta.url);

function argument(name, fallback) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : fallback;
}

const start = Number.parseInt(argument("--start", "0"), 10);
const limit = Number.parseInt(argument("--limit", "5"), 10);
const force = process.argv.includes("--force");
const loginTimeoutMs = Number.parseInt(argument("--login-timeout", "600000"), 10);
const navigationTimeoutMs = Number.parseInt(argument("--navigation-timeout", "45000"), 10);

const sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
const salesValue = value => {
  const raw = String(value || "0");
  const numeric = Number.parseFloat(raw.replace(/[^\d.]/g, "")) || 0;
  return raw.includes("万") ? numeric * 10000 : numeric;
};

function parseResponseBody(body, base64Encoded) {
  let text = base64Encoded ? Buffer.from(body, "base64").toString("utf8") : body;
  text = text.trim();
  try {
    return JSON.parse(text);
  } catch {}
  const jsonp = text.match(/^[^(]+\(([\s\S]*)\)\s*;?$/);
  if (!jsonp) return null;
  try {
    return JSON.parse(jsonp[1]);
  } catch {
    return null;
  }
}

function findSkuContainer(root) {
  const queue = [{ value: root, depth: 0 }];
  const seen = new Set();
  while (queue.length) {
    const { value, depth } = queue.shift();
    if (!value || typeof value !== "object" || seen.has(value) || depth > 12) continue;
    seen.add(value);
    if (value.skuBase && value.skuCore) return value;
    for (const child of Array.isArray(value) ? value : Object.values(value)) {
      if (child && typeof child === "object") queue.push({ value: child, depth: depth + 1 });
    }
  }
  return null;
}

function priceValue(info) {
  const candidates = [
    info?.price?.priceText,
    info?.price?.price,
    info?.priceText,
    info?.promotionPrice?.priceText,
    info?.subPrice?.priceText,
    info?.price?.promotionPrice
  ];
  for (const candidate of candidates) {
    const match = String(candidate ?? "").replace(/,/g, "").match(/\d+(?:\.\d+)?/);
    if (match) return Number.parseFloat(match[0]);
  }
  return null;
}

function skuRows(container) {
  const skuBase = container.skuBase || {};
  const skuCore = container.skuCore || {};
  const sku2info = skuCore.sku2info || {};
  const propertyLabels = new Map();

  for (const property of skuBase.props || []) {
    const pid = String(property.pid ?? property.id ?? "");
    for (const value of property.values || property.value || []) {
      const vid = String(value.vid ?? value.id ?? "");
      propertyLabels.set(`${pid}:${vid}`, `${property.name || property.propName || "规格"}:${value.name || value.valueName || vid}`);
    }
  }

  const skus = Array.isArray(skuBase.skus) ? skuBase.skus : Object.values(skuBase.skus || {});
  const rows = skus.map(sku => {
    const skuId = String(sku.skuId ?? sku.id ?? "");
    const propPath = sku.propPath || sku.propPathStr || "";
    const labels = String(propPath).split(";").filter(Boolean).map(part => propertyLabels.get(part) || part);
    const info = sku2info[skuId] || {};
    const quantity = Number.parseInt(info.quantity ?? info.stock ?? info.inventory ?? "", 10);
    return {
      skuId,
      propPath,
      label: labels.join(" / ") || sku.skuText || sku.skuName || skuId,
      disabled: Number.isFinite(quantity) ? quantity <= 0 : false,
      quantity: Number.isFinite(quantity) ? quantity : null,
      price: priceValue(info)
    };
  });

  if (!rows.length && sku2info["0"]) {
    rows.push({
      skuId: "0",
      propPath: "",
      label: "默认规格",
      disabled: false,
      quantity: null,
      price: priceValue(sku2info["0"])
    });
  }
  return rows;
}

function buildDetail(container, product, sourceUrl, captureMethod = "mtop-detail-api") {
  const rows = skuRows(container);
  const prices = rows.map(row => row.price).filter(Number.isFinite);
  const defaultPrice = priceValue(container.skuCore?.sku2info?.["0"]);
  return {
    itemId: String(container.item?.itemId || product.itemId),
    title: container.item?.title || product.title,
    soldText: container.item?.vagueSellCount || container.item?.sellCount || null,
    minPrice: defaultPrice ?? (prices.length ? Math.min(...prices) : null),
    rows,
    captureMethod,
    sourceApi: sourceUrl
  };
}

function createNetworkCapture(page) {
  const responses = new Map();
  const finished = new Set();
  const captured = new Set();
  const bodies = [];
  const pending = new Set();

  const capture = requestId => {
    const response = responses.get(requestId);
    if (!response || !finished.has(requestId) || captured.has(requestId)) return;
    captured.add(requestId);
    const task = page.send("Network.getResponseBody", { requestId }).then(payload => {
      const parsed = parseResponseBody(payload.body, payload.base64Encoded);
      bodies.push({ url: response.url, status: response.status, mimeType: response.mimeType, parsed });
    }).catch(() => {}).finally(() => pending.delete(task));
    pending.add(task);
  };

  const offResponse = page.on("Network.responseReceived", event => {
    const url = event.response?.url || "";
    if (/\/h5\/mtop\.|detail\.tmall\.com\/item\.htm/i.test(url)) {
      responses.set(event.requestId, event.response);
      capture(event.requestId);
    }
  });
  const offFinished = page.on("Network.loadingFinished", event => {
    finished.add(event.requestId);
    capture(event.requestId);
  });

  return {
    bodies,
    async settle() { await Promise.all([...pending]); },
    stop() { offResponse(); offFinished(); }
  };
}

async function pageState(page) {
  return page.evaluate(`(() => ({
    href: location.href,
    host: location.hostname,
    title: document.title,
    readyState: document.readyState,
    purchaseReady: !!document.querySelector('[class*="PurchasePanel"]'),
    body: (document.body?.innerText || '').slice(0, 1000)
  }))()`);
}

async function embeddedSkuData(page) {
  return page.evaluate(`(() => {
    const seen = new Set();
    const queue = [];
    const preferred = ['__ICE_APP_CONTEXT__', '__INITIAL_STATE__', '__ICE_APP_DATA__', '__NEXT_DATA__', '__SSR_DATA__', '__INIT_DATA__', 'g_config'];
    for (const key of preferred) {
      try { if (window[key] && typeof window[key] === 'object') queue.push({ value: window[key], depth: 0 }); } catch {}
    }
    for (const key of Object.getOwnPropertyNames(window)) {
      if (!/(?:data|state|detail|sku|item)/i.test(key)) continue;
      try { if (window[key] && typeof window[key] === 'object') queue.push({ value: window[key], depth: 0 }); } catch {}
    }
    let visited = 0;
    while (queue.length && visited < 25000) {
      const { value, depth } = queue.shift();
      if (!value || typeof value !== 'object' || seen.has(value) || depth > 10 || value instanceof Node) continue;
      seen.add(value);
      visited++;
      if (value.skuBase && value.skuCore) return value;
      let children;
      try { children = Array.isArray(value) ? value : Object.values(value); } catch { continue; }
      for (const child of children) if (child && typeof child === 'object') queue.push({ value: child, depth: depth + 1 });
    }
    return null;
  })()`);
}

async function collectProduct(page, product) {
  const capture = createNetworkCapture(page);
  const startedAt = Date.now();
  try {
    await page.send("Page.navigate", { url: `https://detail.tmall.com/item.htm?id=${product.itemId}` });
    const deadline = Date.now() + navigationTimeoutMs;
    let lastState = null;

    while (Date.now() < deadline) {
      await sleep(500);
      try {
        lastState = await pageState(page);
      } catch {
        continue;
      }
      if (lastState.host === "login.taobao.com") throw new Error("LOGIN_REQUIRED");

      await capture.settle();
      for (const response of capture.bodies) {
        const container = findSkuContainer(response.parsed);
        if (container) return buildDetail(container, product, response.url);
      }

      if (lastState.readyState === "complete" && Date.now() - startedAt > 3500) {
        const embedded = await embeddedSkuData(page).catch(() => null);
        const container = findSkuContainer(embedded);
        if (container) return buildDetail(container, product, lastState.href, "ssr-detail-data");
      }
    }
    throw new Error(`DETAIL_DATA_TIMEOUT: ${lastState?.title || product.title}`);
  } finally {
    capture.stop();
  }
}

async function waitForLogin(storePage) {
  const deadline = Date.now() + loginTimeoutMs;
  let announced = false;
  while (Date.now() < deadline) {
    const state = await storePage.evaluate(`(() => ({
      href: location.href,
      title: document.title,
      loginFrame: !!document.querySelector('iframe[src*="login.taobao.com"]'),
      body: (document.body?.innerText || '').slice(0, 800)
    }))()`).catch(() => null);
    if (state && !state.loginFrame && /互联蛙旗舰店/.test(state.body)) return;
    if (!announced) {
      console.log("WAITING_FOR_LOGIN: 请在专用 Chrome 店铺窗口扫码登录");
      announced = true;
    }
    await sleep(1500);
  }
  throw new Error("LOGIN_TIMEOUT");
}

const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
const ordered = [...catalog.products].sort((a, b) => salesValue(b.vagueSold365) - salesValue(a.vagueSold365));
const queue = ordered.slice(start, start + limit);
let stored = { results: [] };
try { stored = JSON.parse(await readFile(outputPath, "utf8")); } catch {}
const byId = new Map((stored.results || []).map(result => [String(result.itemId), result]));

await mkdir(rawDirectory, { recursive: true });
const browserInfo = await getBrowserInfo(endpoint);
const browser = await CdpClient.connect(browserInfo.webSocketDebuggerUrl);
const targets = await listTargets(endpoint);
const storeTarget = targets.find(target => target.type === "page" && target.url.includes("hulianwa.tmall.com"));
if (!storeTarget) throw new Error("STORE_TARGET_NOT_FOUND");
const storePage = await CdpClient.connect(storeTarget.webSocketDebuggerUrl);
await storePage.send("Runtime.enable");
await waitForLogin(storePage);
console.log("LOGIN_READY");

const created = await browser.send("Target.createTarget", { url: "about:blank", background: true });
const detailTarget = await waitForTarget(endpoint, created.targetId);
const detailPage = await CdpClient.connect(detailTarget.webSocketDebuggerUrl);
await detailPage.send("Page.enable");
await detailPage.send("Runtime.enable");
await detailPage.send("Network.enable", { maxTotalBufferSize: 100000000, maxResourceBufferSize: 10000000 });
await detailPage.send("Network.setCacheDisabled", { cacheDisabled: true });

async function persist() {
  const results = ordered.filter(product => byId.has(String(product.itemId))).map(product => byId.get(String(product.itemId)));
  await writeFile(outputPath, JSON.stringify({
    capturedAt: new Date().toISOString(),
    store: catalog.store,
    catalogCount: catalog.count,
    detailCount: results.filter(result => !result.error).length,
    attemptedCount: results.length,
    skuCount: results.reduce((sum, result) => sum + (result.rows?.length || 0), 0),
    results
  }, null, 2));
}

try {
  for (let index = 0; index < queue.length; index++) {
    const product = queue[index];
    const existing = byId.get(String(product.itemId));
    if (!force && existing && !existing.error && existing.rows?.length) {
      console.log(`[${start + index + 1}/${ordered.length}] ${product.itemId} SKIP ${existing.rows.length} SKU`);
      continue;
    }

    const startedAt = Date.now();
    try {
      const detail = await collectProduct(detailPage, product);
      const result = {
        ...detail,
        catalogTitle: product.title,
        catalogUrl: product.itemUrl,
        image: product.image,
        vagueSold365: product.vagueSold365,
        capturedAt: new Date().toISOString(),
        elapsedMs: Date.now() - startedAt
      };
      byId.set(String(product.itemId), result);
      await writeFile(new URL(`${product.itemId}.json`, rawDirectory), JSON.stringify(result, null, 2));
      console.log(`[${start + index + 1}/${ordered.length}] ${product.itemId} ￥${result.minPrice ?? "?"} ${result.rows.length} SKU`);
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
      console.log(`[${start + index + 1}/${ordered.length}] ${product.itemId} ERROR ${error.message}`);
      await persist();
      if (error.message === "LOGIN_REQUIRED") break;
    }
    await persist();
    await sleep(1500 + Math.floor(Math.random() * 1500));
  }
} finally {
  await persist();
  await browser.send("Target.closeTarget", { targetId: created.targetId }).catch(() => {});
  detailPage.close();
  storePage.close();
  browser.close();
}
