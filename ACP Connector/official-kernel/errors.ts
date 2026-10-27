import { AgyTerminalProviderError } from "../admission/dispatch-boundary.js";
import { classifyProviderFailure } from "../admission/errors.js";
import { isRecord, jsonRpcError, type JsonRpcFailure, type JsonRpcId } from "./json-rpc.js";

const VISIBLE_UPDATE_KINDS = new Set([
  "agent_message_chunk",
  "agent_message",
  "message",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update"
]);

export function sessionUpdateShowsVisibleOutput(params: unknown): boolean {
  if (!isRecord(params)) return false;
  const update = isRecord(params.update) ? params.update : params;
  const kind =
    (typeof update.sessionUpdate === "string" && update.sessionUpdate) ||
    (typeof update.session_update === "string" && update.session_update) ||
    (typeof update.type === "string" && update.type) ||
    "";
  if (VISIBLE_UPDATE_KINDS.has(kind)) return true;
  if (isRecord(update.content) && typeof update.content.text === "string" && update.content.text.trim()) {
    return true;
  }
  return false;
}

export function isSuccessfulEndTurn(result: unknown): boolean {
  if (!isRecord(result)) return false;
  const stop =
    (typeof result.stopReason === "string" && result.stopReason) ||
    (typeof result.stop_reason === "string" && result.stop_reason) ||
    "end_turn";
  return stop === "end_turn" || stop === "end_of_turn";
}

export function shouldRejectBlankTurn(result: unknown, sawVisibleOutput: boolean): boolean {
  return !sawVisibleOutput && isSuccessfulEndTurn(result);
}

export function blankTurnError(id: JsonRpcId): JsonRpcFailure {
  return jsonRpcError(
    id,
    "official kernel completed the turn without visible assistant output",
    -32000
  );
}

/** 只读取结构化证据，绝不从用户/模型文本猜测错误类别。 */
export function officialResponseError(response: JsonRpcFailure): AgyTerminalProviderError {
  const data = isRecord(response.error.data) ? response.error.data : {};
  const nested = isRecord(data.error) ? data.error : data;
  const httpStatus = [nested.httpStatus, nested.status, nested.code, data.httpStatus, data.status]
    .find((value): value is number => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const code = typeof nested.code === "string" ? nested.code : typeof nested.status === "string" ? nested.status : undefined;
  const details = Array.isArray(nested.details) ? nested.details : [];
  const detail = details.find(item => isRecord(item) && typeof item.reason === "string");
  const reason = typeof nested.reason === "string" ? nested.reason : isRecord(detail) && typeof detail.reason === "string" ? detail.reason : undefined;
  return new AgyTerminalProviderError("official kernel returned a JSON-RPC error", [], null, "",
    classifyProviderFailure({ httpStatus, code, reason }));
}
