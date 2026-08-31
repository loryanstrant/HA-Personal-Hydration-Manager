/**
 * Verification harness for the percentage displayed inside the cup.
 *
 * Runs on BLASTER in a container sharing HomeAssistant-DEV's network, against
 * a real Home Assistant frontend with the real card served by the integration.
 *
 * The interesting properties are geometry and contrast, and both are measured
 * from the live DOM rather than asserted from the design notes:
 *
 *  - the two copies of the number must split exactly on the waterline, at every
 *    fill level, including the ones where the line misses the digits entirely;
 *  - "100%" must fit between the cup walls, which taper — so the check compares
 *    the text's real bounding box against the cup's interior width at the text's
 *    own height, not against a number someone wrote down;
 *  - the dry copy must clear 4.5:1 against the card background in BOTH themes,
 *    and the wet copy's halo must clear 3:1 against white over every shade of
 *    the water. Bare white on the pale #7ec8ff at the surface is only 1.8:1 —
 *    the halo is load-bearing, so it is what gets measured.
 */
import { chromium } from "playwright-core";
import { writeFileSync } from "node:fs";

const TOKEN = process.env.HA_TOKEN;
const BASE = "http://localhost:8123";
const OUT = process.env.PHM_OUT || "/out";
const PROFILE = process.env.PHM_PROFILE || "testy_mcprofile";

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
};

const browser = await chromium.launch({
  executablePath: "/ms-playwright/chromium-1140/chrome-linux/chrome",
  args: ["--no-sandbox", "--disable-dev-shm-usage", "--force-color-profile=srgb"],
});
const page = await browser.newPage({
  viewport: { width: 1280, height: 1200 },
  deviceScaleFactor: 2,
});

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
}, TOKEN);

page.on("console", (m) => {
  const t = m.text();
  if (m.type() === "error" && !t.includes("Custom state pseudo")) {
    console.log("  [browser error]", t.slice(0, 160));
  }
});

const BUILD = async (profile) => {
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
  out.cardVersion = window.customCards?.find?.((c) => c.type === "personal-hydration-card") ? true : false;

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

  const baseConfig = {
    type: "custom:personal-hydration-card",
    profile,
    show_title: true,
    show_cup: true,
    show_countdown: true,
    show_manual: true,
    unit: "mL",
    quick_add: [200, 300, 500],
  };

  const card = document.createElement("personal-hydration-card");
  card.setConfig(baseConfig);
  host.appendChild(card);
  card.hass = ha.hass;
  await sleep(600);

  window.__phm = { card, host, baseConfig, profile };
  out.built = true;
  return out;
};

