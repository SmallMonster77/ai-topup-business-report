const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9339";
const pageUrl = "http://127.0.0.1:8015/hulianwa-competitor-analysis.html";
const { readFile, writeFile } = await import("node:fs/promises");
const skuData = JSON.parse(await readFile(new URL("../data/hulianwa-sku-details.json", import.meta.url), "utf8"));
const expectedSkuRows = skuData.skuCount;
const expectedDetailCount = skuData.detailCount;

const targets = await fetch(`${endpoint}/json/list`).then(response => response.json());
const target = targets.find(item => item.type === "page");
if (!target) throw new Error("Report browser target not found");

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
  const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function inspect(label, width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 600 });
  await send("Page.navigate", { url: pageUrl });
  await new Promise(resolve => setTimeout(resolve, 3500));
  const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(`/private/tmp/hulianwa-${label}.png`, Buffer.from(screenshot.data, "base64"));
  return evaluate(`(() => {
    const insideScroller = element => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        if (["auto", "scroll"].includes(getComputedStyle(parent).overflowX)) return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll("body *")].map(element => {
      const rect = element.getBoundingClientRect();
      return { element, tag: element.tagName, id: element.id, cls: typeof element.className === "string" ? element.className : "", left: Math.round(rect.left), right: Math.round(rect.right) };
    }).filter(item => (item.right > innerWidth + 1 || item.left < -1) && !insideScroller(item.element)).map(({ element, ...item }) => item).slice(0, 15);
    const beforeProfit = document.querySelector("#profitRows tr td:nth-child(5)")?.textContent;
    const fx = document.getElementById("fx");
    fx.value = "7.20";
    fx.dispatchEvent(new Event("input", { bubbles: true }));
    const afterProfit = document.querySelector("#profitRows tr td:nth-child(5)")?.textContent;
    const search = document.getElementById("catalogSearch");
    search.value = "Cursor";
    search.dispatchEvent(new Event("input", { bubbles: true }));
    const cursorRows = document.querySelectorAll("#catalogRows tr").length;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
      title: document.title,
      topCards: document.querySelectorAll("#topProducts .product-card").length,
      loadedImages: [...document.querySelectorAll("#topProducts img")].filter(image => image.complete && image.naturalWidth > 0).length,
      officialRows: document.querySelectorAll("#officialRows tr").length,
      profitRows: document.querySelectorAll("#profitRows tr").length,
      skuRows: document.querySelectorAll("#skuRows tr").length,
      skuCount: document.getElementById("skuCount").textContent,
      detailMetric: document.getElementById("metricDetails").textContent,
      skuMetric: document.getElementById("metricSkus").textContent,
      initialCatalogCount: document.getElementById("catalogCount").textContent,
      cursorRows,
      fxChanged: beforeProfit !== afterProfit,
      offenders,
      errors: window.__hulianwaErrors || []
    };
  })()`);
}

const desktop = await inspect("desktop", 1440, 1000);
const mobile = await inspect("mobile", 390, 844);
console.log(JSON.stringify({ desktop, mobile }, null, 2));

const failed = [desktop, mobile].some(result =>
  result.page.clientWidth !== result.page.scrollWidth ||
  result.offenders.length ||
  result.topCards !== 12 ||
  result.loadedImages < 8 ||
  result.officialRows !== 44 ||
  result.profitRows !== 20 ||
  result.skuRows !== expectedSkuRows ||
  !result.skuCount.startsWith(`${expectedSkuRows} 条`) ||
  result.detailMetric !== `${expectedDetailCount}/211` ||
  result.skuMetric !== expectedSkuRows.toLocaleString("zh-CN") ||
  !result.initialCatalogCount.includes("全店 211") ||
  result.cursorRows < 2 ||
  !result.fxChanged ||
  result.errors.length
);
socket.close();
if (failed) process.exitCode = 1;
