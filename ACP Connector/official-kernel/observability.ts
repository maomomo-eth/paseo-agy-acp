import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { isRecord, type JsonRpcId, type JsonRpcMessage } from "./json-rpc.js";

/** 仅在客户端明确声明 ACP v1 notice 能力后使用。 */
export function supportsSessionNotices(initializeParams: unknown): boolean {
  if (!isRecord(initializeParams) || !isRecord(initializeParams.clientCapabilities)) return false;
  const session = initializeParams.clientCapabilities.session;
  return isRecord(session) && isRecord(session.notices);
}

export interface QueueFeedbackProgress {
  readonly state: "queued" | "running";
  readonly position?: number;
  readonly waitedMs?: number;
  readonly cooldownUntil?: number | null;
}

/** 每个 turn 新建一个实例；纯格式化返回值，不写 stdout，也不标记内核可见输出。 */
export function createQueueFeedback(options: { notices: boolean; now?: () => number; intervalMs?: number }) {
  const now = options.now ?? (() => performance.now());
  const interval = Math.max(1_000, options.intervalMs ?? 5_000);
  let previousAt = -Infinity;
  let previousState = "";
  let previousPosition: number | undefined;
  let previousCooldown = false;
  return (sessionId: string, progress: QueueFeedbackProgress): JsonRpcMessage | undefined => {
    const at = now();
    const cooldown = progress.cooldownUntil != null;
    const changed = progress.state !== previousState || progress.position !== previousPosition || cooldown !== previousCooldown;
    // 没有新等待时间的重复快照不制造虚假的时间进展。
    if (!changed && (progress.waitedMs === undefined || at - previousAt < interval)) return undefined;
    previousAt = at;
    previousState = progress.state;
    previousPosition = progress.position;
    previousCooldown = cooldown;
    const title = progress.state === "running" ? "请求已开始执行" : "请求排队中";
    const description = progress.state === "running"
      ? "正在等待内核响应。"
      : `${progress.position === undefined ? "等待可用执行席位" : `队列第 ${progress.position} 位`}${progress.waitedMs === undefined ? "" : `，已等待 ${Math.floor(Math.max(0, progress.waitedMs) / 1_000)} 秒`}${cooldown ? "，正在等待服务冷却" : ""}。`;
    return {
      jsonrpc: "2.0", method: "session/update", params: {
        sessionId,
        update: options.notices
          ? { sessionUpdate: "notice", severity: "info", title, description }
          : { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: `${title}：${description}\n` } }
      }
    };
  };
}

export type DiagnosticStage = "startup" | "initialize" | "session_setup" | "daemon_context" | "admission_wait" | "first_kernel_output" | "turn_end" | "turn_cancel" | "turn_fail";

export interface DiagnosticContext {
  readonly requestId?: JsonRpcId;
  readonly sessionId?: string;
  readonly durationMs?: number;
}

/** 默认关闭。仅输出固定字段和散列关联 ID，不接收 prompt、异常正文或 headers。 */
export function createKernelDiagnostics(options: {
  env?: NodeJS.ProcessEnv;
  write?: (line: string) => void;
  now?: () => number;
} = {}) {
  const enabled = options.env?.AGY_ACP_DIAGNOSTICS === "1";
  const now = options.now ?? (() => performance.now());
  const startedAt = now();
  const write = options.write ?? ((line: string) => { process.stderr.write(line); });
  const correlate = (value: string | number) => createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
  const event = (stage: DiagnosticStage, context: DiagnosticContext = {}): void => {
    if (!enabled) return;
    const duration = context.durationMs;
    const record = {
      component: "official-kernel", event: stage, elapsedMs: Math.max(0, now() - startedAt),
      ...(context.requestId === undefined ? {} : { request: correlate(context.requestId) }),
      ...(context.sessionId === undefined ? {} : { session: correlate(context.sessionId) }),
      ...(duration === undefined || !Number.isFinite(duration) ? {} : { durationMs: Math.max(0, duration) })
    };
    // 诊断接收端失效不能中断 ACP 请求。
    try { write(`${JSON.stringify(record)}\n`); } catch { /* 诊断是尽力而为。 */ }
  };
  return {
    event,
    start(stage: DiagnosticStage, context: Omit<DiagnosticContext, "durationMs"> = {}) {
      const beginning = now();
      return () => event(stage, { ...context, durationMs: now() - beginning });
    }
  };
}
