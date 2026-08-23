/**
 * Verification harness for the card's inline custom-amount entry.
 *
 * Runs on BLASTER in a container sharing HomeAssistant-DEV's network.
 *
 * The interesting property is survival: the card replaces its whole shadow
 * subtree in `_render()`, Home Assistant assigns `hass` several times a second,
 * and a 30-second tick timer calls `_render()` too. An open input inside that
 * subtree is destroyed by any of them unless the card holds the render off.
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const TOKEN = process.env.HA_TOKEN;
const BASE = "http://localhost:8123";
const OUT = "/out";
const PREFIX = process.env.PHM_PREFIX || "custom-add";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({
  executablePath: "/ms-playwright/chromium-1140/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });

await page.addInitScript((token) => {
  window.localStorage.setItem(
    "hassTokens",
    JSON.stringify({
      access_token: token,
      token_type: "Bearer",
      expires_in: 1800,
      hassUrl: "http://localhost:8123",
      clientId: null,
      expires: Date.now() + 1000 * 60 * 60 * 24 * 365,
      refresh_token: "",
    })
  );
  // A prompt() would hang a headless run and is exactly what this replaces.
  window.__promptCalls = 0;
  window.prompt = () => { window.__promptCalls++; return null; };
}, TOKEN);

page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("Custom state pseudo")) {
    console.log("  [browser error]", t.slice(0, 160));
  }
});

const BUILD = async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const ha = document.querySelector("home-assistant");
  const out = {};
  try {
    await import(`/personal_hydration_manager_static/personal-hydration-card.js?probe=${Date.now()}`);
  } catch (e) {
    out.importError = String(e);
  }
  const CARD = window.customElements.get("personal-hydration-card");
  out.cardDefined = Boolean(CARD);
  if (!CARD) return out;

  ha.shadowRoot.getElementById("phm-card-harness")?.remove();
  const host = document.createElement("div");
  host.id = "phm-card-harness";
  host.style.cssText = [
    "position:absolute", "top:0", "right:0", "width:min(420px,100%)",
    "z-index:9999", "padding:24px", "box-sizing:border-box",
    "background:var(--primary-background-color,#f5f5f5)",
    "box-shadow:-8px 0 24px rgba(0,0,0,.28)",
  ].join(";");
  ha.shadowRoot.appendChild(host);

  const card = document.createElement("personal-hydration-card");
  card.setConfig({
    type: "custom:personal-hydration-card",
    profile: "testy_mcprofile",
    show_title: true,
    show_cup: true,
    show_countdown: true,
    show_manual: true,
    unit: "mL",
    quick_add: [200, 300, 500],
  });
  host.appendChild(card);
  card.hass = ha.hass;
  await sleep(800);
  window.__phmCard = card;
  out.built = true;
  return out;
};

const bootstrap = async () => {
  await page.goto(`${BASE}/lovelace/0`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("home-assistant")?.hass?.states, null, {
    timeout: 60000,
  });
  return page.evaluate(BUILD);
};

const resilient = async (fn) => {
  try {
    return await fn();
  } catch (err) {
    if (!String(err).includes("Execution context was destroyed")) throw err;
    console.log("  (frontend navigated mid-run — rebuilding and retrying once)");
    await bootstrap();
    return await fn();
  }
};

const built = await bootstrap();
console.log("build:", JSON.stringify(built), "\n");
if (!built.built) { await browser.close(); process.exit(2); }

const report = await resilient(() => page.evaluate(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const card = window.__phmCard;
  const hass = document.querySelector("home-assistant").hass;
  const root = card.shadowRoot;
  const q = (sel) => root.querySelector(sel);
  const out = { serviceCalls: [] };

  // Intercept the service call rather than actually logging litres of water
  // into a profile on every run. Every later assignment must go through this
  // too — assigning a bare hass object would silently restore the real
  // callService and the test would log for real while recording nothing.
  const proxied = (h) =>
    new Proxy(h, {
      get(t, p) {
        if (p === "callService") {
          return async (...args) => { out.serviceCalls.push(args.slice(0, 3)); };
        }
        return t[p];
      },
    });
  card.hass = proxied(hass);
  await sleep(200);

  try {
    out.customButtonExists = Boolean(q('[data-custom="1"]'));
    out.inputBeforeOpen = Boolean(q(".hyd-custom-input"));

    // Open it.
    q('[data-custom="1"]').click();
    await sleep(300);
    const field = q(".hyd-custom-input");
    out.inputAfterOpen = Boolean(field);
    out.unitShown = q(".hyd-custom-unit")?.textContent?.trim();
    // Focus is deferred a frame on purpose (see the card), so wait one.
    await sleep(150);
    out.focused = root.activeElement === field;
    out.documentHasFocus = document.hasFocus();
    out.activeInShadow = root.activeElement?.className || root.activeElement?.tagName || null;

    // THE test: type, then hammer `hass` the way HA does, plus a direct
    // _render() the way the 30s tick timer does. The field must survive both,
    // still be the same node, and keep what was typed.
    field.value = "35";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(100);
    const nodeBefore = q(".hyd-custom-input");
    for (let i = 0; i < 20; i++) card.hass = proxied({ ...hass, __tick: i });
    card._render();
    await sleep(400);
    const nodeAfter = q(".hyd-custom-input");
    out.survivesHassChurn = Boolean(nodeAfter) && nodeBefore === nodeAfter;
    out.valueKept = nodeAfter?.value;

    // Escape closes without logging anything.
    nodeAfter.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await sleep(300);
    out.closedByEscape = !q(".hyd-custom-input");
    out.callsAfterEscape = out.serviceCalls.length;

    // Rejects nonsense with a visible message instead of failing silently.
    q('[data-custom="1"]').click();
    await sleep(250);
    let f = q(".hyd-custom-input");
    f.value = "0";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    q('[data-confirm="1"]').click();
    await sleep(300);
    out.errorShown = q(".hyd-custom-error")?.textContent?.trim();
    out.stillOpenAfterError = Boolean(q(".hyd-custom-input"));
    out.callsAfterBadInput = out.serviceCalls.length;

    // Enter confirms a good value, converts, closes.
    f = q(".hyd-custom-input");
    f.value = "350";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    f.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await sleep(500);
    out.closedAfterConfirm = !q(".hyd-custom-input");
    out.loggedCall = out.serviceCalls[out.serviceCalls.length - 1];

    // fl oz converts to mL before the service call.
    card.setConfig({
      type: "custom:personal-hydration-card", profile: "testy_mcprofile",
      show_title: true, show_cup: true, show_countdown: true, show_manual: true,
      unit: "fl_oz", quick_add: [200, 300, 500],
    });
    await sleep(300);
    q('[data-custom="1"]').click();
    await sleep(250);
    out.unitShownFlOz = q(".hyd-custom-unit")?.textContent?.trim();
    f = q(".hyd-custom-input");
    f.value = "10";
    f.dispatchEvent(new Event("input", { bubbles: true }));
    q('[data-confirm="1"]').click();
    await sleep(400);
    out.flOzCall = out.serviceCalls[out.serviceCalls.length - 1];

    out.promptCalls = window.__promptCalls;
    // Reopen for the screenshots.
    card.setConfig({
      type: "custom:personal-hydration-card", profile: "testy_mcprofile",
      show_title: true, show_cup: true, show_countdown: true, show_manual: true,
      unit: "mL", quick_add: [200, 300, 500],
    });
    await sleep(300);
    q('[data-custom="1"]').click();
    await sleep(300);
  } catch (err) {
    out.error = String(err?.stack || err);
  }
  return out;
}));

console.log("\n--- raw report ---");
console.log(JSON.stringify(report, null, 2));
console.log("------------------\n");

check("the custom button exists and no field is shown until it is pressed",
  report.customButtonExists && report.inputBeforeOpen === false);
check("pressing it opens an inline field, focused, labelled mL",
  report.inputAfterOpen && report.focused && report.unitShown === "mL",
  `focused=${report.focused} unit=${report.unitShown}`);
check("the open field survives 20 hass assignments and a tick re-render",
  report.survivesHassChurn === true);
check("what was typed is still there afterwards", report.valueKept === "35",
  `value=${report.valueKept}`);
check("Escape closes it and logs nothing",
  report.closedByEscape && report.callsAfterEscape === 0);
check("a bad amount shows a message and stays open",
  Boolean(report.errorShown) && report.stillOpenAfterError && report.callsAfterBadInput === 0,
  `error=${JSON.stringify(report.errorShown)}`);
check("Enter confirms, closes, and logs the amount in mL",
  report.closedAfterConfirm &&
    report.loggedCall?.[2]?.volume === 350 && report.loggedCall?.[2]?.unit === "mL",
  JSON.stringify(report.loggedCall?.[2]));
check("fl oz is converted before logging (10 fl oz ≈ 295.7 mL)",
  report.unitShownFlOz === "fl oz" &&
    Math.abs((report.flOzCall?.[2]?.volume ?? 0) - 295.735) < 0.01,
  `unit=${report.unitShownFlOz} volume=${report.flOzCall?.[2]?.volume}`);
check("window.prompt is never called", report.promptCalls === 0,
  `calls=${report.promptCalls}`);

const shoot = async (width, name) => resilient(async () => {
  await page.setViewportSize({ width, height: 1400 });
  await page.waitForTimeout(700);
  await page.evaluate(BUILD);
  await page.evaluate(async () => {
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const card = window.__phmCard;
    card.shadowRoot.querySelector('[data-custom="1"]')?.click();
    await sleep(300);
  });
  await page.waitForTimeout(600);
  const box = await page.evaluate(() => {
    const n = document.querySelector("home-assistant").shadowRoot.getElementById("phm-card-harness");
    const r = n.getBoundingClientRect();
    return { x: Math.max(0, r.x), y: Math.max(0, r.y), width: r.width, height: r.height };
  });
  await page.screenshot({ path: `${OUT}/${name}`, clip: box });
  console.log(`wrote ${name} (viewport ${width}px)`);
});

await shoot(1280, `${PREFIX}-desktop.png`);
await shoot(380, `${PREFIX}-380.png`);

writeFileSync(`${OUT}/${PREFIX}-report.json`, JSON.stringify({ report, results }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
