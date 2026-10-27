import { describe, expect, it } from "vitest";
import { createKernelDiagnostics, createQueueFeedback, supportsSessionNotices } from "../ACP Connector/official-kernel/observability.js";

describe("ACP queue feedback", () => {
  it("只接受明确的 notice 能力对象", () => {
    for (const params of [null, {}, { clientCapabilities: {} }, { clientCapabilities: { session: null } }, { clientCapabilities: { session: { notices: null } } }, { clientCapabilities: { session: { notices: true } } }]) {
      expect(supportsSessionNotices(params)).toBe(false);
    }
    expect(supportsSessionNotices({ clientCapabilities: { session: { notices: {} } } })).toBe(true);
  });

  it("notice 与旧客户端 fallback 保留关联且不泄漏未知字段", () => {
    for (const notices of [true, false]) {
      const feedback = createQueueFeedback({ notices });
      const result = feedback("session", { state: "queued", position: 2, waitedMs: 3_200 });
      expect(result).toMatchObject({ method: "session/update", params: { sessionId: "session", update: { sessionUpdate: notices ? "notice" : "agent_thought_chunk" } } });
      expect(JSON.stringify(result)).toContain("3 秒");
      if (notices) expect(result).toMatchObject({ params: { update: { severity: "info", title: "请求排队中" } } });
    }
  });

  it("相同状态节流、状态变化立即通知、缺少等待时间不重复", () => {
    let now = 0;
    const feedback = createQueueFeedback({ notices: true, now: () => now });
    expect(feedback("s", { state: "queued", position: 1 })).toBeDefined();
    now = 10_000;
    expect(feedback("s", { state: "queued", position: 1 })).toBeUndefined();
    expect(feedback("s", { state: "queued", position: 1, waitedMs: 10_000 })).toBeDefined();
    now += 1_000;
    expect(feedback("s", { state: "queued", position: 1, waitedMs: 11_000 })).toBeUndefined();
    expect(feedback("s", { state: "running" })).toMatchObject({ params: { update: { title: "请求已开始执行" } } });
  });
});

describe("kernel diagnostics", () => {
  it("默认关闭且不写入接收端", () => {
    const lines: string[] = [];
    createKernelDiagnostics({ write: line => lines.push(line) }).event("startup");
    expect(lines).toEqual([]);
  });

  it("fake clock 测量真实阶段耗时，只写允许字段和散列 ID", () => {
    let now = 10;
    const lines: string[] = [];
    const diagnostics = createKernelDiagnostics({ env: { AGY_ACP_DIAGNOSTICS: "1" }, now: () => now, write: line => lines.push(line) });
    const finish = diagnostics.start("initialize", { requestId: "secret-request", sessionId: "secret-session" });
    now = 55;
    finish();
    const record = JSON.parse(lines[0]!);
    expect(record).toMatchObject({ component: "official-kernel", event: "initialize", elapsedMs: 45, durationMs: 45 });
    expect(record.request).toMatch(/^[a-f0-9]{16}$/);
    expect(record.session).toMatch(/^[a-f0-9]{16}$/);
    expect(lines[0]).not.toContain("secret");
    expect(lines[0]?.endsWith("\n")).toBe(true);
  });

  it("拒绝非法耗时并隔离诊断写入失败", () => {
    const lines: string[] = [];
    const diagnostics = createKernelDiagnostics({ env: { AGY_ACP_DIAGNOSTICS: "1" }, write: line => lines.push(line) });
    diagnostics.event("turn_fail", { durationMs: NaN });
    expect(JSON.parse(lines[0]!)).not.toHaveProperty("durationMs");
    expect(() => createKernelDiagnostics({ env: { AGY_ACP_DIAGNOSTICS: "1" }, write: () => { throw new Error("closed"); } }).event("startup")).not.toThrow();
  });
});
