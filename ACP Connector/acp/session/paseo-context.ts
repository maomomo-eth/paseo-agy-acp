import { readdir, readFile } from "node:fs/promises";
import * as os from "node:os";
import path from "node:path";

const MAX_PASEO_APPEND_CHARS = 200_000;
const PASEO_APPEND_RETRY_ATTEMPTS = 25;
const PASEO_APPEND_RETRY_DELAY_MS = 20;
// 只缓存定位结果；每轮仍读取内容，允许 daemon 在会话期间更新上下文。
const paseoAgentStatePaths = new Map<string, string>();

export const PASEO_DAEMON_CONTEXT_OPEN = "[Paseo daemon system context]";
export const PASEO_DAEMON_CONTEXT_CLOSE = "[/Paseo daemon system context]";

async function findPaseoAgentState(
  dir: string,
  fileName: string,
  depth = 4
): Promise<string | undefined> {
  if (depth < 0) return undefined;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  for (const entry of entries) {
    const child = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === fileName) return child;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = await findPaseoAgentState(path.join(dir, entry.name), fileName, depth - 1);
    if (found) return found;
  }
  return undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function resolvePaseoHome(environment: NodeJS.ProcessEnv = process.env): string {
  const configured = environment.PASEO_HOME?.trim();
  if (configured) {
    if (configured === "~") return os.homedir();
    if (configured.startsWith("~/") || configured.startsWith("~\\")) {
      return path.join(os.homedir(), configured.slice(2));
    }
    return configured;
  }

  const homeDir = environment.HOME || os.homedir();
  return homeDir ? path.join(homeDir, ".paseo") : "";
}

export async function readPaseoDaemonAppendSystemPrompt(
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const home = resolvePaseoHome(environment);
  const agentId = environment.PASEO_AGENT_ID;
  if (!home || !agentId || agentId.includes("/") || agentId.includes("\\")) return "";
  const cacheKey = path.join(home, "agents", `${agentId}.json`);

  for (let attempt = 0; attempt < PASEO_APPEND_RETRY_ATTEMPTS; attempt++) {
    try {
      const statePath = paseoAgentStatePaths.get(cacheKey) ??
        await findPaseoAgentState(path.join(home, "agents"), `${agentId}.json`);
      if (statePath) {
        paseoAgentStatePaths.set(cacheKey, statePath);
        const state = JSON.parse(await readFile(statePath, "utf8")) as {
          persistence?: { metadata?: { daemonAppendSystemPrompt?: unknown } };
        } | null;
        const append = state?.persistence?.metadata?.daemonAppendSystemPrompt;
        return typeof append === "string" ? append.trim().slice(0, MAX_PASEO_APPEND_CHARS) : "";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ENOTDIR") {
        paseoAgentStatePaths.delete(cacheKey);
      }
      // Paseo may still be writing the state file. Retry briefly, then fail open.
    }
    if (attempt < PASEO_APPEND_RETRY_ATTEMPTS - 1) {
      await delay(PASEO_APPEND_RETRY_DELAY_MS);
    }
  }
  return "";
}

export async function withPaseoDaemonSystemContext(
  promptText: string,
  environment: NodeJS.ProcessEnv = process.env
): Promise<string> {
  const append = await readPaseoDaemonAppendSystemPrompt(environment);
  if (!append) return promptText;
  return [PASEO_DAEMON_CONTEXT_OPEN, append, PASEO_DAEMON_CONTEXT_CLOSE, "", promptText].join("\n");
}

export function wrapPaseoDaemonContextBlock(append: string): string {
  return [PASEO_DAEMON_CONTEXT_OPEN, append, PASEO_DAEMON_CONTEXT_CLOSE].join("\n");
}
