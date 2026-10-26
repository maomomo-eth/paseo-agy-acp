import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { withManagedKernelInstallLock } from "../ACP Connector/official-kernel/ensure-managed-kernel.js";
import { spawn } from "node:child_process";
import { once } from "node:events";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
it("并发安装严格串行，失败释放锁且等待时间有界", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kernel-lock-")); directories.push(directory);
  const lock = path.join(directory, "lock");
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  let entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const first = withManagedKernelInstallLock(lock, async () => { entered(); await held; });
  await ready;
  await expect(withManagedKernelInstallLock(lock, async () => { throw new Error("不应运行"); }, 10)).rejects.toThrow("安装锁超时");
  release(); await first;
  await expect(withManagedKernelInstallLock(lock, async () => { throw new Error("准备失败"); })).rejects.toThrow("准备失败");
  expect(await withManagedKernelInstallLock(lock, async () => "released")).toBe("released");
});

it("等待其他进程释放安装锁，并回收已退出进程的 owner", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "kernel-process-lock-")); directories.push(directory);
  const lock = path.join(directory, "lock");
  const script = `const fs = require('node:fs');
    const lock = process.argv[1];
    fs.mkdirSync(lock); fs.writeFileSync(lock + '/owner.json', JSON.stringify({ pid: process.pid }), 'utf8');
    process.stdout.write('ready');
    process.stdin.resume(); process.stdin.on('end', () => { fs.rmSync(lock, { recursive: true }); process.exit(0); });`;
  const child = spawn(process.execPath, ["-e", script, lock], { stdio: ["pipe", "pipe", "pipe"] });
  const exited = once(child, "exit");
  try {
    await once(child.stdout, "data");
    await expect(withManagedKernelInstallLock(lock, async () => "overlap", 15)).rejects.toThrow("安装锁超时");
    const waiting = withManagedKernelInstallLock(lock, async () => "after-process");
    child.stdin.end();
    expect(await waiting).toBe("after-process");
    await exited;
  } finally { if (child.exitCode === null) child.kill(); }

  const abandoned = spawn(process.execPath, ["-e", `const fs = require('node:fs'); fs.mkdirSync(process.argv[1]);
    fs.writeFileSync(process.argv[1] + '/owner.json', JSON.stringify({ pid: process.pid }), 'utf8');`, lock]);
  await once(abandoned, "exit");
  expect(await withManagedKernelInstallLock(lock, async () => "recovered", 1000)).toBe("recovered");
});
