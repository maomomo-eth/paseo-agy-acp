import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { McpProtocolBridge, bridgeOfficialMcpServers, downgradeMcpInitializeBody, downgradeMcpProtocolVersion } from "../ACP Connector/official-kernel/mcp-protocol-bridge.js";

const bridges: McpProtocolBridge[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close()));
  await Promise.all(closers.splice(0).map((close) => close()));
});

describe("MCP protocol bridge", () => {
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
