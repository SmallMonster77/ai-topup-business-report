const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9339";
const fileUrl = "file:///Users/f4cky0u/Desktop/project/visa/index.html";
const { writeFile } = await import("node:fs/promises");

const targets = await fetch(`${endpoint}/json/list`).then(response => response.json());
let target = targets.find(item => item.type === "page");
if (!target) {
  target = await fetch(`${endpoint}/json/new?${encodeURIComponent(fileUrl)}`, { method: "PUT" }).then(response => response.json());
}

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
  const { resolve, reject } = pending.get(payload.id);
  pending.delete(payload.id);
  if (payload.error) reject(new Error(payload.error.message));
  else resolve(payload.result);
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

async function inspectViewport(label, width, height) {
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: fileUrl });
  await new Promise(resolve => setTimeout(resolve, 1200));
  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(`/private/tmp/visa-report-${label}-cdp.png`, Buffer.from(shot.data, "base64"));
  if (label === "mobile") {
    await evaluate(`document.documentElement.style.scrollBehavior = "auto"; document.getElementById("pricing").scrollIntoView()`);
    await new Promise(resolve => setTimeout(resolve, 250));
    const pricingShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile("/private/tmp/visa-report-mobile-pricing.png", Buffer.from(pricingShot.data, "base64"));
    await evaluate(`scrollTo(0, 0)`);
  }
  return evaluate(`(() => {
    const root = document.documentElement;
    const insideScroller = el => {
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const overflow = getComputedStyle(parent).overflowX;
        if (overflow === "auto" || overflow === "scroll") return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll("body *")].map(el => {
      const rect = el.getBoundingClientRect();
      return { el, tag: el.tagName, id: el.id, cls: typeof el.className === "string" ? el.className : "", left: Math.round(rect.left), right: Math.round(rect.right), width: Math.round(rect.width) };
    }).filter(item => (item.right > innerWidth + 1 || item.left < -1) && !insideScroller(item.el)).map(({ el, ...item }) => item).slice(0, 20);
    const canvas = document.getElementById("profitChart");
    const ctx = canvas.getContext("2d");
    const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] && (pixels[i] < 245 || pixels[i + 1] < 245 || pixels[i + 2] < 245)) colored++;
    }
    const before = document.getElementById("heroBreakEven").textContent;
    const fx = document.getElementById("fxRate");
    fx.value = "7.20";
    fx.dispatchEvent(new Event("input", { bubbles: true }));
    const after = document.getElementById("heroBreakEven").textContent;
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth, bodyScrollWidth: document.body.scrollWidth },
      offenders,
      products: document.querySelectorAll("#productRows tr").length,
      canvas: { width: canvas.width, height: canvas.height, coloredPixels: colored },
      calculatorChanged: before !== after,
      breakEven: { before, after },
      errors: window.__reportErrors || []
    };
  })()`);
}

const desktop = await inspectViewport("desktop", 1440, 1000);
const mobile = await inspectViewport("mobile", 390, 844);
console.log(JSON.stringify({ desktop, mobile }, null, 2));
const failed = [desktop, mobile].some(check => check.page.scrollWidth !== check.page.clientWidth || check.offenders.length || check.products !== 12 || check.canvas.coloredPixels < 1000 || !check.calculatorChanged || check.errors.length);
socket.close();
if (failed) process.exitCode = 1;
