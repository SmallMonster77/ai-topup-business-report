const endpoint = process.env.CHROME_ENDPOINT || "http://127.0.0.1:9341";
const fileUrl = "file:///Users/f4cky0u/Desktop/project/visa/nigeria-gift-card-report.html";
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
  await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: width < 500 });
  await send("Page.navigate", { url: fileUrl });
  await new Promise(resolve => setTimeout(resolve, 1400));

  const shot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
  await writeFile(`/private/tmp/nigeria-gift-card-${label}.png`, Buffer.from(shot.data, "base64"));

  if (label === "mobile") {
    await evaluate(`document.documentElement.style.scrollBehavior = "auto"; document.getElementById("economics").scrollIntoView()`);
    await new Promise(resolve => setTimeout(resolve, 300));
    const calcShot = await send("Page.captureScreenshot", { format: "png", fromSurface: true });
    await writeFile("/private/tmp/nigeria-gift-card-mobile-calculator.png", Buffer.from(calcShot.data, "base64"));
  }

  return evaluate(`(() => {
    const root = document.documentElement;
    const insideScroller = el => {
      for (let parent = el.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const style = getComputedStyle(parent);
        if (["auto", "scroll"].includes(style.overflowX)) return true;
      }
      return false;
    };
    const offenders = [...document.querySelectorAll("body *")].map(el => {
      const rect = el.getBoundingClientRect();
      return { el, tag: el.tagName, id: el.id, cls: typeof el.className === "string" ? el.className : "", left: Math.round(rect.left), right: Math.round(rect.right) };
    }).filter(item => (item.right > innerWidth + 1 || item.left < -1) && !insideScroller(item.el)).map(({ el, ...item }) => item).slice(0, 20);
    const clippedText = [...document.querySelectorAll("button, .btn, .hero-stat, .metric, .gate")].filter(el => el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1).map(el => ({ tag: el.tagName, cls: el.className, text: el.textContent.trim().slice(0, 60) })).slice(0, 20);
    const canvas = document.getElementById("sensitivityChart");
    const pixels = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
    let colored = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] && (pixels[i] < 235 || pixels[i + 1] < 235 || pixels[i + 2] < 235)) colored++;
    }
    const before = document.getElementById("netContribution").textContent;
    const rate = document.getElementById("localRate");
    rate.value = "1200";
    rate.dispatchEvent(new Event("input", { bubbles: true }));
    const after = document.getElementById("netContribution").textContent;
    document.querySelector('[data-preset="stress"]').click();
    const presetApplied = document.getElementById("fraudReserve").value === "8" && document.querySelector('[data-preset="stress"]').classList.contains("active");
    return {
      viewport: { width: innerWidth, height: innerHeight },
      page: { clientWidth: root.clientWidth, scrollWidth: root.scrollWidth },
      offenders,
      clippedText,
      rateRows: document.querySelectorAll(".rate-table tbody tr").length,
      sourceRows: document.querySelectorAll(".source-row").length,
      inputs: document.querySelectorAll(".calculator input").length,
      flowSteps: document.querySelectorAll(".flow-step").length,
      canvas: { width: canvas.width, height: canvas.height, coloredPixels: colored },
      calculatorChanged: before !== after,
      presetApplied,
      errors: window.__nigeriaReportErrors || []
    };
  })()`);
}

const desktop = await inspectViewport("desktop", 1440, 1000);
const mobile = await inspectViewport("mobile", 390, 844);
console.log(JSON.stringify({ desktop, mobile }, null, 2));

const failed = [desktop, mobile].some(check =>
  check.page.scrollWidth !== check.page.clientWidth ||
  check.offenders.length ||
  check.clippedText.length ||
  check.rateRows !== 5 ||
  check.sourceRows < 12 ||
  check.inputs !== 10 ||
  check.flowSteps !== 5 ||
  check.canvas.coloredPixels < 800 ||
  !check.calculatorChanged ||
  !check.presetApplied ||
  check.errors.length
);

socket.close();
if (failed) process.exitCode = 1;
