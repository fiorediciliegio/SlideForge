export type StaticHtmlDocumentKind = "deck" | "page";

export interface StaticHtmlPageLike {
  evaluate: <T>(pageFunction: (...args: any[]) => T, ...args: any[]) => Promise<T>;
  evaluateOnNewDocument?: (
    pageFunction: string | ((...args: any[]) => unknown),
    ...args: any[]
  ) => Promise<unknown>;
}

export interface WaitForRenderReadinessInput {
  timeoutMs: number;
  quietWindowMs?: number;
  requireTailwind?: boolean;
  allowFailedImages?: boolean;
}

type RenderReadinessState = {
  failedImages: string[];
  fontsReady: boolean;
  pendingImages: string[];
  pendingRequests: string[];
  pendingStylesheets: string[];
  quietForMs: number;
  tailwindReady: boolean;
};

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function describeReadinessBlockers(state: RenderReadinessState | null): string {
  if (!state) return "render readiness state was unavailable";
  const blockers: string[] = [];
  if (!state.tailwindReady) blockers.push("Tailwind CSS was not generated");
  if (!state.fontsReady) blockers.push("fonts were still loading");
  if (state.pendingImages.length > 0) {
    blockers.push(`images were still loading: ${state.pendingImages.join(", ")}`);
  }
  if (state.pendingRequests.length > 0) {
    blockers.push(`requests were still pending: ${state.pendingRequests.join(", ")}`);
  }
  if (state.failedImages.length > 0) {
    blockers.push(`images failed to load: ${state.failedImages.join(", ")}`);
  }
  if (state.pendingStylesheets.length > 0) {
    blockers.push(`stylesheets were still loading: ${state.pendingStylesheets.join(", ")}`);
  }
  if (state.quietForMs <= 0) blockers.push("DOM was still changing");
  return blockers.join("; ") || "the document did not settle";
}

const RENDER_READINESS_TRACKING_SCRIPT = String.raw`
(() => {
  const state = window.__PRESENTON_RENDER_REQUESTS__ = new Map();
  let nextRequestId = 1;
  const begin = (label) => {
    const id = nextRequestId++;
    state.set(id, String(label || "<unknown request>"));
    return id;
  };
  const finish = (id) => state.delete(id);

  const originalFetch = window.fetch.bind(window);
  window.fetch = (...args) => {
    const request = args[0];
    const label = typeof request === "string" ? request : request?.url;
    const id = begin(label || "fetch");
    return originalFetch(...args).finally(() => finish(id));
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    this.__presentonRenderUrl = url;
    return originalOpen.call(this, method, url, ...rest);
  };
  XMLHttpRequest.prototype.send = function(...args) {
    const id = begin(this.__presentonRenderUrl || "XMLHttpRequest");
    this.addEventListener("loadend", () => finish(id), { once: true });
    try {
      return originalSend.apply(this, args);
    } catch (error) {
      finish(id);
      throw error;
    }
  };
})();
`;

export async function installRenderReadinessTracking(
  page: StaticHtmlPageLike,
): Promise<void> {
  await page.evaluateOnNewDocument?.(RENDER_READINESS_TRACKING_SCRIPT);
}

