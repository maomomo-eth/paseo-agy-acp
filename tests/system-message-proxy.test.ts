import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter, once } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";

function harness() {
  // 使用可控的 NDJSON 流验证真实代理的结束与取消路径，不启动用户会话。
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  });
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const messages: JsonRpcMessage[] = [];
  stdout.on("data", createNdjsonParser(message => messages.push(message)));
  const proxy = new OfficialKernelProxy({
    child: child as unknown as ChildProcessWithoutNullStreams,
    stdin, stdout, env: {}, version: "test"
  });
  const running = proxy.start();
  return {
    messages,
    async prompt(id: number) {
      const forwarded = once(child.stdin, "data");
      stdin.write(encodeNdjson({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "test-session", prompt: [{ type: "text", text: "test" }] } }));
      await forwarded;
    },
    text(text: string) {
      child.stdout.write(encodeNdjson({ jsonrpc: "2.0", method: "session/update", params: { sessionId: "test-session", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } }));
    },
    reply(message: JsonRpcMessage) { child.stdout.write(encodeNdjson(message)); },
    cancel() { stdin.write(encodeNdjson({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: "test-session" } })); },
    async close() { child.emit("exit", 0); await running; }
  };
}

describe("系统消息在代理生命周期中的刷新", () => {
  it.each(["end_turn", "cancelled", "error"])("%s 响应之前刷新未闭合正文，下一轮不受影响", async reason => {
    const h = harness();
    try {
      await h.prompt(1);
      const text = "<SYSTEM_MESSAGE>\n[Message] sender=test-task\n\n### 后续正文";
      h.text(text);
      expect(h.messages).toEqual([]);
      const reply: JsonRpcMessage = reason === "error"
        ? { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "test error" } }
        : { jsonrpc: "2.0", id: 1, result: { stopReason: reason } };
      h.reply(reply);
      expect(h.messages).toHaveLength(2);
      expect(h.messages[0]).toMatchObject({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text } } } });
      expect(h.messages[1]).toEqual(reply);
      await h.prompt(2);
      h.text("### 下一轮正常正文");
      expect(h.messages[2]).toMatchObject({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "### 下一轮正常正文" } } } });
      h.reply({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
    } finally {
      await h.close();
    }
  });

  it("取消通知刷新一次缓冲，后续取消响应不重复输出", async () => {
    const h = harness();
    try {
      await h.prompt(1);
      h.text("<SYSTEM_");
      expect(h.messages).toEqual([]);
      h.cancel();
      expect(h.messages).toHaveLength(1);
      expect(h.messages[0]).toMatchObject({ params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "<SYSTEM_" } } } });
      h.reply({ jsonrpc: "2.0", id: 1, result: { stopReason: "cancelled" } });
      expect(h.messages).toHaveLength(2);
    } finally {
      await h.close();
    }
  });
});
