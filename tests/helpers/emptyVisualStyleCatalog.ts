import { registerHooks } from "node:module";

/** UI tests supply their own presets; Node does not implement Vite's asset glob. */
export async function withEmptyVisualStyleCatalog<T>(load: () => Promise<T>): Promise<T> {
  const hooks = registerHooks({ load(url, context, nextLoad) {
    const result = nextLoad(url, context);
    return url.endsWith("/templates/visualStylePresets.ts")
      ? { ...result, source: `import.meta.glob = () => ({});\n${result.source}` }
      : result;
  } });
  try {
    return await load();
  } finally {
    hooks.deregister();
  }
}
