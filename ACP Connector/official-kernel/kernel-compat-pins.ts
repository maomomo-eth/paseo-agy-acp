export type KernelCompatTargetName = "modelSelection" | "proxyServer" | "serverControl";

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
  profileId: "1.3.0",
  parSha256: "cf6feaebdacfc2255dcfc8883db99b15de8554698554e2a1e78e5ccec1c68a20",
  externalHarnessSha256: "63042ca43fc7a69600683920f7706689b82cf8aecefe21dc18cf35e99c9dde4d",
  targets: Object.freeze({
    modelSelection: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/model_selection.py",
      preimageSha256: "0c0ea7564fde8d66f9a789838d6542c6ae2da18710f557ebc30975200e39656b",
      patchable: true
    }),
    proxyServer: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/ccpa_connection/proxy_server.py",
      preimageSha256: "e350a8c7bef2d9e3616c6980774527d100137275bec5da147781e87f587012de",
      patchable: true
    }),
    serverControl: Object.freeze({
      relativePath: "google3/cloud/developer_experience/antigravity_extensions/acp_server/server.py",
      preimageSha256: "4b2171c74c116346260a9aa24e5372190bf0ad66cad8acebc350e89203157fe3",
      patchable: false
    })
  })
});

export const KERNEL_COMPAT_TARGET_NAMES: readonly KernelCompatTargetName[] = Object.freeze([
  "modelSelection",
  "proxyServer",
  "serverControl"
]);
