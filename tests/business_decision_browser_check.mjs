const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9340";
const pageUrl = "http://127.0.0.1:8015/topup-business-decision-report.html";
const { writeFile } = await import("node:fs/promises");

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
  await new Promise(resolve => setTimeout(resolve, 1800));
  const screenshot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(`/private/tmp/business-decision-${label}.png`, Buffer.from(screenshot.data, "base64"));
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

    const initial = {
      gmv: document.getElementById("monthlyGmv").textContent,
      unit: document.getElementById("unitMargin").textContent,
      breakEven: document.getElementById("breakEven").textContent,
      profit: document.getElementById("monthlyProfit").textContent,
      healthy: document.getElementById("healthyOrders").textContent
    };
    document.querySelector('[data-preset="pressure"]').click();
    const pressureProfit = document.getElementById("monthlyProfit").textContent;
    const ownerCost = document.getElementById("ownerCost");
    ownerCost.value = "3000";
    ownerCost.dispatchEvent(new Event("input", { bubbles: true }));
    const ownerProfit = document.getElementById("monthlyProfit").textContent;

    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: { clientWidth: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth },
      title: document.title,
      decisionText: document.querySelector(".decision")?.textContent.trim(),
      metrics: document.querySelectorAll(".snapshot .metric").length,
      evidenceRows: document.querySelectorAll("#evidence tbody tr").length,
      scenarioRows: document.querySelectorAll("#economics .table-wrap tbody tr").length,
      roles: document.querySelectorAll(".role").length,
      products: document.querySelectorAll(".product").length,
      loadedImages: [...document.querySelectorAll(".product img")].filter(image => image.complete && image.naturalWidth > 0).length,
      phases: document.querySelectorAll(".phase").length,
      gates: document.querySelectorAll(".gate").length,
      risks: document.querySelectorAll(".risk").length,
      checks: document.querySelectorAll(".check").length,
      initial,
      pressureProfit,
      ownerProfit,
      offenders,
      errors: window.__decisionErrors || []
    };
  })()`);
}

const desktop = await inspect("desktop", 1440, 1000);
const mobile = await inspect("mobile", 390, 844);
console.log(JSON.stringify({ desktop, mobile }, null, 2));

const failed = [desktop, mobile].some(result =>
  result.page.clientWidth !== result.page.scrollWidth ||
  result.offenders.length ||
  !result.decisionText.includes("有条件启动") ||
  result.metrics !== 6 ||
  result.evidenceRows !== 6 ||
  result.scenarioRows !== 5 ||
  result.roles !== 3 ||
  result.products !== 5 ||
  result.loadedImages !== 5 ||
  result.phases !== 3 ||
  result.gates !== 3 ||
  result.risks !== 6 ||
  result.checks !== 6 ||
  result.initial.gmv !== "¥198,000" ||
  result.initial.breakEven !== "956 单" ||
  result.initial.profit !== "¥4,100" ||
  result.initial.healthy !== "2,747 单" ||
  result.pressureProfit !== "-¥7,300" ||
  result.ownerProfit !== "-¥10,300" ||
  result.errors.length
);
socket.close();
if (failed) process.exitCode = 1;
