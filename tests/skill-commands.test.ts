import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  augmentAvailableCommands,
  discoverSkillCommands,
  parseFrontmatter,
  resolveSkillRoots
} from "../ACP Connector/official-kernel/skill-commands.js";

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function tempDir(prefix: string): string {
  const directory = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(directory);
  return directory;
}

describe("Frontmatter Parsing", () => {
  it("parses unquoted, double-quoted, and single-quoted fields cleanly without escape artifacts", () => {
    const content = `---
name: "my-skill"
description: "\\"Review this PR\\""
---
# Skill body`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBe("my-skill");
    expect(parsed.description).toBe('"Review this PR"');
  });

  it("parses single-quoted strings and escaped single quotes", () => {
    const content = `---
name: 'quote-skill'
description: 'Don''t miss this'
---`;
    const parsed = parseFrontmatter(content);
    expect(parsed.name).toBe("quote-skill");
    expect(parsed.description).toBe("Don't miss this");
  });

  it("parses multi-line folded and literal descriptions", () => {
    const folded = `---
name: folded-skill
description: >-
  First line of folded description
  second line of folded description.
---`;
    expect(parseFrontmatter(folded).description).toBe(
      "First line of folded description second line of folded description."
    );

    const literal = `---
name: literal-skill
description: |
  Line 1
  Line 2
---`;
    expect(parseFrontmatter(literal).description).toBe("Line 1\nLine 2");
  });

  it("parses user-invocable flag in boolean and string forms", () => {
    const disabledBool = `---
name: skill-1
user-invocable: false
---`;
    expect(parseFrontmatter(disabledBool).userInvocable).toBe(false);

    const disabledUnderscore = `---
name: skill-2
user_invocable: false
---`;
    expect(parseFrontmatter(disabledUnderscore).userInvocable).toBe(false);

    const disabledStr = `---
name: skill-3
user-invocable: "false"
---`;
    expect(parseFrontmatter(disabledStr).userInvocable).toBe(false);

    const enabled = `---
name: skill-4
user-invocable: true
---`;
    expect(parseFrontmatter(enabled).userInvocable).toBe(true);

    const defaultInvocable = `---
name: skill-5
description: default
---`;
    expect(parseFrontmatter(defaultInvocable).userInvocable).toBeUndefined();
  });
});

