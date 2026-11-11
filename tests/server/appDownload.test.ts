import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const html = await readFile(new URL("../../src/http/app.html", import.meta.url), "utf8");
const exportScript = html.slice(
  html.indexOf("    function showExportResult("),
  html.indexOf('    $("themeSelect").addEventListener("change"'),
);

for (const [format, exportButton] of [["pptx", "exportBtn"], ["pdf", "exportPdfBtn"]]) {
  test(`the workspace downloads ${format} with the business key`, async () => {
    const handlers = new Map<string, () => Promise<void>>();
    const requests: Array<{ path: string; key: string | null }> = [];
    const saves: Array<{ href: string; name: string }> = [];
    const blobs: Blob[] = [];
    const target = { textContent: "", appendChild() {} };

    runInNewContext(exportScript, {
      state: { deckId: "deck-test" },
      apiKey: "local-test-key",
      api: async () => ({ download_url: `/files/file-${format}` }),
      fetch: async (path: string, options: RequestInit) => {
        requests.push({ path, key: new Headers(options.headers).get("x-api-key") });
        return new Response(`${format} bytes`);
      },
      URL: {
        createObjectURL(blob: Blob) {
          blobs.push(blob);
          return "blob:export-test";
        },
        revokeObjectURL() {},
      },
      setTimeout: () => {},
      toast() {},
      $: (id: string) => id === "exportResult" ? target : {
        addEventListener: (_event: string, handler: () => Promise<void>) => handlers.set(id, handler),
      },
      document: {
        body: { appendChild() {} },
        createElement: (tag: string) => ({
          style: {},
          href: "",
          download: "",
          addEventListener: (_event: string, handler: () => Promise<void>) => handlers.set("download", handler),
          click() {
            assert.equal(tag, "a");
            saves.push({ href: this.href, name: this.download });
          },
          remove() {},
        }),
      },
    });

    await handlers.get(exportButton)!();
    await handlers.get("download")?.();
    assert.deepEqual(requests, [{ path: `/files/file-${format}`, key: "local-test-key" }]);
    assert.deepEqual(saves, [{ href: "blob:export-test", name: `deck.${format}` }]);
    assert.equal(await blobs[0].text(), `${format} bytes`);
  });
}
