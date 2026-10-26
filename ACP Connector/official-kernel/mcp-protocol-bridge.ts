import { randomBytes } from "node:crypto";
import { createServer, request as httpRequest, type ClientRequest, type IncomingHttpHeaders, type IncomingMessage, type OutgoingHttpHeaders, type ServerResponse } from "node:http";
import { request as httpsRequest } from "node:https";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { isRecord } from "./json-rpc.js";

const HARNESS_PROTOCOL_VERSION = "2026-07-28";
const PASEO_PROTOCOL_VERSION = "2025-11-25";

export function downgradeMcpProtocolVersion(value: string): string {
  return value === HARNESS_PROTOCOL_VERSION ? PASEO_PROTOCOL_VERSION : value;
}

export function downgradeMcpInitializeBody(body: Buffer, contentType: string): Buffer {
  if (!contentType.toLowerCase().includes("json")) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    return body;
  }
  if (!downgradeInitializeMessage(parsed)) return body;
  return Buffer.from(JSON.stringify(parsed));
}

function downgradeInitializeMessage(message: unknown): boolean {
  if (Array.isArray(message)) return message.some(downgradeInitializeMessage);
  if (!isRecord(message) || message.method !== "initialize" || !isRecord(message.params)) return false;
  if (message.params.protocolVersion !== HARNESS_PROTOCOL_VERSION) return false;
  message.params.protocolVersion = PASEO_PROTOCOL_VERSION;
  return true;
}

export class McpProtocolBridge {
  #server = createServer((request, response) => {
    void this.#forward(request, response);
  });
  #port = 0;
  #starting?: Promise<void>;
  #closing?: Promise<void>;
  #closed = false;
  readonly #requests = new Set<ClientRequest>();
  readonly #upstreams = new Map<string, URL>();

  async start(): Promise<void> {
    if (this.#closed) throw new Error("MCP protocol bridge is closed");
    if (this.#port !== 0) return;
    this.#starting ??= new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        const address = this.#server.address();
        if (address === null || typeof address === "string") {
          reject(new Error("MCP protocol bridge did not bind a local port"));
          return;
        }
        this.#port = address.port;
        resolve();
      });
    });
    await this.#starting;
  }

  async register(target: string): Promise<string> {
    const upstream = new URL(target);
    if (upstream.protocol !== "http:" && upstream.protocol !== "https:") {
      throw new Error("MCP protocol bridge only forwards http and https servers");
    }
    await this.start();
    if (this.#closed) throw new Error("MCP protocol bridge is closed");
    const id = randomBytes(8).toString("hex");
    this.#upstreams.set(id, upstream);
    const local = new URL(`http://127.0.0.1:${this.#port}/b/${id}${upstream.pathname}`);
    local.search = upstream.search;
    return local.toString();
  }

  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= (async () => {
      await this.#starting?.catch(() => {});
      this.#upstreams.clear();
      for (const request of this.#requests) request.destroy();
      this.#requests.clear();
      if (!this.#server.listening) return;
      await new Promise<void>((resolve, reject) => {
        this.#server.close((error) => error ? reject(error) : resolve());
        // SSE 是长连接，内核退出后不能继续等待它自然结束。
        this.#server.closeAllConnections();
      });
      this.#port = 0;
    })();
    return this.#closing;
  }

  async #forward(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      const incoming = new URL(request.url ?? "/", "http://127.0.0.1");
      const match = incoming.pathname.match(/^\/b\/([a-f0-9]{16})(\/.*)?$/);
      const bridgeId = match?.[1];
      const upstreamPath = match?.[2];
      const upstream = bridgeId ? this.#upstreams.get(bridgeId) : undefined;
      if (bridgeId === undefined || upstream === undefined) {
        response.writeHead(404).end();
        return;
      }
      const destination = new URL(upstream.origin);
      destination.pathname = upstreamPath && upstreamPath.length > 0 ? upstreamPath : "/";
      destination.search = incoming.search;
      const body = await readBody(request);
      if (this.#closed || response.destroyed) return;
      const contentType = headerValue(request.headers["content-type"]);
      const forwardedBody = downgradeMcpInitializeBody(body, contentType);
      const headers = downgradeRequestHeaders(request.headers, destination, forwardedBody.length);
      const transport = destination.protocol === "https:" ? httpsRequest : httpRequest;
      const upstreamRequest = transport(destination, { method: request.method, headers });
      this.#requests.add(upstreamRequest);
      upstreamRequest.once("close", () => this.#requests.delete(upstreamRequest));
      response.once("close", () => upstreamRequest.destroy());
      upstreamRequest.on("error", () => {
        if (!response.headersSent) response.writeHead(502).end();
        else response.end();
      });
      upstreamRequest.on("response", (upstreamResponse) => {
        upstreamResponse.on("error", () => response.destroy());
        const responseHeaders: OutgoingHttpHeaders = { ...upstreamResponse.headers };
        delete responseHeaders["transfer-encoding"];
        delete responseHeaders["content-length"];
        const local = `http://127.0.0.1:${this.#port}/b/${bridgeId}`;
        if (typeof responseHeaders.location === "string") {
          responseHeaders.location = rewriteEndpoint(responseHeaders.location, upstream.origin, local);
        }
        response.writeHead(upstreamResponse.statusCode ?? 502, responseHeaders);
        const responseType = headerValue(upstreamResponse.headers["content-type"]);
        if (!shouldRewriteResponse(responseType)) {
          upstreamResponse.pipe(response);
          return;
        }
        const rewritten = upstreamResponse.pipe(replaceOriginStream(upstream.origin, local));
        if (responseType.toLowerCase().includes("text/event-stream")) {
          rewritten.pipe(rewriteSseEndpointStream(upstream.origin, local)).pipe(response);
        } else {
          rewritten.pipe(response);
        }
      });
      upstreamRequest.end(forwardedBody);
    } catch {
      if (!response.headersSent) response.writeHead(502).end();
      else response.end();
    }
  }
}

export async function bridgeOfficialMcpServers(params: unknown, bridge: McpProtocolBridge): Promise<unknown> {
  if (!isRecord(params) || !Array.isArray(params.mcpServers)) return params;
  const servers = [];
  for (const server of params.mcpServers) {
    if (!isRecord(server) || typeof server.url !== "string" || !/^https?:\/\//i.test(server.url)) {
      servers.push(server);
      continue;
    }
    servers.push({ ...server, url: await bridge.register(server.url) });
  }
  return { ...params, mcpServers: servers };
}

function downgradeRequestHeaders(headers: IncomingHttpHeaders, destination: URL, contentLength: number): OutgoingHttpHeaders {
  const next: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (name === "host" || name === "connection" || name === "content-length" || name === "transfer-encoding") continue;
    if (name === "mcp-protocol-version") {
      const current = Array.isArray(value) ? value[0] : value;
      next[name] = downgradeMcpProtocolVersion(current);
      continue;
    }
    next[name] = value;
  }
  next.host = destination.host;
  next["content-length"] = contentLength;
  return next;
}

