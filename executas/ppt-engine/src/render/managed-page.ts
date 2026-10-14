import {
  closeManagedBrowser,
  launchManagedBrowser,
} from "../runtime/browser-runtime.js";
import { withScreenshotRenderQueue } from "./screenshot-render-queue.js";

export type ManagedBrowserLike = {
  newPage: () => Promise<ManagedPageLike>;
  close: () => Promise<void>;
  process?: () => {
    exitCode: number | null;
    signalCode: NodeJS.Signals | null;
    kill: (signal: NodeJS.Signals) => boolean;
  } | null;
};

export type ManagedPageLike = {
  setViewport?: (viewport: {
    width: number;
    height: number;
    deviceScaleFactor?: number;
  }) => Promise<void>;
  setContent: (
    html: string,
    options?: { waitUntil?: string | string[]; timeout?: number },
  ) => Promise<void>;
  goto?: (
    url: string,
    options?: { waitUntil?: string | string[]; timeout?: number },
  ) => Promise<unknown>;
  $: (selector: string) => Promise<ManagedElementHandleLike | null>;
  evaluate: <T>(pageFunction: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  evaluateOnNewDocument?: (
    pageFunction: string | ((...args: any[]) => unknown),
    ...args: any[]
  ) => Promise<unknown>;
  close: () => Promise<void>;
};

export type ManagedElementHandleLike = {
  evaluate: <T>(pageFunction: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  screenshot: (options?: { path?: string }) => Promise<unknown>;
};

export type ManagedPageRuntime = {
  browser: ManagedBrowserLike;
  page: ManagedPageLike | null;
  close: () => Promise<void>;
};

const MAX_BROWSER_OPERATION_TIMEOUT_MS = 10 * 60_000;

export function scaleBrowserOperationTimeout(perItemTimeoutMs: number, itemCount: number): number {
  return Math.min(
    MAX_BROWSER_OPERATION_TIMEOUT_MS,
    Math.max(perItemTimeoutMs, perItemTimeoutMs * Math.max(1, itemCount)),
  );
}

export async function createManagedPage(
  purpose: string,
  onBrowserCreated?: (runtime: ManagedPageRuntime) => void,
): Promise<ManagedPageRuntime> {
  let puppeteerModule: any;
  try {
    const importPuppeteer = new Function(
      "return import('puppeteer')",
    ) as () => Promise<any>;
    puppeteerModule = await importPuppeteer();
  } catch (error) {
    throw new Error(
      `${purpose} requires \`puppeteer\` to be installed`,
      { cause: error },
    );
  }

  const puppeteer = puppeteerModule.default ?? puppeteerModule;
  const browser = await launchManagedBrowser(puppeteer, { purpose }) as ManagedBrowserLike;
  let closePromise: Promise<void> | null = null;
  const runtime: ManagedPageRuntime = {
    browser,
    page: null,
    close: () => {
      closePromise ??= closeManagedBrowser({
        purpose,
        page: runtime.page,
        browser,
      });
      return closePromise;
    },
  };
  onBrowserCreated?.(runtime);
  runtime.page = await browser.newPage();
  return runtime;
}

export async function withQueuedManagedPage<T>(
  purpose: string,
  timeoutMs: number,
  operation: (page: ManagedPageLike) => Promise<T>,
): Promise<T> {
  let runtime: ManagedPageRuntime | null = null;
  let timedOut = false;

  return withScreenshotRenderQueue(async () => {
    runtime = await createManagedPage(purpose, (createdRuntime) => {
      runtime = createdRuntime;
    });
    if (timedOut) {
      await runtime.close();
      throw new Error(`${purpose} was cancelled after its queue operation timed out`);
    }
    if (!runtime.page) {
      throw new Error(`${purpose} did not create a browser page`);
    }
    try {
      return await operation(runtime.page);
    } finally {
      await runtime.close();
    }
  }, {
    timeoutMs,
    label: purpose,
    onTimeout: async () => {
      timedOut = true;
      await runtime?.close();
    },
  });
}
