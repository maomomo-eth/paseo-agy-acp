import { chmod, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { inspectOfficialKernel, prepareOfficialKernel } from "../ACP Connector/official-kernel/kernel-commands.js";

describe("内核准备与只读诊断", () => {
  it("只读检查缺失的自定义执行文件，不创建状态或下载", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agy-doctor-"));
    try {
      const report = await inspectOfficialKernel({ HOME: home, PASEO_AGY_ACP_OFFICIAL_BIN: path.join(home, "missing") }, "test");
      expect(report).toMatchObject({ ready: false, adapterVersion: "test", authentication: "not_checked", daemon: "not_checked", kernel: { managed: false, executable: false } });
      expect(await readdir(home)).toEqual([]);
    } finally { await rm(home, { recursive: true, force: true }); }
  });

  it("准备已存在的自定义内核时只检查就绪，不启动执行文件", async () => {
    const home = await mkdtemp(path.join(tmpdir(), "agy-prepare-"));
    const binary = path.join(home, "kernel");
    try {
      await writeFile(binary, "#!/bin/sh\nexit 99\n", { encoding: "utf8", mode: 0o700 });
      const report = await prepareOfficialKernel({ HOME: home, PASEO_AGY_ACP_OFFICIAL_BIN: binary }, "test");
      expect(report).toMatchObject({ ready: true, kernel: { managed: false, binary, executable: true }, issues: [] });
      expect(await readdir(home)).toEqual(["kernel"]);
      if (process.platform !== "win32") {
        await chmod(binary, 0o600);
        expect((await inspectOfficialKernel({ HOME: home, PASEO_AGY_ACP_OFFICIAL_BIN: binary }, "test")).ready).toBe(false);
      }
    } finally { await rm(home, { recursive: true, force: true }); }
  });
});