describe("Skill Commands Discovery", () => {
  it.each([
    { location: "workspace", relative: false }, { location: "workspace", relative: true },
    { location: "paseo-home", relative: false }, { location: "paseo-home", relative: true },
    { location: "default-home", relative: false }, { location: "default-home", relative: true }
  ])("从 $location 的 Paseo skills.json 发现技能（relative=$relative）", ({ location, relative }) => {
    const ws = tempDir("ws-paseo-config-");
    const home = tempDir("home-paseo-config-");
    const paseoHome = tempDir("custom-paseo-config-");
    const root = tempDir("external-paseo-skills-");
    const skill = path.join(root, "external-paseo");
    mkdirSync(skill, { recursive: true });
    writeFileSync(path.join(skill, "SKILL.md"), "---\nname: external-paseo\ndescription: 外部 Paseo 技能\n---\n", "utf8");
    const directory = location === "workspace" ? path.join(ws, ".paseo")
      : location === "paseo-home" ? paseoHome : path.join(home, ".paseo");
    mkdirSync(directory, { recursive: true });
    // 相对路径沿用现有约定：工作区基于 cwd，全局声明基于用户 home。
    const entry = relative ? path.relative(location === "workspace" ? ws : home, root) : root;
    writeFileSync(path.join(directory, "skills.json"), JSON.stringify({ entries: [{ path: entry }] }), "utf8");
    const env = { HOME: home, PASEO_HOME: paseoHome };
    expect(resolveSkillRoots(ws, env)).toContain(root);
    expect(augmentAvailableCommands([], ws, env)).toContainEqual({ name: "external-paseo", description: "外部 Paseo 技能" });
  });

  it("Paseo 配置与目录发现重复时去重，工作区声明优先于全局声明", () => {
    const ws = tempDir("ws-paseo-config-order-");
    const home = tempDir("home-paseo-config-order-");
    const paseoHome = tempDir("custom-paseo-config-order-");
    const wsRoot = path.join(ws, ".paseo/skills");
    const globalRoot = path.join(paseoHome, "skills");
    for (const [root, description] of [[wsRoot, "工作区声明"], [globalRoot, "全局声明"]]) {
      const skill = path.join(root, "shared-paseo-config");
      mkdirSync(skill, { recursive: true });
      writeFileSync(path.join(skill, "SKILL.md"), `---\nname: shared-paseo-config\ndescription: ${description}\n---\n`, "utf8");
    }
    writeFileSync(path.join(ws, ".paseo/skills.json"), JSON.stringify({ entries: [{ path: wsRoot }, { path: wsRoot }] }), "utf8");
    writeFileSync(path.join(paseoHome, "skills.json"), JSON.stringify({ entries: [{ path: globalRoot }] }), "utf8");
    const env = { HOME: home, PASEO_HOME: paseoHome };
    expect(resolveSkillRoots(ws, env)).toEqual([wsRoot, globalRoot]);
    expect(discoverSkillCommands(ws, env)).toEqual([{ name: "shared-paseo-config", description: "工作区声明" }]);
  });

  it("发现 Paseo 工作区、默认 home 和自定义 home 技能，并保持工作区优先", () => {
    const ws = tempDir("ws-paseo-");
    const home = tempDir("home-paseo-");
    const paseoHome = tempDir("custom-paseo-");
    const roots = [path.join(ws, ".paseo/skills"), path.join(paseoHome, "skills"), path.join(home, ".paseo/skills")];
    for (const [index, root] of roots.entries()) {
      for (const name of [`paseo-${index}`, "shared-paseo"]) {
        const dir = path.join(root, name);
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: 来源 ${index}\n---\n`, "utf8");
      }
    }
    const env = { HOME: home, PASEO_HOME: paseoHome };
    expect(resolveSkillRoots(ws, env)).toEqual(expect.arrayContaining(roots));
    const commands = augmentAvailableCommands([{ name: "plan", description: "内核命令" }], ws, env);
    expect(commands).toEqual(expect.arrayContaining(roots.map((_, index) => ({ name: `paseo-${index}`, description: `来源 ${index}` }))));
    expect(commands.filter(command => command.name === "shared-paseo")).toEqual([{ name: "shared-paseo", description: "来源 0" }]);
    expect(resolveSkillRoots(undefined, { HOME: home })).toEqual([path.join(home, ".paseo/skills")]);
    expect(resolveSkillRoots(undefined, { HOME: home, PASEO_HOME: path.join(home, ".paseo") })).toHaveLength(1);
  });

  it("discovers skills from configured skills.json", () => {
    const ws = tempDir("ws-custom-");
    const customSkillDir = tempDir("custom-skill-target-");
    const skillA = path.join(customSkillDir, "custom-declared-skill");
    mkdirSync(skillA, { recursive: true });
    writeFileSync(
      path.join(skillA, "SKILL.md"),
      `---
name: custom-declared-skill
description: Declared from custom skills.json
---
# Declared Skill
`
    );

    // Create workspace skills.json pointing to customSkillDir
    mkdirSync(path.join(ws, ".agents"), { recursive: true });
    writeFileSync(
      path.join(ws, ".agents/skills.json"),
      JSON.stringify({
        entries: [{ path: customSkillDir }]
      })
    );

    const roots = resolveSkillRoots(ws);
    expect(roots).toContain(customSkillDir);

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "custom-declared-skill");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Declared from custom skills.json");
  });

  it("discovers skills from .codex/skills in workspace", () => {
    const ws = tempDir("ws-codex-");
    const codexSkill = path.join(ws, ".codex/skills/codex-probe");
    mkdirSync(codexSkill, { recursive: true });
    writeFileSync(
      path.join(codexSkill, "SKILL.md"),
      `---
name: codex-probe
description: "Codex skill description"
---
`
    );

    const roots = resolveSkillRoots(ws);
    expect(roots).toContain(path.join(ws, ".codex/skills"));

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "codex-probe");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Codex skill description");
  });

  it("excludes skills with user-invocable: false", () => {
    const ws = tempDir("ws-invocable-");
    const visibleSkill = path.join(ws, ".agents/skills/visible-skill");
    const hiddenSkill = path.join(ws, ".agents/skills/shadcn");
    mkdirSync(visibleSkill, { recursive: true });
    mkdirSync(hiddenSkill, { recursive: true });

    writeFileSync(
      path.join(visibleSkill, "SKILL.md"),
      `---
name: visible-skill
description: Available to user
---`
    );
    writeFileSync(
      path.join(hiddenSkill, "SKILL.md"),
      `---
name: shadcn
description: Add components
user-invocable: false
---`
    );

    const commands = discoverSkillCommands(ws);
    expect(commands.find((c) => c.name === "visible-skill")).toBeDefined();
    expect(commands.find((c) => c.name === "shadcn")).toBeUndefined();
  });

  it("falls back to default Antigravity skill paths when unconfigured", () => {
    const ws = tempDir("ws-default-");
    const defaultWsSkills = path.join(ws, ".agents/skills/default-skill");
    mkdirSync(defaultWsSkills, { recursive: true });
    writeFileSync(
      path.join(defaultWsSkills, "SKILL.md"),
      `---
name: default-skill
description: Default location skill
---
`
    );

    const commands = discoverSkillCommands(ws);
    const found = commands.find((c) => c.name === "default-skill");
    expect(found).toBeDefined();
    expect(found?.description).toBe("Default location skill");
  });

  it("augments existing available commands without duplicating", () => {
    const ws = tempDir("ws-merge-");
    const skillA = path.join(ws, ".agents/skills/plan");
    const skillB = path.join(ws, ".agents/skills/extra-skill");
    mkdirSync(skillA, { recursive: true });
    mkdirSync(skillB, { recursive: true });
    writeFileSync(
      path.join(skillA, "SKILL.md"),
      `---\nname: plan\ndescription: Custom plan override\n---\n`
    );
    writeFileSync(
      path.join(skillB, "SKILL.md"),
      `---\nname: extra-skill\ndescription: Extra skill description\n---\n`
    );

    const initial = [{ name: "plan", description: "Official plan" }];
    const augmented = augmentAvailableCommands(initial, ws);

    // Initial commands are preserved and not overridden
    expect(augmented.find((c) => c.name === "plan")?.description).toBe("Official plan");
    // Extra skills are appended
    expect(augmented.find((c) => c.name === "extra-skill")?.description).toBe(
      "Extra skill description"
    );
  });
});
