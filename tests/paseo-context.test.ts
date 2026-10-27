import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readPaseoDaemonAppendSystemPrompt } from "../ACP Connector/acp/session/paseo-context.js";
import { extractCwd } from "../ACP Connector/official-kernel/context.js";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return { ...actual, readdir: vi.fn(actual.readdir) };
});

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(fs.readdir).mockClear();
  await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

async function stateFixture(content: string) {
  const home = await mkdtemp(path.join(os.tmpdir(), "paseo-context-"));
  directories.push(home);
  const dir = path.join(home, "agents", "workspace");
  await mkdir(dir, { recursive: true });
  const statePath = path.join(dir, "agent.json");
  await writeFile(statePath, content, "utf8");
  return { home, statePath, environment: { PASEO_HOME: home, PASEO_AGENT_ID: "agent" } };
}

describe("Paseo daemon 上下文读取", () => {
  it.each([{}, { persistence: { metadata: { daemonAppendSystemPrompt: "  " } } }])(
    "成功解析空配置后立即返回且复用路径",
    async state => {
      const { environment } = await stateFixture(JSON.stringify(state));
      const timeout = vi.spyOn(globalThis, "setTimeout");
      expect(await readPaseoDaemonAppendSystemPrompt(environment)).toBe("");
      const scans = vi.mocked(fs.readdir).mock.calls.length;
      expect(scans).toBeGreaterThan(0);
      expect(await readPaseoDaemonAppendSystemPrompt(environment)).toBe("");
      expect(fs.readdir).toHaveBeenCalledTimes(scans);
      expect(timeout).not.toHaveBeenCalled();
    }
  );

  it("缓存路径但每轮重新读取提示词，并在文件迁移后重新定位", async () => {
    const { home, statePath, environment } = await stateFixture("{}");
    await readPaseoDaemonAppendSystemPrompt(environment);
    const scans = vi.mocked(fs.readdir).mock.calls.length;
    await writeFile(statePath, JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: " 更新内容 " } } }), "utf8");
    expect(await readPaseoDaemonAppendSystemPrompt(environment)).toBe("更新内容");
    expect(fs.readdir).toHaveBeenCalledTimes(scans);
    await rename(statePath, path.join(home, "agents", "agent.json"));
    expect(await readPaseoDaemonAppendSystemPrompt(environment)).toBe("更新内容");
    expect(vi.mocked(fs.readdir).mock.calls.length).toBeGreaterThan(scans);
  });

  it("配置仍在写入时保留短暂重试", async () => {
    const { statePath, environment } = await stateFixture("{");
    const write = new Promise<void>((resolve, reject) => setTimeout(() => {
      writeFile(statePath, JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: "完整内容" } } }), "utf8").then(resolve, reject);
    }, 30));
    expect(await readPaseoDaemonAppendSystemPrompt(environment)).toBe("完整内容");
    await write;
  });

  it("按 Paseo home 隔离同名 Agent 的路径", async () => {
    const first = await stateFixture(JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: "甲" } } }));
    const second = await stateFixture(JSON.stringify({ persistence: { metadata: { daemonAppendSystemPrompt: "乙" } } }));
    expect(await readPaseoDaemonAppendSystemPrompt(first.environment)).toBe("甲");
    expect(await readPaseoDaemonAppendSystemPrompt(second.environment)).toBe("乙");
  });
});

describe("Paseo 工作区 CWD 回退", () => {
  it("显式 cwd 优先，缺省或空值使用实例环境", () => {
    const env = { PASEO_AGENT_CWD: " /workspace/fallback " };
    expect(extractCwd({ cwd: " /workspace/explicit " }, env)).toBe("/workspace/explicit");
    for (const params of [{}, { cwd: " " }, { cwd: null }, undefined]) {
      expect(extractCwd(params, env)).toBe("/workspace/fallback");
    }
    expect(extractCwd({}, {})).toBeUndefined();
  });
});
