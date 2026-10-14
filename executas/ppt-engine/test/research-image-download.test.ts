import assert from "node:assert/strict";
import test from "node:test";

import {
  assertSafeResearchImageUrl,
  createPinnedResearchImageLookup,
  RESEARCH_IMAGE_DOWNLOAD_LIMITS,
  resolveResearchImageAddress,
} from "../src/research-image-download/index.js";

test("research image downloader enforces the agreed limits", () => {
  assert.deepEqual(RESEARCH_IMAGE_DOWNLOAD_LIMITS, {
    connectTimeoutMs: 8_000,
    totalTimeoutMs: 30_000,
    maxRedirects: 3,
    maxBytes: 20 * 1024 * 1024,
    minWidth: 800,
    minHeight: 600,
    maxDimension: 12_000,
    maxPixels: 60_000_000,
  });
});

test("research image URLs require credential-free HTTPS on port 443", () => {
  assert.equal(assertSafeResearchImageUrl("https://cdn.example/image.jpg").hostname, "cdn.example");
  assert.throws(() => assertSafeResearchImageUrl("http://cdn.example/image.jpg"), /must use HTTPS/);
  assert.throws(() => assertSafeResearchImageUrl("https://user:secret@cdn.example/image.jpg"), /must not contain credentials/);
  assert.throws(() => assertSafeResearchImageUrl("https://cdn.example:8443/image.jpg"), /port 443/);
});

test("research image downloader accepts addresses provided by the runtime network", async () => {
  assert.deepEqual(await resolveResearchImageAddress("127.0.0.1"), { address: "127.0.0.1", family: 4 });
  assert.deepEqual(await resolveResearchImageAddress("198.18.0.1"), { address: "198.18.0.1", family: 4 });
  assert.deepEqual(await resolveResearchImageAddress("64:ff9b::1"), { address: "64:ff9b::1", family: 6 });
});

test("research image downloader returns an address array when Node requests all lookup results", async () => {
  const pinnedLookup = createPinnedResearchImageLookup({ address: "8.8.8.8", family: 4 });
  await new Promise<void>((resolve, reject) => {
    pinnedLookup("images.example.test", { all: true }, (error, addresses, family) => {
      try {
        assert.equal(error, null);
        assert.deepEqual(addresses, [{ address: "8.8.8.8", family: 4 }]);
        assert.equal(family, undefined);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    pinnedLookup("images.example.test", { all: false }, (error, address, family) => {
      try {
        assert.equal(error, null);
        assert.equal(address, "8.8.8.8");
        assert.equal(family, 4);
        resolve();
      } catch (assertionError) {
        reject(assertionError);
      }
    });
  });
});
