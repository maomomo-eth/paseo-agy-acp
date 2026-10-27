import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionSkillMcpServer } from "../ACP Connector/official-kernel/skill-mcp.js";
import { discoverSkillCommands } from "../ACP Connector/official-kernel/skill-commands.js";

const homes: string[] = [];
const servers: SessionSkillMcpServer[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.close()));
  await Promise.all(homes.splice(0).map(home => rm(home, { recursive: true, force: true })));
});
async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "skill-mcp-")); homes.push(home);
  const workspace = path.join(home, "workspace");
  await mkdir(workspace);
  const server = new SessionSkillMcpServer({ HOME: home, GEMINI_HOME: path.join(home, "relocated") });
  servers.push(server);
  return { home, workspace, server };
}
async function skill(directory: string, name: string, text: string) {
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: 测试技能\n---\n${text}`, "utf8");
}
async function rpc(url: string, method: string, params?: unknown) {
  const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  return response.json() as Promise<{ result?: { content?: Array<{ text: string }>; tools?: Array<{ name: string }>; isError?: boolean }; error?: unknown }>;
}
describe("会话隔离技能 MCP", () => {
  it("直接技能根和非用户调用技能与命令列表遵循相同遮蔽规则", async () => {
    const { home, workspace, server } = await fixture();
    const direct = path.join(home, "declared");
    await skill(direct, "direct", "声明的单技能根");
    await writeFile(path.join(workspace, "skills.json"), JSON.stringify({ entries: [{ path: direct }] }), "utf8");
    const hidden = path.join(workspace, ".agents/skills/hidden");
    await skill(hidden, "hidden", "只允许模型调用");
    await writeFile(path.join(hidden, "SKILL.md"), "---\nname: hidden\nuser-invocable: false\n---\n工作区私有正文", "utf8");
    await skill(path.join(home, ".agents/skills/hidden"), "hidden", "全局同名不能泄漏到命令");
    await skill(path.join(workspace, ".agents/skills/oversize"), "oversize", "x".repeat(1024 * 1024));
    const commands = discoverSkillCommands(workspace, { HOME: home });
    expect(commands.map(command => command.name)).toEqual(["direct"]);
    const { server: connection } = await server.register(workspace);
    const list = await rpc(connection.url, "tools/call", { name: "list_skills", arguments: {} });
    expect(JSON.parse(list.result!.content![0]!.text).map((entry: { name: string }) => entry.name)).toEqual(["direct", "hidden"]);
    const read = await rpc(connection.url, "tools/call", { name: "read_skill", arguments: { name: "hidden" } });
    expect(read.result?.content?.[0]?.text).toContain("工作区私有正文");
    await Promise.all([server.close(), server.close()]);
  });

  it("列出并显式读取技能，保留根优先级并实时读取修改", async () => {
    const { home, workspace, server } = await fixture();
    const local = path.join(workspace, ".agents/skills/example");
    await skill(local, "example", "工作区版本");
    await skill(path.join(home, ".agents/skills/example"), "example", "全局版本");
    await skill(path.join(home, "relocated/config/skills/native"), "native", "Gemini relocated");
    await skill(path.join(home, ".gemini/config/skills/leak"), "leak", "不应读取");
    const { server: connection } = await server.register(workspace);
    const tools = await rpc(connection.url, "tools/list");
    expect(tools.result?.tools?.map(tool => tool.name)).toEqual(["list_skills", "read_skill"]);
    const list = await rpc(connection.url, "tools/call", { name: "list_skills", arguments: {} });
    expect(JSON.parse(list.result!.content![0]!.text).map((entry: { name: string }) => entry.name)).toEqual(["example", "native"]);
    const read = () => rpc(connection.url, "tools/call", { name: "read_skill", arguments: { name: "example" } });
    expect((await read()).result?.content?.[0]?.text).toContain("工作区版本");
    await skill(local, "example", "即时更新");
    expect((await read()).result?.content?.[0]?.text).toContain("即时更新");
  });
  it("隔离不同工作区、阻止越界和符号链接逃逸，并撤销 token", async () => {
    const { home, workspace, server } = await fixture();
    const directory = path.join(workspace, ".agents/skills/private");
    await skill(directory, "private", "私有技能");
    await writeFile(path.join(directory, "reference.txt"), "引用文件", "utf8");
    await writeFile(path.join(home, "outside.txt"), "不可访问", "utf8");
    await symlink(path.join(home, "outside.txt"), path.join(directory, "escape.txt"));
    const first = await server.register(workspace);
    const second = await server.register(path.join(home, "other"));
    const read = (url: string, name: string, file?: string) => rpc(url, "tools/call", { name: "read_skill", arguments: { name, path: file } });
    expect((await read(second.server.url, "private")).result?.isError).toBe(true);
    expect((await read(first.server.url, "private", "reference.txt")).result?.content?.[0]?.text).toBe("引用文件");
    expect((await read(first.server.url, "private", "../../../../outside.txt")).result?.isError).toBe(true);
    expect((await read(first.server.url, "private", "escape.txt")).result?.isError).toBe(true);
    server.release(first.token);
    expect((await fetch(first.server.url)).status).toBe(404);
  });
});