export async function waitForRenderReadiness(
  page: StaticHtmlPageLike,
  input: WaitForRenderReadinessInput,
): Promise<void> {
  const quietWindowMs = input.quietWindowMs ?? 100;
  const requireTailwind = input.requireTailwind ?? false;
  const allowFailedImages = input.allowFailedImages ?? false;
  const startedAt = Date.now();
  await page.evaluate(() => {
    const renderWindow = window as typeof window & {
      __PRESENTON_LAST_RENDER_MUTATION_AT__?: number;
      __PRESENTON_RENDER_MUTATION_OBSERVER__?: MutationObserver;
    };
    renderWindow.__PRESENTON_RENDER_MUTATION_OBSERVER__?.disconnect();
    renderWindow.__PRESENTON_LAST_RENDER_MUTATION_AT__ = performance.now();
    const observer = new MutationObserver(() => {
      renderWindow.__PRESENTON_LAST_RENDER_MUTATION_AT__ = performance.now();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      characterData: true,
      childList: true,
      subtree: true,
    });
    renderWindow.__PRESENTON_RENDER_MUTATION_OBSERVER__ = observer;
  });

  let lastState: RenderReadinessState | null = null;
  while (Date.now() - startedAt <= input.timeoutMs) {
    lastState = await page.evaluate((requiredQuietWindowMs, shouldRequireTailwind) => {
      const renderWindow = window as typeof window & {
        __PRESENTON_LAST_RENDER_MUTATION_AT__?: number;
        __PRESENTON_RENDER_REQUESTS__?: Map<number, string>;
      };
      const images = Array.from(document.images);
      const pendingImages = images
        .filter((image) => !image.complete)
        .map((image) => image.currentSrc || image.src || "<unknown image>");
      const failedImages = images
        .filter((image) => image.complete && image.naturalWidth === 0)
        .map((image) => image.currentSrc || image.src || "<unknown image>");
      const pendingStylesheets = Array.from(
        document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'),
      )
        .filter((link) => !link.sheet)
        .map((link) => link.href || "<unknown stylesheet>");
      const tailwindReady = !shouldRequireTailwind || Array.from(document.querySelectorAll("style"))
        .some((style) => style.textContent?.includes("tailwindcss v4.3.2"));
      const fontsReady = !document.fonts || document.fonts.status === "loaded";
      const lastMutationAt = renderWindow.__PRESENTON_LAST_RENDER_MUTATION_AT__
        ?? performance.now();
      const quietForMs = performance.now() - lastMutationAt;
      return {
        failedImages,
        fontsReady,
        pendingImages,
        pendingRequests: Array.from(renderWindow.__PRESENTON_RENDER_REQUESTS__?.values() ?? []),
        pendingStylesheets,
        quietForMs: quietForMs >= requiredQuietWindowMs ? quietForMs : 0,
        tailwindReady,
      };
    }, quietWindowMs, requireTailwind);

    if (
      lastState.tailwindReady &&
      lastState.fontsReady &&
      lastState.pendingImages.length === 0 &&
      lastState.pendingRequests.length === 0 &&
      (allowFailedImages || lastState.failedImages.length === 0) &&
      lastState.pendingStylesheets.length === 0 &&
      lastState.quietForMs >= quietWindowMs
    ) {
      await page.evaluate(() => new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }));
      return;
    }
    await delay(50);
  }

  throw new Error(
    `Timed out waiting for Render Readiness within ${input.timeoutMs}ms: ${describeReadinessBlockers(lastState)}`,
  );
}

