import type { HostRuntime } from "../../src/runtime/hostRuntime";
import {
  decodeInvokePayload, encodeInvokePayload, INVOKE_INLINE_BYTES, INVOKE_TRANSPORT_TOOL, jsonBytes,
} from "../../executas/ppt-engine/invoke-transport.js";

/** Adapt business-level test doubles to the real ordinary-invoke wire protocol. */
export function withOrdinaryInvokeTransport(invoke: HostRuntime["tools"]["invoke"]): HostRuntime["tools"]["invoke"] {
  return async (input, options) => {
    if (input.method !== INVOKE_TRANSPORT_TOOL) return invoke(input, options);
    const { tool, payload } = input.args as any;
    const args = await decodeInvokePayload(payload, { download: async (ref) => new Uint8Array(await (await fetch(ref.url)).arrayBuffer()) });
    const result = await invoke({ ...input, method: tool, args: args as object }, options);
    return { success: true, data: await encodeInvokePayload({ result }, {
      fits: (frame) => jsonBytes({ success: true, data: frame, tool: INVOKE_TRANSPORT_TOOL }).length <= INVOKE_INLINE_BYTES,
      upload: async () => { throw new Error("Test response unexpectedly requires upload"); },
    }) };
  };
}
