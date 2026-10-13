export const LIGHT_CONTENT_SCRIPTS = [
  "route-global.js",
  "dom-adapter-global.js",
  "turn-observer-global.js",
  "composer-write-adapter.js",
  "send-click-adapter.js",
  "content-lite.js",
];

// 旧能力仍打包用于兼容回归，不由默认 manifest 加载。
export const LEGACY_CONTENT_SCRIPTS = [
  "route-global.js",
  "dom-adapter-global.js",
  "turn-observer-global.js",
  "shadow-evidence.js",
  "composer-write-adapter.js",
  "send-click-adapter.js",
  "send-probe-message-global.js",
  "send-probe-run.js",
  "route-attestation-global.js",
  "route-attestation-run-global.js",
  "feedback-bootstrap-run-global.js",
  "production-send-runtime-global.js",
  "content-script.js",
];
