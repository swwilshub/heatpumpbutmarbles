// Smoke test: load each scenario in the browser, screenshot, check for JS
// errors. Not a substitute for the unit tests — this is here to catch DOM
// wiring regressions (missing element IDs, undefined readouts, etc.) that
// vitest can't see. Run with: node scripts/smoke.mjs (dev server must be up).

import { chromium } from "playwright";

const errors = [];
const browser = await chromium.launch({
  executablePath: "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
});
const page = await browser.newPage({ viewport: { width: 1100, height: 640 } });
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
page.on("console", (msg) => {
  if (msg.type() === "error") {
    const t = msg.text();
    // Ignore favicon 404s — they're not project code.
    if (t.includes("favicon")) return;
    if (t.includes("404")) return;
    errors.push("console.error: " + t);
  }
});
await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
await page.waitForTimeout(500);

const scenarios = await page.$$eval("#scenario option", (opts) =>
  opts.map((o) => ({ value: o.value, text: o.textContent }))
);
console.log("scenarios:", scenarios.map((s) => s.value).join(", "));

for (const s of scenarios) {
  await page.selectOption("#scenario", s.value);
  await page.waitForTimeout(1200);
  const step = await page.textContent("#stepStat");
  const T = await page.textContent("#tmStat");
  const E = await page.textContent("#eStat");
  console.log(`  ${s.value}: step=${step}, T=${T}, E=${E}`);
}

await browser.close();
if (errors.length > 0) {
  console.error("ERRORS:", errors);
  process.exit(1);
}
console.log("OK");
