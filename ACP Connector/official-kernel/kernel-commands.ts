import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  ensureManagedOfficialKernel,
  managedCompatRoot,
  managedOfficialKernelRoot,
  managedStableWrapper,
  officialKernelDownload,
  usesManagedOfficialKernel
} from "./ensure-managed-kernel.js";
import { OfficialKernelCompatLifecycle } from "./kernel-compat-lifecycle.js";

export interface KernelDoctorReport {
  readonly adapterVersion: string;
  readonly platform: string;
  readonly arch: string;
  readonly ready: boolean;
  readonly kernel: {
    readonly managed: boolean;
    readonly binary?: string;
    readonly executable: boolean;
    readonly compatibilityVerified?: boolean;
  };
  readonly authentication: "not_checked";
  readonly daemon: "not_checked";
  readonly issues: readonly string[];
}

/** 只读检查本地执行文件及托管收据，不下载、不启动内核、不读取账号凭据。 */
export async function inspectOfficialKernel(
  environment: NodeJS.ProcessEnv,
  version: string
): Promise<KernelDoctorReport> {
  const home = environment.HOME?.trim() || homedir();
  const configured = environment.PASEO_AGY_ACP_OFFICIAL_BIN?.trim();
  const managed = usesManagedOfficialKernel(configured, home);
  const issues: string[] = [];
  let binary = configured;
  let compatibilityVerified: boolean | undefined;
  if (managed) {
    try {
      const download = officialKernelDownload();
      binary = download.compat
        ? managedStableWrapper(home)
        : path.join(managedOfficialKernelRoot(home), download.binaryName);
      if (download.compat) {
        const status = await new OfficialKernelCompatLifecycle({ stateRoot: managedCompatRoot(home) }).status();
        compatibilityVerified = status.current?.verified === true;
        issues.push(...status.issues);
        if (!compatibilityVerified && issues.length === 0) issues.push("托管内核尚未准备或激活，请运行 --prepare-kernel。");
      }
    } catch (error) {
      compatibilityVerified = false;
      issues.push(error instanceof Error ? error.message : "无法检查托管内核。");
    }
  }
  let executable = false;
  if (binary) {
    try {
      const info = await stat(binary);
      if (!info.isFile()) throw new Error("内核路径不是文件。");
      await access(binary, process.platform === "win32" ? constants.F_OK : constants.X_OK);
      executable = true;
    } catch {
      issues.push("内核执行文件不存在或不可执行。");
    }
  } else {
    issues.push("未找到当前平台的内核执行路径。");
  }
  return {
    adapterVersion: version,
    platform: process.platform,
    arch: process.arch,
    ready: executable && compatibilityVerified !== false && issues.length === 0,
    kernel: { managed, ...(binary ? { binary } : {}), executable, ...(compatibilityVerified === undefined ? {} : { compatibilityVerified }) },
    authentication: "not_checked",
    daemon: "not_checked",
    issues
  };
}

/** 显式安装入口与普通 ACP 启动共用同一套哈希、补丁和收据生命周期。 */
export async function prepareOfficialKernel(
  environment: NodeJS.ProcessEnv,
  version: string
): Promise<KernelDoctorReport> {
  const binary = await ensureManagedOfficialKernel(environment);
  const report = await inspectOfficialKernel(environment, version);
  if (!report.ready) throw new Error(report.issues.join("\n") || `内核未就绪：${binary}`);
  return report;
}
