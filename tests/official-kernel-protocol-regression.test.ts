import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgyTerminalProviderError } from "../ACP Connector/admission/dispatch-boundary.js";
import type { AdmissionTurnInput } from "../ACP Connector/admission/turn-coordinator.js";
import { createOfficialAdmission } from "../ACP Connector/official-kernel/admission-fence.js";
import { officialResponseError } from "../ACP Connector/official-kernel/errors.js";
import { createNdjsonParser, encodeNdjson } from "../ACP Connector/official-kernel/ndjson.js";
import type { JsonRpcMessage } from "../ACP Connector/official-kernel/json-rpc.js";
import { OfficialKernelProxy } from "../ACP Connector/official-kernel/proxy.js";

vi.mock("../ACP Connector/official-kernel/admission-fence.js", async original => ({
  ...await original<typeof import("../ACP Connector/official-kernel/admission-fence.js")>(), createOfficialAdmission: vi.fn()
}));
afterEach(() => vi.mocked(createOfficialAdmission).mockReset());

function harness(env: NodeJS.ProcessEnv = {}) {
  const child = Object.assign(new EventEmitter(), {
    pid: process.pid, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true)
  });
  const input = new PassThrough(); const output = new PassThrough();
  const messages: JsonRpcMessage[] = []; const forwarded: JsonRpcMessage[] = [];
  output.on("data", createNdjsonParser(message => messages.push(message)));
  child.stdin.on("data", createNdjsonParser(message => forwarded.push(message)));
  const proxy = new OfficialKernelProxy({ child: child as unknown as ChildProcessWithoutNullStreams, stdin: input, stdout: output, env, version: "test" });
  const running = proxy.start();
  return { child, input, messages, forwarded, running,
    send(message: JsonRpcMessage) { input.write(encodeNdjson(message)); },
    reply(message: JsonRpcMessage) { child.stdout.write(encodeNdjson(message)); },
    async close() { child.emit("close", 0); await running; }
  };
}

const prompt = (id: number) => ({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId: "s", prompt: "hello" } });

describe("官方内核协议回归", () => {
  it("UTF-8 中文和 emoji 可在任意字节处分块", () => {
    const wire = Buffer.from(encodeNdjson({ id: 1, result: { text: "你好🙂" } }), "utf8");
    for (let split = 1; split < wire.length; split++) {
      const messages: JsonRpcMessage[] = []; const parse = createNdjsonParser(message => messages.push(message));
      parse(wire.subarray(0, split)); parse(wire.subarray(split)); parse.end();
      expect(messages).toEqual([{ id: 1, result: { text: "你好🙂" } }]);
    }
  });
  it("超限行只报告一次并恢复下一行，EOF 截断可观测，回调异常不被当成解析错误", () => {
    const messages: JsonRpcMessage[] = []; const invalid = vi.fn();
    const parse = createNdjsonParser(message => messages.push(message), invalid, { maxMessageBytes: 24 });
    parse("x".repeat(30)); parse("x".repeat(30)); parse("\n{\"id\":1,\"result\":{}}\n");
    expect(invalid).toHaveBeenCalledOnce(); expect(messages).toHaveLength(1);
    parse("{"); parse.end(); expect(invalid).toHaveBeenCalledTimes(2);
    expect(() => createNdjsonParser(() => { throw new Error("handler"); }, invalid)("{\"result\":{}}\n")).toThrow("handler");
    expect(invalid).toHaveBeenCalledTimes(2);
  });
  it.each([false, true])("prompt 紧随 cancel 不会在取消后派发，Admission=%s", async admission => {
    const admit = vi.fn(async () => "cancelled");
    if (admission) vi.mocked(createOfficialAdmission).mockReturnValue({ coordinator: { admit, close() {} }, runtime: { close() {} } } as never);
    const h = harness();
    try {
      h.send(prompt(1)); h.send({ method: "session/cancel", params: { sessionId: "s" } });
      await vi.waitFor(() => expect(h.messages).toContainEqual({ jsonrpc: "2.0", id: 1, result: { stopReason: "cancelled" } }));
      expect(h.forwarded.filter(message => "method" in message && message.method === "session/prompt")).toHaveLength(0);
      expect(admit).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it("同 session 并发请求不会覆盖 claim", async () => {
    const h = harness();
    try {
      h.send(prompt(1)); h.send(prompt(2));
      await vi.waitFor(() => expect(h.messages).toContainEqual(expect.objectContaining({ id: 2, error: expect.anything() })));
      h.send({ method: "session/cancel", params: { sessionId: "s" } });
      await vi.waitFor(() => expect(h.forwarded.length).toBeGreaterThan(0));
      h.reply({ id: 1, result: { stopReason: "cancelled" } });
    } finally { await h.close(); }
  });
  it("Admission 结算收到结构化错误，客户端只有一次响应", async () => {
    let failure: unknown; const model: string[] = [];
    vi.mocked(createOfficialAdmission).mockReturnValue({ coordinator: {
      async admit(input: AdmissionTurnInput) {
        model.push(input.model);
        try { return (await input.execute({ prepare() {}, beforePromptWrite() {}, afterPromptWrite() {} })).stopReason; }
        catch (error) { failure = error; throw error; }
      }, close() {}
    }, runtime: { close() {} } } as never);
    const h = harness();
    try {
      h.send({ id: 0, method: "session/load", params: { sessionId: "s" } });
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(1));
      h.reply({ id: 0, result: { sessionId: "s", models: { currentModelId: "model-real" } } });
      h.send(prompt(1));
      await vi.waitFor(() => expect(h.forwarded).toHaveLength(2));
      h.reply({ id: 1, error: { code: -32000, message: "provider failed", data: { httpStatus: 503, code: "MODEL_CAPACITY_EXHAUSTED" } } });
      await vi.waitFor(() => expect(failure).toBeInstanceOf(AgyTerminalProviderError));
      expect((failure as AgyTerminalProviderError).failure?.category).toBe("provider_capacity");
      expect(model).toEqual(["model-real"]);
      expect(h.messages.filter(message => "id" in message && message.id === 1)).toHaveLength(1);
    } finally { await h.close(); }
  });
  it("错误正文中的状态码不会被猜成 provider capacity", () => {
    expect(officialResponseError({ id: 1, error: { code: -32000, message: "503 MODEL_CAPACITY_EXHAUSTED" } }).failure?.category).toBe("unknown");
  });
  it("EOF 会结束内核输入、TERM 后升级 KILL，并等 close 才完成", async () => {
    vi.useFakeTimers(); const h = harness(); let done = false;
    void h.running.then(() => { done = true; });
    try {
      h.input.end(); await vi.advanceTimersByTimeAsync(0);
      expect(h.child.kill).toHaveBeenCalledWith("SIGTERM"); expect(done).toBe(false);
      await vi.advanceTimersByTimeAsync(2_000);
      expect(h.child.kill).toHaveBeenCalledWith("SIGKILL"); expect(done).toBe(false);
      await h.close(); expect(done).toBe(true);
    } finally { vi.useRealTimers(); await h.close(); }
  });
});
