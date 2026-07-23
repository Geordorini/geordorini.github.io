// opcodes.js — the subset of the WebAssembly instruction set and section IDs
// that the Lumen emitter uses. Kept in one place so both the binary emitter
// and the WAT (text) emitter agree on lowering decisions.

// Section IDs.
export const SECTION = Object.freeze({
  TYPE: 1,
  IMPORT: 2,
  FUNCTION: 3,
  TABLE: 4,
  MEMORY: 5,
  GLOBAL: 6,
  EXPORT: 7,
  START: 8,
  ELEMENT: 9,
  CODE: 10,
  DATA: 11,
});

// Value types.
export const VAL = Object.freeze({
  I32: 0x7f,
  I64: 0x7e,
  F32: 0x7d,
  F64: 0x7c,
});

export const FUNC_TYPE = 0x60;   // functype tag
export const EMPTY_BLOCK = 0x40; // block type: no result
export const EXPORT_FUNC = 0x00;
export const EXPORT_GLOBAL = 0x03;
export const MUT_CONST = 0x00;
export const MUT_VAR = 0x01;

// Instruction opcodes (only what we emit).
export const OP = Object.freeze({
  UNREACHABLE: 0x00,
  NOP: 0x01,
  BLOCK: 0x02,
  LOOP: 0x03,
  IF: 0x04,
  ELSE: 0x05,
  END: 0x0b,
  BR: 0x0c,
  BR_IF: 0x0d,
  RETURN: 0x0f,
  CALL: 0x10,
  DROP: 0x1a,
  SELECT: 0x1b,

  LOCAL_GET: 0x20,
  LOCAL_SET: 0x21,
  LOCAL_TEE: 0x22,
  GLOBAL_GET: 0x23,
  GLOBAL_SET: 0x24,

  I32_CONST: 0x41,
  F64_CONST: 0x44,

  // i32 comparisons
  I32_EQZ: 0x45,
  I32_EQ: 0x46,
  I32_NE: 0x47,
  I32_LT_S: 0x48,
  I32_GT_S: 0x4a,
  I32_LE_S: 0x4c,
  I32_GE_S: 0x4e,

  // f64 comparisons
  F64_EQ: 0x61,
  F64_NE: 0x62,
  F64_LT: 0x63,
  F64_GT: 0x64,
  F64_LE: 0x65,
  F64_GE: 0x66,

  // i32 arithmetic
  I32_ADD: 0x6a,
  I32_SUB: 0x6b,
  I32_MUL: 0x6c,
  I32_DIV_S: 0x6d,
  I32_REM_S: 0x6f,
  I32_AND: 0x71,
  I32_OR: 0x72,

  // f64 arithmetic
  F64_NEG: 0x9a,
  F64_ADD: 0xa0,
  F64_SUB: 0xa1,
  F64_MUL: 0xa2,
  F64_DIV: 0xa3,
});
