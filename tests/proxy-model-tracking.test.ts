import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import type { AdmissionTurnInput } from "../ACP Connector/admission/turn-coordinator.js";
import { createOfficialAdmission } from "../ACP Connector/official-kernel/admission-fence.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";

vi.mock("../ACP Connector/official-kernel/admission-fence.js", async original => ({
  ...await original<typeof import("../ACP Connector/official-kernel/admission-fence.js")>(), createOfficialAdmission: vi.fn()
}));
afterEach(() => vi.mocked(createOfficialAdmission).mockReset());

function harness() {
  const admitted: string[] = [];
  vi.mocked(createOfficialAdmission).mockReturnValue({
    coordinator: { async admit(input: AdmissionTurnInput) { admitted.push(input.model); return "cancelled"; }, close() {} },
    runtime: { close() {} }
  } as never);
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough()
  });
  const stdin = new PassThrough(); const stdout = new PassThrough();
  const forwarded: JsonRpcMessage[] = [];
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message)));
  const proxy = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams, stdin, stdout, env: {}, version: "test" });
  const running = proxy.start();
  let id = 0;
  const reply = (message: JsonRpcMessage) => child.stdout.write(encodeNdjson(message));
  return {
    admitted, reply,
    async request(method: string, extra: Record<string, unknown>, result: unknown = {}, failed = false) {
      const requestId = ++id;
      stdin.write(encodeNdjson({ id: requestId, method, params: { sessionId: "s", ...extra } }));
      await vi.waitFor(() => expect(forwarded.some(message => "id" in message && message.id === requestId)).toBe(true));
      reply(failed ? { id: requestId, error: { code: -32000, message: "rejected" } } : { id: requestId, result });
    },
    async model() {
      const count = admitted.length;
      stdin.write(encodeNdjson({ id: ++id, method: "session/prompt", params: { sessionId: "s", prompt: "hello" } }));
      await vi.waitFor(() => expect(admitted).toHaveLength(count + 1));
      return admitted.at(-1);
    },
    async close() { child.emit("close", 0); await running; }
  };
}

const family = (currentValue: string) => ({ configOptions: [{ id: "model", category: "model", currentValue }] });

it("普通配置快照保留具体 model ID，成功显式配置切换清除旧实际 ID", async () => {
  const h = harness();
  try {
    await h.request("session/load", {}, { sessionId: "s", models: { currentModelId: "gemini-3-pro-high" }, ...family("gemini") });
    expect(await h.model()).toBe("gemini-3-pro-high");
    h.reply({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "config_option_update", ...family("claude") } } });
    expect(await h.model()).toBe("gemini-3-pro-high");
    await h.request("session/set_config_option", { configId: "model", value: "claude" }, family("claude"));
    expect(await h.model()).toBe("claude");
    await h.request("session/set_config_option", { configId: "model", value: "new-concrete-id" }, family("new-concrete-id"));
    expect(await h.model()).toBe("new-concrete-id");
  } finally { await h.close(); }
});

it("set_model 只在成功后改变 Admission model，内核回执具体 ID 优先于请求 ID", async () => {
  const h = harness();
  try {
    await h.request("session/load", {}, { sessionId: "s", modelId: "before" });
    expect(await h.model()).toBe("before");
    await h.request("session/set_model", { modelId: "after" }, family("family"));
    expect(await h.model()).toBe("after");
    await h.request("session/set_model", { modelId: "alias" }, { models: { currentModelId: "canonical-model" }, ...family("family") });
    expect(await h.model()).toBe("canonical-model");
    await h.request("session/set_model", { modelId: "rejected-model" }, {}, true);
    expect(await h.model()).toBe("canonical-model");
  } finally { await h.close(); }
});

it("没有具体 model ID 时使用配置 fallback，随后可信实际 ID 取代 fallback", async () => {
  const h = harness();
  try {
    await h.request("session/load", {}, { sessionId: "s", ...family("family-a") });
    expect(await h.model()).toBe("family-a");
    await h.request("session/set_config_option", { configId: "model", value: "family-b" });
    expect(await h.model()).toBe("family-b");
    h.reply({ method: "session/update", params: { sessionId: "s", update: { sessionUpdate: "current_model_update", currentModelId: "actual-b", ...family("family-b") } } });
    expect(await h.model()).toBe("actual-b");
  } finally { await h.close(); }
});


it("thinking_level 切换也清旧变体 ID，失败配置切换保持原实际 ID", async () => {
  const h = harness();
  try {
    await h.request("session/load", {}, { sessionId: "s", currentModelId: "gemini-high", ...family("gemini") });
    await h.request("session/set_config_option", { configId: "model", value: "rejected" }, {}, true);
    expect(await h.model()).toBe("gemini-high");
    await h.request("session/set_config_option", { configId: "thinking_level", value: "low" }, family("gemini"));
    expect(await h.model()).toBe("gemini");
    await h.request("session/set_config_option", { configId: "model", value: "alias" }, { currentModelId: "resolved-id", ...family("gemini") });
    expect(await h.model()).toBe("resolved-id");
  } finally { await h.close(); }
});
