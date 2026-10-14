import { decodeInvokePayload, encodeInvokePayload, INVOKE_INLINE_BYTES, INVOKE_TRANSPORT_TOOL, jsonBytes } from "../../invoke-transport.js";
import { downloadInvokeUpload } from "../../invoke-transport-server.js";

/** Business integration tests use the same gateway framing as the App. */
export async function encodeToolRequest(request: any) {
  if (request.method !== "invoke") return request;
  const { tool, arguments: args = {}, ...context } = request.params;
  const wrap = (payload: unknown) => ({ ...request, params: { ...context, tool: INVOKE_TRANSPORT_TOOL, arguments: { tool, payload } } });
  const payload = await encodeInvokePayload(args, {
    fits: (frame: unknown) => jsonBytes(wrap(frame)).length <= INVOKE_INLINE_BYTES,
    upload: async () => { throw new Error("Test request requires a Host Upload fixture"); },
  });
  return wrap(payload);
}

export async function decodeToolResponse(response: any) {
  if (response.result?.tool !== INVOKE_TRANSPORT_TOOL || response.error) return response;
  const outcome = await decodeInvokePayload(response.result.data, { download: downloadInvokeUpload });
  return { jsonrpc: response.jsonrpc, id: response.id, ...outcome };
}
