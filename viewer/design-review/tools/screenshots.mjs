// Screenshot every page type of the running viewer in a few viewport/theme combos.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";

const OUT = process.argv[2] ?? "./shots";
mkdirSync(OUT, { recursive: true });
const BASE = "http://localhost:4321";
const IP = "/project/IPython/9.17.1";
const PA = "/project/papyri/0.0.10";

const pages = [
  ["home", "/"],
  ["ipython-bundle-index", `${IP}/`],
  ["ipython-project", `/project/IPython/`],
  ["ipython-module-root", `${IP}/IPython/`],
  ["ipython-module-big", `${IP}/IPython.core.interactiveshell/`],
  ["ipython-class", `${IP}/IPython.core.interactiveshell$InteractiveShell/`],
  ["ipython-method", `${IP}/IPython.core.interactiveshell$InteractiveShell.run_cell/`],
  ["ipython-doc-index", `${IP}/docs/index/`],
  ["ipython-doc-tutorial", `${IP}/docs/interactive/tutorial/`],
  ["ipython-doc-magics", `${IP}/docs/interactive/magics/`],
  ["ipython-text-search", `${IP}/text-search/?q=display`],
  ["ipython-images", `${IP}/images/`],
  ["ipython-nodes", `${IP}/nodes/`],
  ["ipython-validate", `${IP}/validate`],
  ["papyri-bundle-index", `${PA}/`],
  ["papyri-example", `${PA}/examples/simple_plot.py/`],
  ["papyri-func-examples", `${PA}/papyri.examples$example1/`],
  ["papyri-class", `${PA}/papyri.examples$Patti/`],
  ["papyri-doc-specimens", `${PA}/docs/specimens/blocks/`],
  ["papyri-doc-config", `${PA}/docs/configuration/`],
  ["login", "/login"],
  ["global-text-search", "/text-search/?q=array"],
  ["404", "/project/nope/1.0/"],
];

const combos = [
  { name: "desktop-light", width: 1440, height: 900, theme: "light" },
  { name: "desktop-dark", width: 1440, height: 900, theme: "dark" },
  { name: "tablet-light", width: 1024, height: 800, theme: "light" },
  { name: "mobile-light", width: 390, height: 844, theme: "light" },
];

const browser = await chromium.launch();
for (const combo of combos) {
  const ctx = await browser.newContext({ viewport: { width: combo.width, height: combo.height } });
  await ctx.addInitScript((t) => {
    try {
      localStorage.setItem("papyri-viewer:theme", t);
    } catch {}
  }, combo.theme);
  const page = await ctx.newPage();
  const only = combo.name.startsWith("desktop-light") ? pages : pages.filter((p) => !["ipython-validate", "ipython-nodes", "ipython-images", "404", "ipython-project"].includes(p[0]));
  for (const [name, path] of only) {
    try {
      await page.goto(BASE + path, { waitUntil: "networkidle", timeout: 30000 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/${name}--${combo.name}.png`, fullPage: false });
      if (combo.name === "desktop-light") {
        await page.screenshot({ path: `${OUT}/${name}--${combo.name}--full.png`, fullPage: true });
      }
    } catch (e) {
      console.error("FAIL", name, combo.name, e.message.split("\n")[0]);
    }
  }
  // Extra interaction shots on desktop light
  if (combo.name === "desktop-light") {
    await page.goto(BASE + `${IP}/IPython.core.interactiveshell$InteractiveShell/`, { waitUntil: "networkidle" });
    await page.click(".bundle-search-trigger").catch(() => {});
    await page.keyboard.type("run_c");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `${OUT}/x-search-dialog--desktop-light.png` });
    await page.keyboard.press("Escape");
    await page.click(".settings-menu-trigger").catch(() => {});
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/x-settings-menu--desktop-light.png` });
    await page.keyboard.press("Escape");
    // inline members
    await page.evaluate(() => localStorage.setItem("papyri-viewer:inline-members", "1"));
    await page.reload({ waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `${OUT}/x-inline-members--desktop-light.png` });
    await page.screenshot({ path: `${OUT}/x-inline-members--desktop-light--full.png`, fullPage: true });
    await page.evaluate(() => localStorage.removeItem("papyri-viewer:inline-members"));
    // collapsed sidebar
    await page.goto(BASE + `${IP}/docs/interactive/tutorial/`, { waitUntil: "networkidle" });
    await page.click("label.sidebar-collapse-label").catch(() => {});
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/x-sidebar-collapsed--desktop-light.png` });
    // admin
    await page.goto(BASE + "/login", { waitUntil: "networkidle" });
    await page.fill('#username', "admin").catch(() => {});
    await page.fill('#password', "password").catch(() => {});
    await page.keyboard.press("Enter");
    await page.waitForTimeout(1500);
    for (const [n, p] of [["admin", "/admin"], ["admin-projects", "/admin/projects"], ["admin-maintenance", "/admin/maintenance"], ["settings", "/settings"], ["home-authed", "/"], ["ir-stats", "/ir-stats/"]]) {
      await page.goto(BASE + p, { waitUntil: "networkidle" }).catch(() => {});
      await page.waitForTimeout(400);
      await page.screenshot({ path: `${OUT}/x-${n}--desktop-light.png` });
    }
  }
  if (combo.name === "mobile-light") {
    await page.goto(BASE + `${IP}/IPython.core.interactiveshell$InteractiveShell/`, { waitUntil: "networkidle" });
    await page.click("label.sidebar-toggle-label").catch(() => {});
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${OUT}/x-mobile-nav-open--mobile-light.png` });
    await page.screenshot({ path: `${OUT}/x-mobile-nav-open--mobile-light--full.png`, fullPage: true });
  }
  await ctx.close();
}
await browser.close();
console.log("done");
