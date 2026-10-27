import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { isRecord, type JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";

it("proxy 协商原生快照并为 new/load/resume 注册和撤销独立技能 MCP", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "proxy-native-skills-"));
  await mkdir(path.join(home, "agents"));
  await writeFile(path.join(home, "agents/agent.json"), JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: "原生 daemon 正文" } } }), "utf8");
  await mkdir(path.join(home, ".agents/skills/example"), { recursive: true });
  await writeFile(path.join(home, ".agents/skills/example/SKILL.md"), "---\nname: example\n---\n技能正文", "utf8");
  const child = spawn(process.execPath, ["-e", `const readline = require('node:readline');
    const send = message => process.stdout.write(JSON.stringify(message) + '\\n');
    readline.createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line); if (!('id' in m)) return;
      if (m.method === 'initialize') send({ jsonrpc:'2.0', id:m.id, result:{ agentCapabilities:{ _meta:{ antigravity:{systemPrompt:{append:true}}}}}});
      else if (m.method === 'session/prompt') {
        send({jsonrpc:'2.0', method:'session/update', params:{sessionId:'session',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'visible'}}}});
        send({jsonrpc:'2.0',id:m.id,result:{stopReason:'end_turn', received:m.params}});
      } else send({jsonrpc:'2.0',id:m.id,result:{sessionId:'session',received:m.params}});
    });`], { stdio: ["pipe", "pipe", "pipe"] });
  const input = new PassThrough();
  const output = new PassThrough();
  const proxy = new OfficialKernelProxy({ child, stdin: input, stdout: output, version: "test", env: {
    HOME: home, PASEO_HOME: home, PASEO_AGENT_ID: "agent", PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT: "1"
  } });
  const pending = new Map<number, (message: JsonRpcMessage) => void>();
  output.on("data", createNdjsonParser(message => {
    if ("id" in message && typeof message.id === "number") { pending.get(message.id)?.(message); pending.delete(message.id); }
  }));
  let sequence = 0;
  const rpc = (method: string, params: unknown) => new Promise<JsonRpcMessage>(resolve => {
    const id = ++sequence; pending.set(id, resolve);
    input.write(encodeNdjson({ jsonrpc: "2.0", id, method, params }));
  });
  const started = proxy.start();
  try {
    await rpc("initialize", { protocolVersion: 1 });
    let previousUrl: string | undefined;
    for (const method of ["session/new", "session/load", "session/resume"]) {
      const message = await rpc(method, { cwd: home, sessionId: "session", _meta: { preserved: true,
        antigravity: { systemPrompt: { append: "用户 append" } } },
        mcpServers: [{ name: "custom", type: "http", url: "http://127.0.0.1:9/mcp", headers: [] },
          { name: "paseo_skills", type: "http", url: "http://127.0.0.1:9/user-owned", headers: [] }] });
      expect(message).toMatchObject({ result: { received: { _meta: { preserved: true,
        antigravity: { systemPrompt: { append: "用户 append\n\n原生 daemon 正文" } } } } } });
      expect("result" in message && isRecord(message.result) && isRecord(message.result.received)).toBe(true);
      const received = (message as unknown as { result: { received: { mcpServers: Array<{ name: string; url: string }> } } }).result.received;
      expect(received.mcpServers.map(server => server.name)).toEqual(["custom", "paseo_skills", "paseo_skills_2"]);
      const url = received.mcpServers[2]!.url;
      const skills = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({
        jsonrpc: "2.0", id: "read", method: "tools/call", params: { name: "read_skill", arguments: { name: "example" } }
      }) });
      expect(await skills.text()).toContain("技能正文");
      if (previousUrl) expect((await fetch(previousUrl)).status).toBe(404);
      previousUrl = url;
      const prompt = await rpc("session/prompt", { sessionId: "session", prompt: [{ type: "text", text: "问题" }] });
      expect(prompt).toMatchObject({ result: { received: { prompt: [{ type: "text", text: "问题" }] } } });
    }
  } finally {
    input.end();
    await started;
    await rm(home, { recursive: true, force: true });
  }
});