function replaceOriginStream(origin: string, local: string): Transform {
  let pending = "";
  const decoder = new StringDecoder("utf8");
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk);
      const suffix = originPrefixLength(pending, origin);
      const emit = pending.slice(0, pending.length - suffix).replaceAll(origin, local);
      pending = pending.slice(pending.length - suffix);
      callback(null, emit);
    },
    flush(callback) {
      pending += decoder.end();
      callback(null, pending.replaceAll(origin, local));
    }
  });
}

function rewriteEndpoint(value: string, origin: string, local: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) return `${local}${value}`;
  return value.replaceAll(origin, local);
}

function rewriteSseEndpointStream(origin: string, local: string): Transform {
  let pending = "";
  let endpointEvent = false;
  const decoder = new StringDecoder("utf8");
  const rewriteLine = (line: string): string => {
    if (line.trim().length === 0) endpointEvent = false;
    if (line.startsWith("event:")) endpointEvent = line.slice(6).trim() === "endpoint";
    if (!endpointEvent) return line;
    return line.replace(/^(data: ?)([^\r\n]+)(\r?\n)?$/, (_match, prefix: string, value: string, ending: string | undefined) =>
      `${prefix}${rewriteEndpoint(value, origin, local)}${ending ?? ""}`);
  };
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      pending += decoder.write(chunk);
      let newline: number;
      while ((newline = pending.indexOf("\n")) !== -1) {
        this.push(rewriteLine(pending.slice(0, newline + 1)));
        pending = pending.slice(newline + 1);
      }
      callback();
    },
    flush(callback) {
      callback(null, rewriteLine(pending + decoder.end()));
    }
  });
}

function originPrefixLength(value: string, origin: string): number {
  const max = Math.min(origin.length - 1, value.length);
  for (let length = max; length > 0; length -= 1) {
    if (origin.startsWith(value.slice(value.length - length))) return length;
  }
  return 0;
}

function shouldRewriteResponse(contentType: string): boolean {
  const type = contentType.toLowerCase();
  return type.includes("json") || type.includes("text/event-stream") || type.startsWith("text/");
}

function headerValue(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? "" : value ?? "";
}

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}
