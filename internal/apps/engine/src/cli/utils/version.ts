// CLI 版本號工具 — 直接 re-export 共用的 getEngineVersion
// 真正的實作在 src/version.ts（CLI 和 core 共用）
export { getEngineVersion } from '../../version';
