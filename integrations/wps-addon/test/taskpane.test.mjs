import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../main.js", import.meta.url), "utf8");

function loadPane(respond) {
  const requests = [];
  const handlers = new Map();
  const insertions = [];
  const writes = new Map();
  const removals = [];
  const fields = {
    apiKey: { value: "test-business-key" },
    brief: { value: "生成两页测试演示" },
    pages: { value: "2" },
    status: {},
    generate: {},
    insert: { hidden: true },
  };
  for (const id of ["generate", "insert"]) {
    fields[id].addEventListener = (_event, handler) => handlers.set(id, handler);
  }
  runInNewContext(script, {
    crypto: globalThis.crypto,
    document: { getElementById: (id) => fields[id] },
    setTimeout: (callback) => callback(),
    fetch: async (path, options) => {
      const method = options.method ?? "GET";
      requests.push({ method, path, key: new Headers(options.headers).get("x-api-key") });
      return respond(method, path);
    },
    window: { Application: {
      Env: { GetTempPath: () => "C:\\WpsTemp\\" },
      FileSystem: {
        writeAsBinaryString(path, data) {
          writes.set(path, data);
          return true;
        },
        Exists: (path) => writes.has(path),
        unlinkSync(path) {
          removals.push(path);
          return true;
        },
      },
      ActivePresentation: { Slides: {
        Count: 1,
        InsertFromFile(path, index) {
          assert.ok(writes.has(path));
          assert.ok(!removals.includes(path));
          insertions.push([path, index]);
          return 2;
        },
      } },
    } },
  });
  return { fields, handlers, insertions, removals, requests, writes };
}

test("the insert button downloads an export with only a file URL and appends it from a temporary file", async () => {
  const fileUrl = "/files/file-test";
  const bytes = Uint8Array.from({ length: 20000 }, (_, i) => i % 256);
  const states = ["creating", "ready"];
  const pane = loadPane((method, path) => {
    if (path === "/decks") return Response.json({ deck_id: "deck-test" }, { status: 202 });
    if (path === fileUrl) return new Response(bytes);
    if (method === "GET") return Response.json({ status: states.shift() });
    return Response.json({ download_url: fileUrl });
  });
  await pane.handlers.get("generate")();
  assert.deepEqual(pane.requests.map(({ method, path }) => `${method} ${path}`), [
    "POST /decks", "GET /decks/deck-test", "GET /decks/deck-test", "POST /decks/deck-test/export",
  ]);
  assert.ok(pane.requests.every(({ key }) => key === "test-business-key"));
  assert.equal(pane.fields.insert.hidden, false);
  assert.deepEqual(pane.insertions, []);
  pane.fields.apiKey.value = "changed-key";
  await pane.handlers.get("insert")();
  assert.deepEqual(pane.requests.at(-1), { method: "GET", path: fileUrl, key: "test-business-key" });
  const [tempPath] = pane.writes.keys();
  assert.match(tempPath, /^C:\\WpsTemp\\slideforge-.*\.pptx$/);
  assert.deepEqual(Buffer.from(pane.writes.get(tempPath), "latin1"), Buffer.from(bytes));
  assert.deepEqual(pane.insertions, [[tempPath, 1]]);
  assert.deepEqual(pane.removals, [tempPath]);
  assert.match(pane.fields.status.textContent, /2 页/);
});

test("asynchronous engine export is polled before enabling WPS insertion",async()=>{
 let polls=0;
 const pane=loadPane((_method,path)=>{
  if(path==="/decks")return Response.json({deck_id:"deck-test"});
  if(path==="/decks/deck-test")return Response.json({status:"ready"});
  if(path==="/decks/deck-test/export")return Response.json({engine_job_id:"engine-one",status_url:"/engine-status"},{status:202});
  if(path==="/engine-status")return Response.json(++polls===1?{state:"queued"}:{state:"completed",result:{download_url:"/files/ready"}});
  throw new Error("unexpected request");
 });
 await pane.handlers.get("generate")();assert.equal(polls,2);assert.equal(pane.fields.insert.hidden,false);assert.deepEqual(pane.insertions,[]);
});

test("a rejected file download leaves the current presentation untouched", async () => {
  const pane = loadPane((_method, path) => {
    if (path === "/decks") return Response.json({ deck_id: "deck-test" });
    if (path === "/decks/deck-test") return Response.json({ status: "ready" });
    if (path === "/decks/deck-test/export") return Response.json({ download_url: "/files/file-test" });
    return Response.json({ error: "file 不存在" }, { status: 404 });
  });
  await pane.handlers.get("generate")();
  await pane.handlers.get("insert")();
  assert.match(pane.fields.status.textContent, /file 不存在/);
  assert.equal(pane.writes.size, 0);
  assert.deepEqual(pane.insertions, []);
  assert.equal(pane.fields.insert.disabled, false);
});

test("an authorization failure is shown and stops before polling", async () => {
  const pane = loadPane(() => Response.json({ error: "invalid api key" }, { status: 402 }));
  await pane.handlers.get("generate")();
  assert.equal(pane.requests.length, 1);
  assert.match(pane.fields.status.textContent, /invalid api key/);
  assert.equal(pane.fields.insert.hidden, true);
});

test("a task that remains in progress times out without exporting", async () => {
  const pane = loadPane((_method, path) => Response.json(path === "/decks"
    ? { deck_id: "deck-test" }
    : { status: "creating" }));
  await pane.handlers.get("generate")();
  assert.equal(pane.requests.filter(({ method }) => method === "POST").length, 1);
  assert.match(pane.fields.status.textContent, /超时/);
  assert.equal(pane.fields.insert.hidden, true);
});
