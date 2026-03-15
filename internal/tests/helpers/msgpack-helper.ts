// MessagePack 編解碼測試工具
// 注意：正式使用時安裝 @msgpack/msgpack

export function encodeMsgpack(data: unknown): Uint8Array {
  // Phase 1+ 實際接入 @msgpack/msgpack
  return new TextEncoder().encode(JSON.stringify(data));
}

export function decodeMsgpack(buffer: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(buffer));
}
