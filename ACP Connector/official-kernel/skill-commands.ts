import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { resolvePaseoHome } from "../acp/session/paseo-context.js";

export interface AvailableCommand {
  name: string;
  description: string;
}

function parseYamlScalar(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return "";

  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed
        .slice(1, -1)
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\")
        .replace(/\\n/g, "\n")
        .replace(/\\r/g, "\r")
        .replace(/\\t/g, "\t");
    }
  }

  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }

  const commentIdx = trimmed.search(/\s+#/);
  const withoutComment = commentIdx !== -1 ? trimmed.slice(0, commentIdx).trim() : trimmed;
  return withoutComment;
}

function parseYamlBoolean(raw: string | undefined, defaultValue = true): boolean {
  if (raw === undefined) return defaultValue;
  const scalar = parseYamlScalar(raw).toLowerCase();
  if (scalar === "false" || scalar === "no" || scalar === "off" || scalar === "0") {
    return false;
  }
  if (scalar === "true" || scalar === "yes" || scalar === "on" || scalar === "1") {
    return true;
  }
  return defaultValue;
}

export function parseFrontmatter(content: string): {
  name?: string;
  description?: string;
  userInvocable?: boolean;
} {
  if (!content.startsWith("---")) return {};
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)(?:\r?\n|$)/);
  if (!match) return {};

  const frontmatter = match[1];
  const lines = frontmatter.split(/\r?\n/);
  let name: string | undefined;
  let description: string | undefined;
  let userInvocable: boolean | undefined;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nameMatch = line.match(/^name:\s*(.*)$/);
    if (nameMatch) {
      name = parseYamlScalar(nameMatch[1]);
      continue;
    }

    const invocableMatch = line.match(/^(?:user-invocable|user_invocable):\s*(.*)$/);
    if (invocableMatch) {
      userInvocable = parseYamlBoolean(invocableMatch[1], true);
      continue;
    }

    const descMatch = line.match(/^description:\s*(.*)$/);
    if (descMatch) {
      const rest = descMatch[1].trim();
      if (rest === ">" || rest === ">-" || rest === "|" || rest === "|-") {
        const isFolded = rest.startsWith(">");
        const blockLines: string[] = [];
        for (let j = i + 1; j < lines.length; j++) {
          if (/^\s+/.test(lines[j]) || lines[j].trim().length === 0) {
            blockLines.push(lines[j].trim());
            i = j;
          } else {
            break;
          }
        }
        if (isFolded) {
          description = blockLines.filter((l) => l.length > 0).join(" ");
        } else {
          description = blockLines.join("\n").trim();
        }
      } else {
        description = parseYamlScalar(rest);
      }
      continue;
    }
  }

  return { name, description, userInvocable };
}

