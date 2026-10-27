import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpProtocolBridge, bridgeOfficialMcpServers, downgradeMcpInitializeBody, downgradeMcpProtocolVersion } from "../ACP Connector/official-kernel/mcp-protocol-bridge.js";

const bridges: McpProtocolBridge[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("MCP protocol bridge", () => {
  it.each(["\n", "\r", "\r\n"].flatMap(ending =>
    [true, false].flatMap(dataFirst => [true, false].map(absolute => ({ ending, dataFirst, absolute })))
  ))("按完整事件处理 endpoint：ending=$ending dataFirst=$dataFirst absolute=$absolute", async ({ ending, dataFirst, absolute }) => {
    const upstream = createServer((_request, response) => {
      const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      const data = `data: ${absolute ? origin : ""}/message?session=abc`;
      const event = dataFirst ? [data, "event: endpoint"] : ["event: endpoint", data];
      const text = [...event, "", "data: " + origin + "/tool-docs", "event: message", "", ""].join(ending);
      response.writeHead(200, { "content-type": "text/event-stream" });
      // 每个字节单独写，覆盖字段和 CRLF 跨 chunk。
      for (const byte of Buffer.from(text, "utf8")) response.write(Buffer.from([byte]));
      response.end();
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const bridge = new McpProtocolBridge(); bridges.push(bridge);
    const url = await bridge.register(`${origin}/events`);
    const prefix = url.slice(0, url.indexOf("/events"));
    const data = `data: ${prefix}/message?session=abc`;
    const event = dataFirst ? [data, "event: endpoint"] : ["event: endpoint", data];
    expect(await (await fetch(url)).text()).toBe([...event, "", "data: " + origin + "/tool-docs", "event: message", "", ""].join(ending));
  });

  it("合并多 data 字段并使用最后 event 字段；不改正文、注释和未完成事件", async () => {
    let body = "";
    const upstream = createServer((_request, response) => {
      const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      body = [
        `data:${origin}/message`, "event: message", ": endpoint comment", "data: ?session=abc", "event: endpoint", "",
        `data: ${origin}/docs`, "event: endpoint", "event: message", "",
        `data: ${origin}/empty-event`, "event: endpoint", "event", "",
        "data:", `data: ${origin}/leading-newline`, "event: endpoint", "",
        `data: ${origin}/extra-space-event`, "event:  endpoint", "",
        `data: ${origin}/incomplete`, "event: endpoint"
      ].join("\n");
      response.writeHead(200, { "content-type": "text/event-stream" }).end(body);
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    const bridge = new McpProtocolBridge(); bridges.push(bridge);
    const url = await bridge.register(`${origin}/events`);
    const prefix = url.slice(0, url.indexOf("/events"));
    expect(await (await fetch(url)).text()).toBe(body.replace(`data:${origin}/message`, `data:${prefix}/message`));
  });

  it.each(["application/json", "text/plain", "text/event-stream"])("%s 工具正文中的上游 URL 保持原文", async contentType => {
    let body = "";
    const upstream = createServer((_request, response) => {
      const origin = `http://127.0.0.1:${(upstream.address() as { port: number }).port}`;
      const text = `工具文档引用 ${origin}/docs 保持原文`;
      body = contentType === "text/event-stream" ? `event: message\ndata: ${JSON.stringify({ text })}\n\n` : text;
      response.writeHead(200, { "content-type": contentType }).end(body);
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const bridge = new McpProtocolBridge(); bridges.push(bridge);
    const url = await bridge.register(`http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp`);
    expect(await (await fetch(url)).text()).toBe(body);
  });

  it.each([
    { name: "LF", chunks: ["event: endpoint\ndata: /message?session=abc\n\nevent: message\ndata: /ordinary\n\n"] },
    { name: "CR", chunks: ["event: endpoint\rdata: /message?session=abc\r\revent: message\rdata: /ordinary\r\r"] },
    { name: "CRLF", chunks: ["event: endpoint\r\ndata: /message?session=abc\r\n\r\nevent: message\r\ndata: /ordinary\r\n\r\n"] },
    { name: "跨 chunk CRLF", chunks: ["event: endpoint\r", "\ndata: /message?session=abc\r", "\n\r", "\nevent: message\r", "\ndata: /ordinary\r", "\n\r", "\n"] },
    { name: "data-first 跨 chunk CRLF", chunks: ["data: /message?session=abc\r", "\nevent: end", "point\r", "\n\r", "\ndata: /ordinary\r", "\nevent: message\r", "\n\r", "\n"] },
    { name: "data-first 跨 chunk CR", chunks: ["data: /message?session=abc\r", "event: endpoint\r", "\rdata: /ordinary\revent: message\r\r"] },
    { name: "data-first 跨 chunk LF", chunks: ["data: /message?session=abc\n", "event: endpoint\n", "\ndata: /ordinary\nevent: message\n\n"] },
    { name: "混合换行", chunks: ["event: endpoint\rdata: /message?session=abc\n\r", "\nevent: message\ndata: /ordinary\r\n\r"] }
  ])("$name 换行的 SSE 在长连接保持打开时及时重写并转发", async ({ chunks }) => {
    let source!: ServerResponse;
    const upstream = createServer((_request, response) => {
      source = response;
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.flushHeaders();
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const port = (upstream.address() as { port: number }).port;
    const localUrl = await bridge.register(`http://127.0.0.1:${port}/events`);
    const prefix = localUrl.slice(0, localUrl.indexOf("/events"));
    const expected = chunks.join("").replace("data: /message", `data: ${prefix}/message`);
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 1_000);
    try {
      const response = fetch(localUrl, { signal: abort.signal });
      const received = (async () => {
        const reader = (await response).body!.getReader();
        const decoder = new TextDecoder();
        let text = "";
        while (text.length < expected.length) {
          const { done, value } = await reader.read();
          if (done) break;
          text += decoder.decode(value, { stream: true });
        }
        return text;
      })();
      // 立即捕获超时拒绝，随后仍由 await received 报告失败。
      void received.catch(() => {});
      await vi.waitFor(() => expect(source).toBeDefined());
      for (const chunk of chunks) {
        source.write(chunk);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      expect(await received).toBe(expected);
      expect(source.writableEnded).toBe(false);
    } finally {
      clearTimeout(timer);
      abort.abort();
    }
  });

  it("关闭未启动、并发启动和正在启动的 bridge 均可重复调用", async () => {
    const unused = new McpProtocolBridge();
    await Promise.all([unused.close(), unused.close()]);
    await expect(unused.register("http://127.0.0.1:9/mcp")).rejects.toThrow(/closed/);

    const bridge = new McpProtocolBridge();
    const urls = await Promise.all([bridge.register("http://127.0.0.1:9/one"), bridge.register("http://127.0.0.1:9/two")]);
    expect(new URL(urls[0]!).origin).toBe(new URL(urls[1]!).origin);
    await Promise.all([bridge.close(), bridge.close()]);

    const starting = new McpProtocolBridge();
    const registered = expect(starting.register("http://127.0.0.1:9/mcp")).rejects.toThrow(/closed/);
    await starting.close();
    await registered;
  });

  it("重写拆包的根相对 SSE endpoint，保留查询串和 UTF-8 正文", async () => {
    const seen: string[] = [];
    const upstream = createServer((request, response) => {
      seen.push(request.url ?? "");
      if (request.url?.startsWith("/mcp/message")) {
        response.end("accepted");
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: end");
      const body = Buffer.from("point\r\ndata: /mcp/message?sessionId=abc&caller=1\r\n\r\nevent: message\ndata: 中文正文\n\n", "utf8");
      const split = body.indexOf(Buffer.from("中", "utf8")) + 1;
      response.write(body.subarray(0, split));
      setTimeout(() => response.end(body.subarray(split)), 10);
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const port = (upstream.address() as { port: number }).port;
    const url = await bridge.register(`http://127.0.0.1:${port}/mcp/agents?caller=1`);
    const text = await (await fetch(url)).text();
    const endpoint = text.match(/data: (http[^\r\n]+)/)?.[1];
    expect(endpoint).toBe(`${url.slice(0, url.indexOf("/mcp/agents"))}/mcp/message?sessionId=abc&caller=1`);
    expect(text).toContain("data: 中文正文");
    expect(await (await fetch(endpoint!, { method: "POST", body: "{}" })).text()).toBe("accepted");
    expect(seen).toEqual(["/mcp/agents?caller=1", "/mcp/message?sessionId=abc&caller=1"]);
  });

  it("关闭 bridge 会终止 SSE 和上游连接", async () => {
    let disconnected!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { disconnected = resolve; });
    const upstream = createServer((_request, response) => {
      response.on("close", disconnected);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: endpoint\ndata: /mcp/message\n\n");
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const port = (upstream.address() as { port: number }).port;
    const url = await bridge.register(`http://127.0.0.1:${port}/mcp`);
    const response = await fetch(url);
    const body = response.text().catch(() => "closed");
    await bridge.close();
    await upstreamClosed;
    await body;
    await expect(fetch(url)).rejects.toThrow();
  });

  it("客户端中断 SSE 后释放对应上游连接", async () => {
    let disconnected!: () => void;
    const upstreamClosed = new Promise<void>(resolve => { disconnected = resolve; });
    const upstream = createServer((_request, response) => {
      response.on("close", disconnected);
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.write("event: endpoint\ndata: /mcp/message\n\n");
    });
    await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
    closers.push(() => new Promise(resolve => upstream.close(() => resolve())));
    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const port = (upstream.address() as { port: number }).port;
    const url = await bridge.register(`http://127.0.0.1:${port}/mcp`);
    const response = await fetch(url);
    await response.body!.cancel();
    await upstreamClosed;
  });

  it("leaves an already accepted protocol version unchanged", () => {
    expect(downgradeMcpProtocolVersion("2025-11-25")).toBe("2025-11-25");
    expect(downgradeMcpProtocolVersion("2025-06-18")).toBe("2025-06-18");
  });

  it("forwards only http and https MCP server URLs", async () => {
    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const bridged = await bridgeOfficialMcpServers({
      mcpServers: [
        { name: "local", type: "stdio", command: "paseo" },
        { name: "paseo", type: "sse", url: "http://127.0.0.1:9/mcp" }
      ]
    }, bridge);
    const servers = (bridged as { mcpServers: Array<{ url?: string; command?: string }> }).mcpServers;
    expect(servers[0]).toEqual({ name: "local", type: "stdio", command: "paseo" });
    expect(servers[1]?.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/b\/[a-f0-9]{16}\/mcp$/);
  });

  it("downgrades the harness protocol version before forwarding to Paseo", async () => {
    expect(downgradeMcpProtocolVersion("2026-07-28")).toBe("2025-11-25");
    const body = downgradeMcpInitializeBody(
      Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } })),
      "application/json"
    );
    expect(JSON.parse(body.toString("utf8")).params.protocolVersion).toBe("2025-11-25");

    const seen: Array<{ version: string | undefined; body: string }> = [];
    const upstream = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const version = request.headers["mcp-protocol-version"];
        seen.push({ version: Array.isArray(version) ? version[0] : version, body: Buffer.concat(chunks).toString("utf8") });
        if (version === "2026-07-28") {
          response.writeHead(400, { "content-type": "application/json" }).end(
            JSON.stringify({ error: "Unsupported protocol version: 2026-07-28" })
          );
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" }).end(
          `event: endpoint\ndata: http://127.0.0.1:${(upstream.address() as { port: number }).port}/mcp/message\n\n`
        );
      });
    });
    upstream.listen(0, "127.0.0.1");
    await once(upstream, "listening");
    closers.push(() => new Promise((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve())));
    const port = (upstream.address() as { port: number }).port;

    const bridge = new McpProtocolBridge();
    bridges.push(bridge);
    const localUrl = await bridge.register(`http://127.0.0.1:${port}/mcp/agents?caller=1`);
    const response = await fetch(localUrl, {
      method: "POST",
      headers: { "content-type": "application/json", "mcp-protocol-version": "2026-07-28" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2026-07-28" } })
    });
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(seen).toEqual([{
      version: "2025-11-25",
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-11-25" } })
    }]);
    expect(text).toBe(
      `event: endpoint\ndata: ${new URL(localUrl).origin}/b/${new URL(localUrl).pathname.split("/")[2]}/mcp/message\n\n`
    );
  });
});
