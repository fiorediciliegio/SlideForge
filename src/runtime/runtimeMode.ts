export type RuntimeMode = "host" | "mock";

export function detectRuntimeMode(): RuntimeMode {
  if (typeof window !== "undefined" && "HostAppRuntime" in window) {
    return "host";
  }

  if (typeof window !== "undefined") {
    const params = new URLSearchParams(window.location.search);
    if (params.has("wid") && params.has("t")) {
      return "host";
    }
  }

  if (import.meta.env.MODE === "test") {
    return "mock";
  }

  throw new Error(
    "HostAppRuntime is not available. Run the app with `npm run dev`, `npm run dev:mock-llm`, or inside the SlideForge host."
  );
}