export function resolveSkillRoots(cwd?: string, environment: NodeJS.ProcessEnv = process.env): string[] {
  const roots = new Set<string>();
  const home = environment.HOME || homedir();
  const geminiHome = environment.GEMINI_HOME?.trim() || path.join(home, ".gemini");
  const paseoHome = resolvePaseoHome(environment);

  const readSkillsJson = (filePath: string, baseDir: string): void => {
    if (!existsSync(filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as {
        entries?: Array<{ path?: string }>;
      };
      if (Array.isArray(parsed.entries)) {
        for (const entry of parsed.entries) {
          if (entry && typeof entry.path === "string" && entry.path.trim().length > 0) {
            const trimmed = entry.path.trim();
            let resolved: string;
            if (trimmed.startsWith("/")) {
              resolved = trimmed;
            } else if (trimmed.startsWith("~/")) {
              resolved = path.join(home, trimmed.slice(2));
            } else {
              resolved = path.resolve(baseDir, trimmed);
            }
            if (existsSync(resolved)) {
              roots.add(resolved);
            }
          }
        }
      }
    } catch {
      // Ignore JSON parse errors
    }
  };

  // 1. Workspace declared configs in skills.json
  if (cwd && existsSync(cwd)) {
    readSkillsJson(path.join(cwd, ".paseo/skills.json"), cwd);
    readSkillsJson(path.join(cwd, ".agents/skills.json"), cwd);
    readSkillsJson(path.join(cwd, "skills.json"), cwd);
    readSkillsJson(path.join(cwd, ".codex/skills.json"), cwd);
    readSkillsJson(path.join(cwd, ".gemini/config/skills.json"), cwd);
  }

  // 2. Workspace default skill directories
  if (cwd && existsSync(cwd)) {
    const wsDefaults = [
      path.join(cwd, ".paseo/skills"),
      path.join(cwd, ".agents/skills"),
      path.join(cwd, ".codex/skills"),
      path.join(cwd, ".claude/skills"),
      path.join(cwd, ".gemini/skills"),
      path.join(cwd, "skills")
    ];
    for (const dir of wsDefaults) {
      if (existsSync(dir)) roots.add(dir);
    }
  }

  // 3. Global declared configs in skills.json
  // 沿用现有全局声明的 home 相对路径语义；默认与自定义 Paseo home 均可配置。
  for (const directory of new Set([paseoHome, path.join(home, ".paseo")])) {
    readSkillsJson(path.join(directory, "skills.json"), home);
  }
  readSkillsJson(path.join(geminiHome, "config/skills.json"), home);
  readSkillsJson(path.join(home, ".agents/skills.json"), home);
  readSkillsJson(path.join(home, ".codex/skills.json"), home);

  // 4. Global default skill directories
  const globalDefaults = [
    path.join(paseoHome, "skills"),
    path.join(home, ".paseo/skills"),
    path.join(geminiHome, "config/skills"),
    path.join(geminiHome, "antigravity-cli/skills"),
    path.join(home, ".agents/skills"),
    path.join(home, ".codex/skills"),
    path.join(home, ".claude/skills")
  ];
  for (const dir of globalDefaults) {
    if (existsSync(dir)) roots.add(dir);
  }

  return Array.from(roots);
}

export function discoverSkillCommands(cwd?: string, environment: NodeJS.ProcessEnv = process.env): AvailableCommand[] {
  const roots = resolveSkillRoots(cwd, environment);
  const commands = new Map<string, AvailableCommand>();
  const seen = new Set<string>();

  for (const root of roots) {
    try {
      const directories = existsSync(path.join(root, "SKILL.md")) ? [root] : readdirSync(root, { withFileTypes: true })
        .filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => path.join(root, entry.name));
      for (const directory of directories) {
        try {
          const skillFile = path.join(directory, "SKILL.md");
          const info = statSync(skillFile);
          if (!info.isFile() || info.size > 1024 * 1024) continue;
          const { name, description, userInvocable } = parseFrontmatter(readFileSync(skillFile, "utf8"));
          const commandName = name || path.basename(directory);
          if (seen.has(commandName)) continue;
          seen.add(commandName);
          if (userInvocable === false) continue;
          commands.set(commandName, { name: commandName, description: description || `Skill: ${commandName}` });
        } catch { /* 不可读条目不发布。 */ }
      }
    } catch { /* 忽略不可读目录。 */ }
  }

  return Array.from(commands.values());
}

export function augmentAvailableCommands(
  existingCommands: AvailableCommand[] | undefined,
  cwd?: string,
  environment: NodeJS.ProcessEnv = process.env
): AvailableCommand[] {
  const result = new Map<string, AvailableCommand>();

  if (Array.isArray(existingCommands)) {
    for (const cmd of existingCommands) {
      if (cmd && typeof cmd.name === "string") {
        result.set(cmd.name, cmd);
      }
    }
  }

  const skills = discoverSkillCommands(cwd, environment);
  for (const skill of skills) {
    if (!result.has(skill.name)) {
      result.set(skill.name, skill);
    }
  }

  return Array.from(result.values());
}
