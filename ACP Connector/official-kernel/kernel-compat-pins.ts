export type KernelCompatTargetName = "modelSelection" | "proxyServer" | "proxyAgentConfig" | "serverControl";

export interface KernelCompatTargetPin {
  readonly relativePath: string;
  readonly preimageSha256: string;
  readonly patchable: boolean;
}

export interface KernelCompatPins {
  readonly profileId: string;
  readonly parSha256: string;
  readonly externalHarnessSha256: string;
  readonly targets: Readonly<Record<KernelCompatTargetName, KernelCompatTargetPin>>;
}

// These are public integrity pins, not bundled Google artifacts or source context.
export const PRODUCTION_KERNEL_COMPAT_PINS: KernelCompatPins = Object.freeze({
  profileId: "1.4.3",
  parSha256: "7e06ec4aab6dcff53911a16c124692bc95c8848b2a1fd3220be6f67dbe7efafb",
  externalHarnessSha256: "55b2d1d8206d3f38353cdba3c5c5d087cd718241b90500bce4f8009f64495285",
  targets: Object.freeze({
    modelSelection: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py",
      preimageSha256: "1c3792bd3f8983052364f1600964a17dcfef3b624679441616445c464dcdef85",
      patchable: true
    }),
    proxyServer: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/ccpa_connection/proxy_server.py",
      preimageSha256: "e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de",
      patchable: true
    }),
    proxyAgentConfig: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/proxy_agent_config.py",
      preimageSha256: "3a7ca6fa8937c67fa27c54f42ce66095687b735898536afc32e0dc970c4ae182",
      patchable: true
    }),
    serverControl: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py",
      preimageSha256: "5a51fe07811386fed8e31b2de36137beac76796a3b78272f14b226f310bd2c3b",
      patchable: false
    })
  })
});

export const KERNEL_COMPAT_TARGET_NAMES: readonly KernelCompatTargetName[] = Object.freeze([
  "modelSelection",
  "proxyServer",
  "proxyAgentConfig",
  "serverControl"
]);