const bootstrap = async () => {
  await page.goto(`${BASE}/lovelace/0`, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForFunction(() => document.querySelector("home-assistant")?.hass?.states, null, {
    timeout: 60000,
  });
  return page.evaluate(BUILD, PROFILE);
};

const built = await bootstrap();
console.log("build:", JSON.stringify(built), "\n");
if (!built.built) {
  await browser.close();
  process.exit(2);
}

/* Shared helpers injected into the page: fake a fill level without writing to
 * the real profile, and do colour maths on whatever the browser computed.
 * Re-injected after any reload, since a navigation takes them with it. */
const injectHelpers = () => page.evaluate(() => {
  const S = (window.__phm.state = {});

  S.setPct = async (pct, config) => {
    const { card, baseConfig, profile } = window.__phm;
    const hass = document.querySelector("home-assistant").hass;
    const target = 3000;
    const consumed = Math.round((pct / 100) * target);
    const st = (v) => ({ state: String(v), attributes: { friendly_name: "Testy Daily target" } });
    const states = {
      ...hass.states,
      [`sensor.phm_${profile}_daily_target`]: st(target),
      [`sensor.phm_${profile}_consumed_today`]: st(consumed),
      [`sensor.phm_${profile}_remaining`]: st(target - consumed),
      [`sensor.phm_${profile}_hourly_pace`]: st(185),
      [`sensor.phm_${profile}_progress`]: st(pct),
    };
    if (config) card.setConfig({ ...baseConfig, ...config });
    // Proxy so callService can never fire for real during a run.
    card.hass = new Proxy(hass, {
      get(t, p) {
        if (p === "states") return states;
        if (p === "callService") return async () => {};
        return t[p];
      },
    });
    await new Promise((r) => setTimeout(r, 250));
  };

  const parse = (c) => {
    const m = String(c).match(/rgba?\(([^)]+)\)/);
    if (m) {
      const p = m[1].split(",").map((x) => parseFloat(x.trim()));
      return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
    }
    const h = String(c).trim().replace("#", "");
    return {
      r: parseInt(h.slice(0, 2), 16),
      g: parseInt(h.slice(2, 4), 16),
      b: parseInt(h.slice(4, 6), 16),
      a: 1,
    };
  };
  const over = (fg, bg) => ({
    r: fg.a * fg.r + (1 - fg.a) * bg.r,
    g: fg.a * fg.g + (1 - fg.a) * bg.g,
    b: fg.a * fg.b + (1 - fg.a) * bg.b,
    a: 1,
  });
  const lum = (c) => {
    const f = (v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  };
  S.contrast = (a, b) => {
    const [x, y] = [lum(parse(a)), lum(parse(b))].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  S.composite = (fg, bg) => {
    const c = over(parse(fg), parse(bg));
    return `rgb(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)})`;
  };
  S.parse = parse;
});

await injectHelpers();

/* ---------- 1. The number left the header and is in the cup ---------- */

const placement = await page.evaluate(async () => {
  const { card, state } = window.__phm;
  await state.setPct(45, { show_cup: true, show_title: true });
  const r = card.shadowRoot;
  const out = {};
  out.headerPercent = Boolean(r.querySelector(".hyd-percent"));
  out.standalonePercent = Boolean(r.querySelector(".hyd-percent-only"));
  out.nameStillShown = r.querySelector(".hyd-name")?.textContent?.trim();
  out.pctNodes = r.querySelectorAll(".hyd-pct").length;
  out.pctText = r.querySelector(".hyd-pct")?.textContent?.trim();

  // No title + cup on: the whole header row should be gone, not just empty.
  await state.setPct(45, { show_cup: true, show_title: false });
  out.noTitleHeader = Boolean(r.querySelector(".hyd-header"));
  out.noTitleStandalone = Boolean(r.querySelector(".hyd-percent-only"));
  return out;
});

check("the header no longer carries a percentage", !placement.headerPercent);
check("no standalone percentage row", !placement.standalonePercent);
check("the name row survives", placement.nameStillShown === "Testy", `name = ${placement.nameStillShown}`);
check("the number is drawn twice in the cup", placement.pctNodes === 2, `${placement.pctNodes} nodes, reading "${placement.pctText}"`);
check(
  "with the name hidden the card gains no empty rows",
  !placement.noTitleHeader && !placement.noTitleStandalone
);

/* ---------- 2. The split lands on the waterline, at every level ---------- */

const geometry = await page.evaluate(async () => {
  const { card, state } = window.__phm;
  const r = card.shadowRoot;
  const rows = [];
  for (const pct of [0, 20, 32, 35, 45, 50, 70, 100]) {
    await state.setPct(pct, { show_cup: true, show_title: true });
    const expected = 180 - (pct / 100) * 160;
    const dry = r.querySelector("#dryClip rect");
    const wet = r.querySelector("#wetClip rect");
    const text = r.querySelector(".hyd-pct-dry");
    const bbox = text.getBBox();
    rows.push({
      pct,
      expected,
      dryBottom: dry ? parseFloat(dry.getAttribute("y")) + parseFloat(dry.getAttribute("height")) : null,
      wetTop: wet ? parseFloat(wet.getAttribute("y")) : null,
      coversCup: wet ? parseFloat(wet.getAttribute("y")) + parseFloat(wet.getAttribute("height")) >= 220 : false,
      bbox: { x: bbox.x, y: bbox.y, w: bbox.width, h: bbox.height },
      label: r.querySelector("svg.hyd-cup")?.getAttribute("aria-label"),
    });
  }
  return rows;
});

const splitOk = geometry.every(
  (g) => Math.abs(g.dryBottom - g.expected) < 0.01 && Math.abs(g.wetTop - g.expected) < 0.01 && g.coversCup
);
check(
  "both clips split exactly on the waterline at every fill level",
  splitOk,
  geometry.map((g) => `${g.pct}%→y${g.expected.toFixed(0)}`).join(" ")
);

// The cup walls taper: left edge runs (40,20)→(50,200), right edge mirrors it.
// Measure the interior at the BOTTOM of the digits, where it is narrowest.
const widthRows = geometry.map((g) => {
  const yBottom = g.bbox.y + g.bbox.h;
  const left = 40 + ((yBottom - 20) / 180) * 10;
  const interior = (200 - 2 * left) - 3; // minus the 3-unit stroke
  return { pct: g.pct, w: g.bbox.w, interior, clear: interior - g.bbox.w };
});
const widest = widthRows.reduce((a, b) => (b.w > a.w ? b : a));
check(
  '"100%" fits between the cup walls',
  widthRows.every((r) => r.clear > 0),
  `widest is ${widest.pct}% at ${widest.w.toFixed(1)}u inside ${widest.interior.toFixed(1)}u — ${widest.clear.toFixed(1)}u clear`
);

/* ---------- 3. Accessibility ---------- */

const a11y = await page.evaluate(async () => {
  const { card, state } = window.__phm;
  await state.setPct(45, { show_cup: true, show_title: true });
  const svg = card.shadowRoot.querySelector("svg.hyd-cup");
  return {
    role: svg.getAttribute("role"),
    label: svg.getAttribute("aria-label"),
    hidden: svg.getAttribute("aria-hidden"),
  };
});
check("the cup is exposed as an image, not hidden", a11y.role === "img" && a11y.hidden === null);
check(
  "its label states the percentage in words",
  /^45% of today's target/.test(a11y.label || ""),
  a11y.label
);

/* ---------- 4. Contrast, measured from computed styles ---------- */

const contrast = await page.evaluate(async () => {
  const { card, host, state } = window.__phm;
  const r = card.shadowRoot;
  await state.setPct(45, { show_cup: true, show_title: true });

  const read = () => {
    const dry = getComputedStyle(r.querySelector(".hyd-pct-dry"));
    const wet = getComputedStyle(r.querySelector(".hyd-pct-wet"));
    const cardBg = getComputedStyle(r.querySelector("ha-card")).backgroundColor;
    return { dryFill: dry.fill, wetFill: wet.fill, wetStroke: wet.stroke, cardBg };
  };

  const stops = [...r.querySelectorAll("#waterGrad stop")].map((s) => s.getAttribute("stop-color"));

  const measure = () => {
    const s = read();
    // The halo is composited over the water, then compared with the white glyph.
    const halos = stops.map((stop) => state.contrast(s.wetFill, state.composite(s.wetStroke, stop)));
    return {
      ...s,
      stops,
      dryVsCard: state.contrast(s.dryFill, s.cardBg),
      bareWhiteVsWater: stops.map((stop) => state.contrast(s.wetFill, stop)),
      haloVsGlyph: halos,
    };
  };

  const light = measure();

  // Force the dark-theme values of the two variables the card actually reads.
  host.style.setProperty("--primary-text-color", "#e1e1e1");
  host.style.setProperty("--card-background-color", "#1c1c1e");
  host.style.setProperty("--ha-card-background", "#1c1c1e");
  card._render(true);
  await new Promise((res) => setTimeout(res, 250));
  const dark = measure();

  host.style.removeProperty("--primary-text-color");
  host.style.removeProperty("--card-background-color");
  host.style.removeProperty("--ha-card-background");
  card._render(true);
  await new Promise((res) => setTimeout(res, 250));

  return { light, dark };
});

for (const [theme, m] of Object.entries(contrast)) {
  check(
    `dry copy clears 4.5:1 on the card background (${theme})`,
    m.dryVsCard >= 4.5,
    `${m.dryFill} on ${m.cardBg} = ${m.dryVsCard.toFixed(2)}:1`
  );
}
check(
  "the halo clears 3:1 against the white glyph over every water shade",
  contrast.light.haloVsGlyph.every((c) => c >= 3),
  contrast.light.stops
    .map((s, i) => `${s}: halo ${contrast.light.haloVsGlyph[i].toFixed(2)}:1 (bare white would be ${contrast.light.bareWhiteVsWater[i].toFixed(2)}:1)`)
    .join("; ")
);

/* ---------- 5. Cup off returns the number to the header ---------- */

const cupOff = await page.evaluate(async () => {
  const { card, state } = window.__phm;
  const r = card.shadowRoot;
  await state.setPct(45, { show_cup: false, show_title: true });
  const withTitle = {
    header: r.querySelector(".hyd-percent")?.textContent?.trim(),
    cup: Boolean(r.querySelector("svg.hyd-cup")),
  };
  await state.setPct(45, { show_cup: false, show_title: false });
  const noTitle = {
    standalone: r.querySelector(".hyd-percent-only")?.textContent?.trim(),
    cup: Boolean(r.querySelector("svg.hyd-cup")),
  };
  return { withTitle, noTitle };
});
check(
  "cup off, name on — the percentage is back in the header",
  cupOff.withTitle.header === "45%" && !cupOff.withTitle.cup,
  `header reads "${cupOff.withTitle.header}"`
);
check(
  "cup off, name off — the percentage is on its own row",
  cupOff.noTitle.standalone === "45%" && !cupOff.noTitle.cup,
  `row reads "${cupOff.noTitle.standalone}"`
);

/* ---------- 6. Screenshots ---------- */

/* Resizing the viewport makes the Home Assistant frontend re-render and take
 * the harness with it, so rebuild before each shot rather than assuming it
 * survived. Screenshot by clip rather than by element handle for the same
 * reason — the handle goes stale, the rectangle doesn't. */
const shoot = async (name, width, pct) => {
  await page.setViewportSize({ width, height: 1200 });
  await page.waitForTimeout(500);
  await bootstrap();
  await injectHelpers();
  const box = await page.evaluate(async (p) => {
    const { host, state } = window.__phm;
    host.style.width = "min(420px,100%)";
    await state.setPct(p, { show_cup: true, show_title: true });
    await new Promise((r) => setTimeout(r, 1600));
    host.querySelectorAll("personal-hydration-card").forEach((c) =>
      c.shadowRoot?.querySelectorAll("svg").forEach((s) => s.pauseAnimations?.())
    );
    const r = host.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, pct);
  await page.screenshot({ path: `${OUT}/${name}`, clip: box });
  console.log(`  shot ${name}`);
};

await shoot("percent-in-cup.png", 1280, 45);
await shoot("percent-in-cup-380.png", 380, 100);

const noScroll = await page.evaluate(
  () => document.documentElement.scrollWidth <= document.documentElement.clientWidth
);
check("no horizontal scroll at 380px", noScroll);

/* ---------- Report ---------- */

const passed = results.filter((r) => r.pass).length;
console.log(`\n${passed}/${results.length} checks passed`);
writeFileSync(`${OUT}/percent-in-cup-results.json`, JSON.stringify({ results, geometry, widthRows, contrast }, null, 2));

await browser.close();
process.exit(passed === results.length ? 0 : 1);