export async function serializeRenderedPageToStaticHtml(
  page: StaticHtmlPageLike,
  kind: StaticHtmlDocumentKind,
): Promise<string> {
  // tsx/tsup may annotate nested functions in the callback below with the
  // esbuild `__name` helper. Puppeteer serializes only the callback body, so
  // install the tiny helper explicitly in the browser realm first.
  await page.evaluate(() => {
    const globalScope = globalThis as typeof globalThis & {
      __name?: (target: unknown) => unknown;
    };
    globalScope.__name ??= (target: unknown) => target;
  });
  return page.evaluate(async (documentKind) => {
    const canvases = Array.from(document.querySelectorAll("canvas"));
    for (const canvas of canvases) {
      const image = document.createElement("img");
      for (const attribute of Array.from(canvas.attributes)) {
        image.setAttribute(attribute.name, attribute.value);
      }
      image.src = canvas.toDataURL("image/png");
      image.width = canvas.width;
      image.height = canvas.height;
      canvas.replaceWith(image);
    }

    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      for (const attributeName of ["src", "href", "poster", "srcset", "style", "xlink:href"] as const) {
        const value = element.getAttribute(attributeName);
        if (!value?.includes("blob:")) continue;
        let rewrittenValue = value;
        const blobUrls = value.match(/blob:[^\s,"')]+/g) ?? [];
        for (const blobUrl of blobUrls) {
          const response = await fetch(blobUrl);
          const blob = await response.blob();
          const dataUrl = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
            reader.addEventListener("error", () => reject(reader.error), { once: true });
            reader.readAsDataURL(blob);
          });
          rewrittenValue = rewrittenValue.replaceAll(blobUrl, dataUrl);
        }
        element.setAttribute(attributeName, rewrittenValue);
      }
    }

    const wrapper = document.getElementById("presentation-slides-wrapper");
    const shell = wrapper?.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]')
      ?? document.querySelector<HTMLElement>('[data-presenton-slide-shell="true"]');
    const canvas = shell?.getBoundingClientRect();
    const canvasWidth = `${canvas?.width || 1920}px`;
    const canvasHeight = `${canvas?.height || 1080}px`;
    const pageId = shell?.getAttribute("data-presenton-page-id") ?? "";
    const escapedPageId = typeof CSS !== "undefined" && typeof CSS.escape === "function"
      ? CSS.escape(pageId)
      : pageId.replace(/["\\]/g, "\\$&");
    const scopeSelector = documentKind === "page" && pageId
      ? `[data-presenton-page-id="${escapedPageId}"]`
      : "";

    const setFixedCanvasStyle = (element: HTMLElement, values: Record<string, string>) => {
      for (const [property, value] of Object.entries(values)) {
        element.style.setProperty(property, value, "important");
      }
    };
    if (wrapper) {
      setFixedCanvasStyle(wrapper, {
        "box-sizing": "border-box",
        display: "block",
        height: canvasHeight,
        margin: "0px",
        "min-height": canvasHeight,
        "min-width": canvasWidth,
        overflow: "hidden",
        padding: "0px",
        position: "relative",
        visibility: "visible",
        width: canvasWidth,
      });
    }
    if (shell) {
      setFixedCanvasStyle(shell, {
        "box-sizing": "border-box",
        display: "block",
        height: canvasHeight,
        margin: "0px",
        "min-height": canvasHeight,
        "min-width": canvasWidth,
        overflow: "hidden",
        padding: "0px",
        position: "relative",
        visibility: "visible",
        width: canvasWidth,
      });
    }

    const splitSelectorList = (value: string) => {
      const parts: string[] = [];
      let start = 0;
      let roundDepth = 0;
      let squareDepth = 0;
      let quote = "";
      for (let index = 0; index < value.length; index += 1) {
        const char = value[index]!;
        if (quote) {
          if (char === quote && value[index - 1] !== "\\") quote = "";
          continue;
        }
        if (char === '"' || char === "'") quote = char;
        else if (char === "(") roundDepth += 1;
        else if (char === ")") roundDepth = Math.max(0, roundDepth - 1);
        else if (char === "[") squareDepth += 1;
        else if (char === "]") squareDepth = Math.max(0, squareDepth - 1);
        else if (char === "," && roundDepth === 0 && squareDepth === 0) {
          parts.push(value.slice(start, index).trim());
          start = index + 1;
        }
      }
      parts.push(value.slice(start).trim());
      return parts.filter(Boolean);
    };
    const scopeOneSelector = (selector: string) => {
      if (!scopeSelector) return selector;
      let next = selector
        .replace(/(^|[\s>+~,(])(?::root|html|body)(?=$|[\s>+~.#:[(])/gi, `$1${scopeSelector}`)
        .replace(/#presentation-slides-wrapper/g, scopeSelector);
      next = next.replaceAll(`${scopeSelector} ${scopeSelector}`, scopeSelector);
      if (next.includes(scopeSelector)) return next;
      return `${scopeSelector} ${next}`;
    };
    const serializeStyleDeclaration = (style: CSSStyleDeclaration) => {
      const declarations: string[] = [];
      for (let index = 0; index < style.length; index += 1) {
        const property = style.item(index);
        if (!property) continue;
        const rawValue = style.getPropertyValue(property);
        const value = rawValue.trim();
        if (!value && !property.startsWith("--")) continue;
        const priority = style.getPropertyPriority(property);
        declarations.push(`${property}: ${value || rawValue}${priority ? ` !${priority}` : ""};`);
      }
      return declarations.join(" ");
    };
    const isRuleActive = (rule: CSSRule) => {
      let parent = rule.parentRule;
      while (parent) {
        if (parent instanceof CSSMediaRule && !window.matchMedia(parent.conditionText).matches) {
          return false;
        }
        if (
          typeof CSSSupportsRule !== "undefined" &&
          parent instanceof CSSSupportsRule &&
          !CSS.supports(parent.conditionText)
        ) {
          return false;
        }
        parent = parent.parentRule;
      }
      return true;
    };
    const materializeEmptyDeclarations = (rule: CSSStyleRule) => {
      if (!isRuleActive(rule)) return;
      const emptyProperties: string[] = [];
      for (let index = 0; index < rule.style.length; index += 1) {
        const property = rule.style.item(index);
        if (
          property &&
          !property.startsWith("--") &&
          !rule.style.getPropertyValue(property).trim()
        ) {
          emptyProperties.push(property);
        }
      }
      if (emptyProperties.length === 0) return;

      const targets = new Set<HTMLElement>();
      for (const selector of splitSelectorList(rule.selectorText)) {
        if (/:{1,2}(?:before|after|first-letter|first-line|selection|marker|backdrop|placeholder)\b/i.test(selector)) {
          continue;
        }
        try {
          document.querySelectorAll<HTMLElement>(selector).forEach((element) => targets.add(element));
        } catch {
          continue;
        }
      }
      for (const element of targets) {
        const computed = getComputedStyle(element);
        for (const property of emptyProperties) {
          const value = computed.getPropertyValue(property).trim();
          if (value) element.style.setProperty(property, value, "important");
        }
      }
    };
    const serializeRule = (rule: CSSRule): string => {
      if (rule instanceof CSSStyleRule) {
        materializeEmptyDeclarations(rule);
        const selectors = splitSelectorList(rule.selectorText).map(scopeOneSelector).join(", ");
        return `${selectors}{${serializeStyleDeclaration(rule.style)}}`;
      }
      if (
        "cssRules" in rule &&
        !(rule instanceof CSSKeyframesRule) &&
        !(typeof CSSFontFeatureValuesRule !== "undefined" && rule instanceof CSSFontFeatureValuesRule)
      ) {
        const nested = Array.from((rule as CSSGroupingRule).cssRules).map(serializeRule).join("\n");
        const open = rule.cssText.indexOf("{");
        if (open >= 0) return `${rule.cssText.slice(0, open + 1)}${nested}}`;
      }
      return rule.cssText;
    };
    const snapshotCss: string[] = [];
    const capturedStylesheetOwners: Element[] = [];
    const preservedStylesheetOwners: Element[] = [];
    for (const stylesheet of [...Array.from(document.styleSheets), ...document.adoptedStyleSheets]) {
      const owner = stylesheet.ownerNode;
      if (owner instanceof HTMLStyleElement && owner.dataset.presentonRuntime === "html-page-shell") continue;
      try {
        snapshotCss.push(Array.from(stylesheet.cssRules).map(serializeRule).join("\n"));
        if (owner instanceof Element) capturedStylesheetOwners.push(owner);
      } catch (error) {
        if (
          owner instanceof HTMLLinkElement &&
          owner.relList.contains("stylesheet")
        ) {
          preservedStylesheetOwners.push(owner);
          continue;
        }
        throw new Error(`Unable to capture and scope a page stylesheet: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    document.querySelectorAll('link[rel="stylesheet"], style').forEach((node) => {
      if (capturedStylesheetOwners.includes(node)) {
        node.remove();
        return;
      }
      if (preservedStylesheetOwners.includes(node)) return;
      if (node instanceof HTMLStyleElement) node.remove();
    });
    if (snapshotCss.some((value) => value.trim())) {
      const capturedStyle = document.createElement("style");
      capturedStyle.setAttribute("data-presenton-snapshot-styles", scopeSelector ? "page-scoped" : "captured");
      capturedStyle.textContent = snapshotCss.join("\n");
      document.head.append(capturedStyle);
    }

    for (const style of Array.from(document.querySelectorAll("style"))) {
      const value = style.textContent ?? "";
      if (!value.includes("blob:")) continue;
      let rewrittenValue = value;
      const blobUrls = value.match(/blob:[^\s,"')]+/g) ?? [];
      for (const blobUrl of blobUrls) {
        const response = await fetch(blobUrl);
        const blob = await response.blob();
        const dataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.addEventListener("load", () => resolve(String(reader.result)), { once: true });
          reader.addEventListener("error", () => reject(reader.error), { once: true });
          reader.readAsDataURL(blob);
        });
        rewrittenValue = rewrittenValue.replaceAll(blobUrl, dataUrl);
      }
      style.textContent = rewrittenValue;
    }

    document.querySelectorAll("iframe").forEach((iframe) => iframe.remove());
    document.querySelectorAll('link[rel="preload"], link[rel="prefetch"]')
      .forEach((link) => link.remove());
    document.querySelectorAll('style[type="text/tailwindcss"]')
      .forEach((style) => style.remove());

    for (const script of Array.from(document.scripts)) script.remove();

    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name.toLowerCase().startsWith("on")) {
          element.removeAttribute(attribute.name);
          continue;
        }
        if (
          ["href", "src", "action", "formaction"].includes(attribute.name.toLowerCase()) &&
          attribute.value.trim().toLowerCase().startsWith("javascript:")
        ) {
          element.removeAttribute(attribute.name);
        }
      }
    }

    const staticStyle = document.createElement("style");
    staticStyle.setAttribute("data-presenton-snapshot-styles", "static");
    const staticTarget = scopeSelector
      ? `${scopeSelector}, ${scopeSelector} *, ${scopeSelector}::before, ${scopeSelector}::after, ${scopeSelector} *::before, ${scopeSelector} *::after`
      : "*, *::before, *::after";
    staticStyle.textContent = [
      `${staticTarget} {`,
      "  animation: none !important;",
      "  transition: none !important;",
      "}",
    ].join("\n");
    document.head.append(staticStyle);

    wrapper?.setAttribute("data-presenton-render-status", "ready");
    wrapper?.removeAttribute("data-presenton-render-message");
    document.documentElement.setAttribute("data-presenton-render-document", "static");

    return `<!doctype html>\n${document.documentElement.outerHTML}`;
  }, kind);
}
