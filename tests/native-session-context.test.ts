import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PaseoSessionContext } from "../ACP Connector/official-kernel/context.js";

const homes: string[] = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true }))); });
async function fixture(native = false) {
  const home = await mkdtemp(path.join(os.tmpdir(), "native-context-")); homes.push(home);
  await mkdir(path.join(home, "agents"));
  const file = path.join(home, "agents", "agent.json");
  const update = (text: string) => writeFile(file, JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: text } } }), "utf8");
  await update("daemon 原文");
  const context = new PaseoSessionContext({ PASEO_HOME: home, PASEO_AGENT_ID: "agent", PASEO_AGY_ACP_NATIVE_SYSTEM_CONTEXT: native ? "1" : "0" });
  return { context, update };
}
const capability = { agentCapabilities: { _meta: { antigravity: { systemPrompt: { append: true } } } } };
describe("官方原生 system append 协商", () => {
  it("默认保持动态上下文，更新和删除在下一轮生效", async () => {
    const { context, update } = await fixture();
    context.observeInitialize(capability);
    expect((await context.prepareSession({ cwd: "/project" })).native).toBe(false);
    const prompt = { sessionId: "dynamic", prompt: [{ type: "text", text: "问题" }] };
    expect(JSON.stringify(await context.injectPrompt(prompt))).toContain("daemon 原文");
    await update("更新正文");
    expect(JSON.stringify(await context.injectPrompt(prompt))).toContain("更新正文");
    await update("");
    expect(await context.injectPrompt(prompt)).toEqual(prompt);
  });
  it("需要显式开关和精确能力，合并 meta 并隔离会话快照", async () => {
    const { context, update } = await fixture(true);
    const params = { cwd: "/project", _meta: { other: true, antigravity: { enabledTools: ["read"], systemPrompt: { append: "用户原文", other: 1 } } } };
    expect((await context.prepareSession(params)).native).toBe(false);
    context.observeInitialize(capability);
    expect(await context.prepareSession(params)).toEqual({ native: true, params: { ...params, _meta: { other: true,
      antigravity: { enabledTools: ["read"], systemPrompt: { append: "用户原文\n\ndaemon 原文", other: 1 } } } } });
    context.bindSession("native", true);
    await update("会话后修改");
    const prompt = { sessionId: "native", prompt: "问题" };
    expect(await context.injectPrompt(prompt)).toBe(prompt);
    expect(JSON.stringify(await context.injectPrompt({ ...prompt, sessionId: "other" }))).toContain("会话后修改");
    context.forgetSession("native");
    expect(JSON.stringify(await context.injectPrompt(prompt))).toContain("会话后修改");
  });
});
