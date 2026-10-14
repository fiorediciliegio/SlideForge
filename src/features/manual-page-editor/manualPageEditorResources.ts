import type { ManualPageResource } from "../../api/types";

/** One editing session retains URL aliases for undo history and in-flight edits. */
export class EditorResources {
  private readonly current = new Map<string, ManualPageResource>();
  private readonly aliases = new Map<string, string>();

  merge(resources: readonly ManualPageResource[]): void {
    for (const resource of resources) {
      if (!resource.local_url.startsWith("file://") || !resource.url.startsWith("https://") || !Number.isFinite(Date.parse(resource.expires_at))) throw new Error("Invalid editor resource mapping");
      // Identical bytes can have several local paths. Keep the first inverse
      // mapping stable so another image insertion does not dirty old content.
      if (!this.aliases.has(resource.url)) this.aliases.set(resource.url, resource.local_url);
      const previous = this.current.get(resource.local_url);
      if (!previous || Date.parse(resource.expires_at) >= Date.parse(previous.expires_at)) {
        this.current.set(resource.local_url, resource);
      }
    }
  }

  get localUrls(): string[] { return [...this.current.keys()]; }
  get needsRefresh(): boolean { return [...this.current.values()].some((entry) => Date.parse(entry.expires_at) <= Date.now() + 60_000); }
  displayUrl(localUrl: string): string { return this.current.get(localUrl)?.url ?? localUrl; }
  resource(localUrl: string): ManualPageResource | undefined { return this.current.get(localUrl); }

  rewrite(root: Element, direction: "local" | "display"): void {
    const replacements = direction === "local" ? this.aliases
      : new Map([...this.current].map(([local, resource]) => [local, resource.url]));
    if (!replacements.size) return;
    // URLs are matched as literal strings, after HTML entities have been decoded
    // by the DOM. This covers CSS URLs, srcset and SVG references without touching text.
    const keys = [...replacements.keys()].sort((a, b) => b.length - a.length);
    const pattern = new RegExp(keys.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    const replace = (value: string) => value.replace(pattern, (url) => replacements.get(url)!);
    const visit = (element: Element) => {
      for (const attr of Array.from(element.attributes)) {
        if (["src", "srcset", "href", "xlink:href", "poster", "style"].includes(attr.name)) attr.value = replace(attr.value);
      }
      if (element.tagName.toLowerCase() === "style") element.textContent = replace(element.textContent ?? "");
      for (const child of Array.from(element.children)) visit(child);
      if (element.tagName.toLowerCase() === "template") {
        for (const child of Array.from((element as HTMLTemplateElement).content.children)) visit(child);
      }
    };
    visit(root);
  }
}

const documents = new WeakMap<Document, EditorResources>();
export function bindEditorResources(document: Document, resources: EditorResources): void { documents.set(document, resources); }
export function localizeEditorSnapshot(document: Document, root: Element): void { documents.get(document)?.rewrite(root, "local"); }

export function displayEditorHtml(html: string, resources: EditorResources): string {
  const document = new DOMParser().parseFromString(html, "text/html");
  resources.rewrite(document.documentElement, "display");
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}
