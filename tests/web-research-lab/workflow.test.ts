import assert from "node:assert/strict";
import test from "node:test";
import { runWebResearchLab } from "../../src/features/web-research-lab/webResearchLabWorkflow";

test("Web Research Lab runs search, fetch, finish and persists each artifact", async () => {
  const urls = ["https://example.com/one", "https://example.com/two"];
  const agentResponses = [
    '{"action":"search","queries":["foo","bar"]}',
    JSON.stringify({ action: "fetch", urls }),
    '{"action":"finish"}\n\n# Summary\n\nDone.',
  ];
  const persisted: Array<{ fileName: string; content: string; append?: boolean }> = [];
  const events: string[] = [];
  const session = {
    run: async () => agentResponses.shift() ?? '{"action":"finish"}\n\n# Empty',
    close: async () => undefined,
  };
  const agentClient = {
    createWebResearchSession: async () => session,
  } as any;
  const searchCalls: Array<{ query: string; max_results?: number }> = [];
  let activeSearches = 0;
  let maxActiveSearches = 0;
  const fetchCalls: Array<{ urls: string[]; max_chars?: number }> = [];
  const researchWebClient = {
    search: async (input: { query: string; max_results?: number }) => {
      searchCalls.push({ ...input });
      activeSearches += 1;
      maxActiveSearches = Math.max(maxActiveSearches, activeSearches);
      await new Promise<void>((resolve) => setImmediate(resolve));
      activeSearches -= 1;
      return {
        results: [{ title: `Example ${input.query}`, url: urls[input.query === "foo" ? 0 : 1], snippet: "A result", site: "example.com" }],
      };
    },
    fetch: async (input: { urls: string[]; max_chars?: number }) => {
      fetchCalls.push(structuredClone(input));
      return { pages: input.urls.map((url) => ({ url, title: "Example", ok: true, content: `Body for ${url}` })) };
    },
  } as any;

  const result = await runWebResearchLab({
    agentClient,
    researchWebClient,
    run_id: "20260903-000000-000",
    systemPrompt: "system",
    userPrompt: "research foo",
    modelPreference: "moonshotai/kimi-k2.6",
    locale: "en",
    persistFile: async (fileName, content, append) => {
      persisted.push({ fileName, content, append });
      return { run_dir: "/tmp/research-test/20260903-000000-000" };
    },
    onEvent: (event) => events.push(event.type),
  });

  assert.equal(result.status, "completed");
  assert.equal(result.markdown, "# Summary\n\nDone.");
  assert.equal(result.rounds.length, 3);
  assert.equal(result.searches.length, 2);
  assert.equal(result.fetched_pages.length, 2);
  assert.deepEqual(searchCalls, [{ query: "foo", max_results: 6 }, { query: "bar", max_results: 6 }]);
  assert.equal(maxActiveSearches, 2);
  assert.deepEqual(fetchCalls, [{ urls, max_chars: 8000 }]);
  assert.deepEqual(persisted.map((item) => item.fileName), [
    "input.json",
    "meta.json",
    "rounds.jsonl",
    "rounds.jsonl",
    "rounds.jsonl",
    "result.md",
    "meta.json",
  ]);
  assert.deepEqual(events, ["started", "agent", "action", "tool", "agent", "action", "tool", "agent", "action", "completed"]);
});

test("Web Research Lab returns successful batch items alongside query and URL failures", async () => {
  const goodUrl = "https://example.com/good";
  const badUrl = "https://example.com/bad";
  const responses = [
    JSON.stringify({ action: "search", queries: ["good query", "failing query", "bad page query"] }),
    JSON.stringify({ action: "fetch", urls: [goodUrl, badUrl] }),
    '{"action":"finish"}\n\n# Summary\n\nPartial results retained.',
  ];
  const fetchCalls: string[][] = [];
  const prompts: string[] = [];
  const session = {
    run: async (prompt: string) => {
      prompts.push(prompt);
      return responses.shift() ?? '{"action":"finish"}\n\n# Empty';
    },
    close: async () => undefined,
  };

  const result = await runWebResearchLab({
    agentClient: { createWebResearchSession: async () => session } as any,
    researchWebClient: {
      search: async ({ query }: { query: string }) => {
        if (query === "failing query") throw new Error("search unavailable");
        const url = query === "bad page query" ? badUrl : goodUrl;
        return { results: [{ title: "Good", url, snippet: "Evidence", site: "example.com" }] };
      },
      fetch: async ({ urls }: { urls: string[] }) => {
        fetchCalls.push([...urls]);
        return {
          pages: urls.map((url) => url === badUrl
            ? { url, ok: false, error: "page unavailable" }
            : { url, ok: true, content: "Good page" }),
        };
      },
    } as any,
    run_id: "20260903-000000-001",
    systemPrompt: "system",
    userPrompt: "research partial results",
    modelPreference: "moonshotai/kimi-k2.6",
    persistFile: async (_fileName, _content) => ({ run_dir: "/tmp/research-test/partial" }),
  });

  assert.deepEqual(result.searches, [{
    query: "good query",
    results: [{ title: "Good", url: goodUrl, snippet: "Evidence", site: "example.com" }],
  }, {
    query: "failing query",
    results: [],
    error: "search unavailable",
  }, {
    query: "bad page query",
    results: [{ title: "Good", url: badUrl, snippet: "Evidence", site: "example.com" }],
  }]);
  assert.deepEqual(fetchCalls, [[goodUrl, badUrl]]);
  assert.deepEqual(result.fetched_pages.map((page) => page.ok), [true, false]);
  assert.match(prompts[1] ?? "", /search unavailable/);
  assert.match(prompts[2] ?? "", /page unavailable/);
});
