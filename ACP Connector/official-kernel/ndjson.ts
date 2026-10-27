import { StringDecoder } from "node:string_decoder";
import { isJsonRpcMessage, type JsonRpcMessage } from "./json-rpc.js";

export function encodeNdjson(message: JsonRpcMessage): string {
  return `${JSON.stringify(message)}\n`;
}

/** 限制单条消息，保留原有可调用接口；end 用于检查 EOF 截断。 */
export function createNdjsonParser(
  onMessage: (message: JsonRpcMessage) => void,
  onInvalid?: (line: string) => void,
  options: { maxMessageBytes?: number } = {}
) {
  const maximum = options.maxMessageBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maximum) || maximum < 1) throw new Error("invalid NDJSON message limit");
  const decoder = new StringDecoder("utf8");
  let buffer = "";
  let discarding = false;
  const invalid = (line: string) => { onInvalid?.(line); };
  const parse = (chunk: Buffer | string) => {
    const decoded = typeof chunk === "string" ? decoder.end() + chunk : decoder.write(chunk);
    let offset = 0;
    while (offset < decoded.length) {
      const newline = decoded.indexOf("\n", offset);
      const fragment = decoded.slice(offset, newline < 0 ? undefined : newline);
      if (!discarding) {
        if (Buffer.byteLength(buffer, "utf8") + Buffer.byteLength(fragment, "utf8") > maximum) {
          buffer = "";
          discarding = true;
          invalid("NDJSON message exceeds configured size limit");
        } else buffer += fragment;
      }
      if (newline < 0) break;
      const line = buffer.replace(/\r$/, "").trim();
      buffer = "";
      if (!discarding && line.length > 0) {
        let parsed: unknown;
        try { parsed = JSON.parse(line); } catch { invalid(line); offset = newline + 1; continue; }
        if (isJsonRpcMessage(parsed)) onMessage(parsed);
        else invalid(line);
      }
      discarding = false;
      offset = newline + 1;
    }
  };
  return Object.assign(parse, {
    end() {
      const tail = decoder.end();
      if (tail) parse(tail);
      if (!discarding && buffer.trim()) invalid(buffer);
      buffer = "";
      discarding = false;
    }
  });
}
