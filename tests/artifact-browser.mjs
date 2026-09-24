/** Chromium checks for the emitted browser factory and its actual injected CSS. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { chromium } from "@playwright/test";

/** Execute the existing browser artifact without a server; always close Chromium. */
export async function verifyBrowserArtifact() {
  const bundle = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "C:/Users/30413/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe",
    headless: true,
  });
  try {
    const page = await browser.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.route("**/*", (route) => route.abort());
    await page.setContent("<!doctype html><html><head></head><body></body></html>");
    await page.evaluate(() => {
      // Factory-load-only adapters: components/hooks are not rendered by this CSS fixture.
      // Unknown externals (especially Node builtins) must fail rather than be shimmed.
      const modules = new Map([
        ["react", {}], ["react/jsx-runtime", {}], ["react-dom", {}],
        ["react-dom/client", {}], ["@deepseek-ai/cordis", {}],
        ["@deepseek-ai/dsh-client-store", {}], ["@deepseek-ai/dsh-client-ui-slots", {}],
        ["@deepseek-ai/dsh-client-ui-primitives", {}],
      ]);
      window.__artifactLoads = [];
      window.__ModuleLoader__ = { load({ id, factory }) {
        const exports = factory((name) => {
          if (!modules.has(name)) throw new Error("Unsupported browser external: " + name);
          return modules.get(name);
        });
        if (typeof exports.apply !== "function") throw new Error("Missing client apply export");
        window.__artifactLoads.push({ id, inject: exports.inject });
      } };
    });
    await page.addScriptTag({ content: bundle });
    assert.deepEqual(errors, [], "standalone browser factory must execute without page errors");
    assert.deepEqual(await page.evaluate(() => window.__artifactLoads), [{ id: "dsh-daily-planner", inject: ["slots", "locale"] }]);
    const styleCount = await page.locator('style[data-plugin-css="dsh-daily-planner/Planner.module.css"]').count();
    assert.equal(styleCount, 1, "bundle must inject actual scoped CSS");
    await page.addScriptTag({ content: bundle });
    assert.equal(await page.locator('style[data-plugin-css="dsh-daily-planner/Planner.module.css"]').count(), 1, "reloading bundle must not duplicate CSS");

    for (const viewport of [{ width: 1280, height: 800 }, { width: 390, height: 600 }, { width: 360, height: 320 }]) {
      await page.setViewportSize(viewport);
      const geometry = await page.evaluate(() => {
        const cssText = document.querySelector('style[data-plugin-css="dsh-daily-planner/Planner.module.css"]').textContent;
        const className = (local) => {
          const match = cssText.match(new RegExp("[.]((?:dp_)" + local + "_[A-Za-z0-9_-]+)"));
          if (!match) throw new Error("Missing built CSS class: " + local);
          return match[1];
        };
        document.body.replaceChildren();
        const node = (tag, local, text) => {
          const value = document.createElement(tag);
          value.className = className(local);
          if (text) value.textContent = text;
          return value;
        };
        const card = node("section", "card");
        card.id = "artifact-card";
        card.style.setProperty("--planner-left", "288px");
        card.style.setProperty("--planner-bottom", "180px");
        card.style.animation = "none";
        const header = node("header", "header", "Daily plan");
        const close = document.createElement("button");
        close.textContent = "Close";
        close.id = "artifact-close";
        header.append(close);
        const subtitle = node("div", "subtitle", "2026-09-07 · UTC");
        const body = node("div", "body");
        body.id = "artifact-body";
        for (let i = 0; i < 60; i++) {
          const task = node("article", "task");
          task.append(node("div", "taskMain", "Long task " + i + " — a full list must scroll inside the card"));
          body.append(task);
        }
        card.append(header, subtitle, body);
        document.body.append(card);
        const rect = card.getBoundingClientRect();
        const closeRect = close.getBoundingClientRect();
        body.scrollTop = body.scrollHeight;
        return {
          top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right,
          closeTop: closeRect.top, bodyHeight: body.clientHeight,
          scrollHeight: body.scrollHeight, scrollTop: body.scrollTop,
          lastBottom: body.lastElementChild.getBoundingClientRect().bottom,
          bodyBottom: body.getBoundingClientRect().bottom,
        };
      });
      assert.ok(geometry.top >= 11, "long card top clipped: " + JSON.stringify({ viewport, geometry }));
      assert.ok(geometry.bottom <= viewport.height - 11);
      assert.ok(geometry.left >= 11 && geometry.right <= viewport.width - 11);
      assert.ok(geometry.closeTop >= geometry.top, "header close control must stay visible");
      assert.ok(geometry.bodyHeight > 40 && geometry.scrollHeight > geometry.bodyHeight);
      assert.ok(geometry.scrollTop > 0, "task body must scroll");
      assert.ok(geometry.lastBottom <= geometry.bodyBottom + 1, "last task must be reachable");
      // Negative control reproduces the old independently-sized bottom/max-height rules.
      const clippedTop = await page.evaluate(() => {
        const card = document.getElementById("artifact-card");
        card.style.bottom = "180px";
        card.style.maxHeight = "calc(100dvh - 24px)";
        return card.getBoundingClientRect().top;
      });
      assert.ok(clippedTop < 0, "fixture must reject old clipped-card sizing");
    }
    assert.deepEqual(errors, []);
    console.log("PASS Chromium: standalone factory, scoped CSS injection, long-card viewport/scroll checks (3 sizes), old-CSS negative controls");
  } finally { await browser.close(); }
}
