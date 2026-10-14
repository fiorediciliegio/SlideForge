import assert from "node:assert/strict";
import test from "node:test";

import { resolveWorkspaceTemplateReference } from "../../src/features/deck-generation/templateReferenceResolver.ts";

const selectedReference = {
  path: "html/content.html",
  description: "Editorial content page.",
  html: "<!doctype html><html><body>Selected reference</body></html>",
};

test("existing aesthetic selections read one HTML page without listing all references", async () => {
  let listCalls = 0;
  let selectCalls = 0;
  const reference = await resolveWorkspaceTemplateReference({
    backend: {
      listWorkspaceTemplateReferences: async () => {
        listCalls += 1;
        throw new Error("must not list references for an existing selection");
      },
      getWorkspaceTemplateReferenceHtml: async (input) => {
        assert.deepEqual(input, { workspace_dir: "/tmp/workspace", path: selectedReference.path });
        return selectedReference;
      },
    },
    workspaceDir: "/tmp/workspace",
    selectedPath: selectedReference.path,
    selectReference: async () => {
      selectCalls += 1;
      return selectedReference.path;
    },
  });

  assert.deepEqual(reference, selectedReference);
  assert.equal(listCalls, 0);
  assert.equal(selectCalls, 0);
});

test("new aesthetic selections use metadata before reading one selected HTML page", async () => {
  const candidates = [
    { path: "html/cover.html", description: "Editorial cover." },
    { path: selectedReference.path, description: selectedReference.description },
  ];
  let requestedPath = "";
  const reference = await resolveWorkspaceTemplateReference({
    backend: {
      listWorkspaceTemplateReferences: async () => ({
        version: 1,
        preset: { id: "preset", version: 1, name: "Preset", description: "Preset description." },
        reference_html_pages: candidates,
      }),
      getWorkspaceTemplateReferenceHtml: async (input) => {
        requestedPath = input.path;
        return selectedReference;
      },
    },
    workspaceDir: "/tmp/workspace",
    selectedPath: "",
    selectReference: async (receivedCandidates) => {
      assert.deepEqual(receivedCandidates, candidates);
      assert.equal(JSON.stringify(receivedCandidates).includes("html"), true);
      assert.equal("html" in receivedCandidates[0]!, false);
      return selectedReference.path;
    },
  });

  assert.equal(requestedPath, selectedReference.path);
  assert.deepEqual(reference, selectedReference);
});
