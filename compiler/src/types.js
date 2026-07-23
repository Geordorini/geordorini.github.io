// types.js — the (small) Lumen type universe.
//
// Lumen has four types: int, float, bool, and void. Types are represented as
// interned string tags. Helpers here classify types and map them onto the
// WebAssembly value types used by the code emitter.

export const Type = Object.freeze({
  INT: 'int',
  FLOAT: 'float',
  BOOL: 'bool',
  VOID: 'void',
});

const ALL = new Set(Object.values(Type));

export function isType(name) {
  return ALL.has(name);
}

export function isNumeric(t) {
  return t === Type.INT || t === Type.FLOAT;
}

/** WebAssembly value type byte for a Lumen type (void has none). */
export const WASM_VALTYPE = Object.freeze({
  [Type.INT]: 0x7f,   // i32
  [Type.FLOAT]: 0x7c, // f64
  [Type.BOOL]: 0x7f,  // i32 (0 or 1)
});

/** Human-readable list for error messages. */
export function typeName(t) {
  return t;
}
