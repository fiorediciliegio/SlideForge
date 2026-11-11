import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { closeValidatorBrowser, getSharedBrowser } from "../../scripts/m0/validatePage.ts";

async function generateThroughPage(statuses: string[]) {
  const html = await readFile(new URL("../../src/http/app.html", import.meta.url), "utf8");
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  const previewStatuses: string[] = [];
  let poll = 0;
  let status = "creating";
  try {
    await page.evaluateOnNewDocument(() => {
      localStorage.setItem("sf-api-key", "local-test-key");
      const timeout = window.setTimeout.bind(window);
      window.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
        timeout(callback, delay === 4000 ? 0 : delay, ...args)) as typeof window.setTimeout;
    });
    await page.setRequestInterception(true);
    page.on("request", async (request: any) => {
      const url = new URL(request.url());
      if (url.hostname !== "slideforge.test") return request.respond({ status: 204 });
      if (url.pathname === "/app") return request.respond({ status: 200, contentType: "text/html", body: html });
      let body: unknown = [];
      let code = 200;
      if (url.pathname === "/usage") body = { enabled: false };
      if (url.pathname === "/decks" && request.method() === "POST") {
        code = 202;
        body = { deck_id: "deck-poll-test", status: "creating" };
      }
      if (url.pathname === "/decks/deck-poll-test") {
        status = statuses[poll++];
        body = { deck_id: "deck-poll-test", status, recent_events: [], overflow_pages: [], ...(status === "error" ? { error: "模型调用失败" } : {}) };
      }
      if (url.pathname === "/decks/deck-poll-test/preview") {
        previewStatuses.push(status);
        code = status === "ready" ? 200 : 409;
        body = status === "ready"
          ? { images: [1, 2].map(page => ({ page, base64: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=" })) }
          : { error: "deck 尚未 ready" };
      }
      await request.respond({ status: code, contentType: "application/json", body: JSON.stringify(body) });
    });
    await page.goto("http://slideforge.test/app");
    await page.evaluate(() => {
      (document.getElementById("brief") as HTMLTextAreaElement).value = "生成两页测试演示";
      (document.getElementById("pages") as HTMLInputElement).value = "2";
      document.getElementById("generate")!.click();
    });
    await page.waitForFunction(() => !(document.getElementById("generate") as HTMLButtonElement).disabled);
    return {
      previewStatuses,
      polls: poll,
      status: await page.$eval("#status", (element: Element) => element.textContent),
      renderedPages: await page.$$eval("#pageList .page-thumb", (elements: Element[]) => elements.length),
    };
  } finally {
    await page.close();
    await closeValidatorBrowser();
  }
}

test("generation polls progress without requesting previews until ready", { timeout: 30_000 }, async () => {
  const result = await generateThroughPage(["creating", "creating", "ready"]);
  assert.deepEqual(result.previewStatuses, ["ready"]);
  assert.equal(result.polls, 3);
  assert.equal(result.renderedPages, 2);
  assert.match(result.status!, /全部页面已生成/);
});

test("failed generation displays the cause and stops without requesting previews", { timeout: 30_000 }, async () => {
  const result = await generateThroughPage(["creating", "error"]);
  assert.deepEqual(result.previewStatuses, []);
  assert.equal(result.polls, 2);
  assert.equal(result.status, "生成失败：模型调用失败");
});
