import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { readdir, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { isRecord } from "./json-rpc.js";
import { parseFrontmatter, resolveSkillRoots } from "./skill-commands.js";

interface SkillEntry { name: string; description: string; directory: string; userInvocable: boolean }
class SkillMcpMethodError extends Error {}

/** 每次重新扫描，配置、技能新增/删除和正文更新立即生效；不缓存正文。 */
export async function discoverReadableSkills(cwd?: string, environment: NodeJS.ProcessEnv = process.env): Promise<SkillEntry[]> {
  const found = new Map<string, SkillEntry>();
  for (const root of resolveSkillRoots(cwd, environment)) {
    let directories: string[];
    try {
      const ownSkill = await stat(path.join(root, "SKILL.md")).then(s => s.isFile()).catch(() => false);
      directories = ownSkill ? [root] : (await readdir(root, { withFileTypes: true }))
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(root, entry.name));
    } catch { continue; }
    for (const directory of directories) {
      try {
        const info = await stat(path.join(directory, "SKILL.md"));
        if (!info.isFile() || info.size > 1024 * 1024) continue;
        const content = await readFile(path.join(directory, "SKILL.md"), "utf8");
        const metadata = parseFrontmatter(content);
        const name = metadata.name || path.basename(directory);
        if (!found.has(name)) found.set(name, { name, description: metadata.description || `Skill: ${name}`,
          directory, userInvocable: metadata.userInvocable !== false });
      } catch { /* 不可读条目不发布。 */ }
    }
  }
  return [...found.values()];
}

interface SkillScope { cwd?: string }

/** 只读 MCP：技能正文仅在模型显式调用工具时返回，URL token 隔离会话。 */
export class SessionSkillMcpServer {
  readonly #scopes = new Map<string, SkillScope>();
  readonly #server = createServer((request, response) => { void this.#handle(request, response); });
  #starting?: Promise<void>;
  #port = 0;
  #closed = false;
  #closing?: Promise<void>;

  constructor(private readonly environment: NodeJS.ProcessEnv = process.env) {}

  async register(cwd?: string): Promise<{ server: { type: "http"; name: string; url: string; headers: [] }; token: string }> {
    if (this.#closed) throw new Error("技能 MCP 已关闭");
    this.#starting ??= new Promise<void>((resolve, reject) => {
      this.#server.once("error", reject);
      this.#server.listen(0, "127.0.0.1", () => {
        this.#server.removeListener("error", reject);
        const address = this.#server.address();
        if (!address || typeof address === "string") { reject(new Error("技能 MCP 无法绑定端口")); return; }
        this.#port = address.port;
        resolve();
      });
    });
    await this.#starting;
    if (this.#closed) throw new Error("技能 MCP 已关闭");
    const token = randomBytes(24).toString("hex");
    this.#scopes.set(token, { cwd });
    return { token, server: { type: "http", name: "paseo_skills", url: `http://127.0.0.1:${this.#port}/${token}`, headers: [] } };
  }

  release(token: string): void { this.#scopes.delete(token); }

  close(): Promise<void> {
    this.#closed = true;
    this.#scopes.clear();
    this.#closing ??= (async () => {
      await this.#starting?.catch(() => {});
      if (!this.#server.listening) return;
      await new Promise<void>((resolve, reject) => {
        this.#server.close(error => error ? reject(error) : resolve());
        this.#server.closeAllConnections();
      });
    })();
    return this.#closing;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const token = (request.url ?? "").split("?")[0].slice(1);
    const scope = this.#scopes.get(token);
    if (!scope) { response.writeHead(404).end(); return; }
    if (request.method === "GET") { response.writeHead(405).end(); return; }
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method !== "POST") { response.writeHead(405).end(); return; }
    let id: unknown = null;
    let parsed = false;
    let toolCall = false;
    try {
      let body = "";
      const decoder = new StringDecoder("utf8");
      for await (const chunk of request) {
        body += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        if (Buffer.byteLength(body) > 1024 * 1024) { response.writeHead(413).end(); return; }
      }
      body += decoder.end();
      const message: unknown = JSON.parse(body);
      parsed = true;
      if (!isRecord(message)) throw new Error("无效 MCP 请求");
      id = message.id ?? null;
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      toolCall = message.method === "tools/call" && isRecord(message.params) && typeof message.params.name === "string";
      const result = await this.#dispatch(message.method, message.params, scope);
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id, result }));
    } catch (error) {
      if (toolCall) {
        response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id,
          result: { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : "技能读取失败" }] } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id,
        error: { code: !parsed ? -32700 : error instanceof SkillMcpMethodError ? -32601 : -32602,
          message: error instanceof Error ? error.message : "技能请求失败" } }));
    }
  }

  async #dispatch(method: unknown, params: unknown, scope: SkillScope): Promise<unknown> {
    if (method === "initialize") return { protocolVersion: "2025-11-25", capabilities: { tools: {} },
      serverInfo: { name: "paseo-skills", version: "1.0.0" } };
    if (method === "ping") return {};
    if (method === "tools/list") return { tools: [
      { name: "list_skills", description: "列出当前会话可读取的技能，使用 read_skill 加载技能和相对引用文件。",
        inputSchema: { type: "object", properties: {}, additionalProperties: false } },
      { name: "read_skill", description: "按技能名读取 SKILL.md 或技能目录内的相对引用文件；遵循返回的技能指令。",
        inputSchema: { type: "object", properties: { name: { type: "string" }, path: { type: "string" } },
          required: ["name"], additionalProperties: false } }
    ] };
    if (method !== "tools/call") throw new SkillMcpMethodError("不支持的 MCP 方法");
    if (!isRecord(params)) throw new Error("需要有效工具参数");
    const skills = await discoverReadableSkills(scope.cwd, this.environment);
    if (params.name === "list_skills") return { content: [{ type: "text", text: JSON.stringify(skills.map(({ name, description, userInvocable }) => ({ name, description, userInvocable }))) }] };
    if (params.name !== "read_skill" || !isRecord(params.arguments) || typeof params.arguments.name !== "string") throw new Error("需要有效技能名");
    const skillName = params.arguments.name;
    const skill = skills.find(entry => entry.name === skillName);
    if (!skill) throw new Error("技能不存在或不属于当前会话");
    const relative = typeof params.arguments.path === "string" ? params.arguments.path : "SKILL.md";
    if (path.isAbsolute(relative)) throw new Error("技能文件必须使用相对路径");
    const root = await realpath(skill.directory);
    const target = await realpath(path.resolve(root, relative));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw new Error("技能文件超出技能目录");
    if (!(await stat(target)).isFile()) throw new Error("技能文件不是普通文件");
    if ((await stat(target)).size > 1024 * 1024) throw new Error("技能文件超过 1 MiB");
    return { content: [{ type: "text", text: await readFile(target, "utf8") }] };
  }
}
