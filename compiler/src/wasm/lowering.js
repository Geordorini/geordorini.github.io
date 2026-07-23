// lowering.js — shared decisions about how a Lumen operator maps to a specific
// WebAssembly instruction, given the operand type. Both the binary emitter and
// the text (WAT) emitter import these so they can never disagree.

import { OP } from './opcodes.js';
import { Type } from '../types.js';

// binary operator + operand type -> { opcode, mnemonic }
const TABLE = {
  int: {
    '+': [OP.I32_ADD, 'i32.add'],
    '-': [OP.I32_SUB, 'i32.sub'],
    '*': [OP.I32_MUL, 'i32.mul'],
    '/': [OP.I32_DIV_S, 'i32.div_s'],
    '%': [OP.I32_REM_S, 'i32.rem_s'],
    '==': [OP.I32_EQ, 'i32.eq'],
    '!=': [OP.I32_NE, 'i32.ne'],
    '<': [OP.I32_LT_S, 'i32.lt_s'],
    '<=': [OP.I32_LE_S, 'i32.le_s'],
    '>': [OP.I32_GT_S, 'i32.gt_s'],
    '>=': [OP.I32_GE_S, 'i32.ge_s'],
  },
  float: {
    '+': [OP.F64_ADD, 'f64.add'],
    '-': [OP.F64_SUB, 'f64.sub'],
    '*': [OP.F64_MUL, 'f64.mul'],
    '/': [OP.F64_DIV, 'f64.div'],
    '==': [OP.F64_EQ, 'f64.eq'],
    '!=': [OP.F64_NE, 'f64.ne'],
    '<': [OP.F64_LT, 'f64.lt'],
    '<=': [OP.F64_LE, 'f64.le'],
    '>': [OP.F64_GT, 'f64.gt'],
    '>=': [OP.F64_GE, 'f64.ge'],
  },
  bool: {
    // equality on booleans is just i32 comparison
    '==': [OP.I32_EQ, 'i32.eq'],
    '!=': [OP.I32_NE, 'i32.ne'],
  },
};

function row(operandType) {
  // bool operands (only == / !=) use the i32 encodings
  return TABLE[operandType] || TABLE.int;
}

/** Numeric opcode byte for a binary op given the operand type. */
export function binaryOpcode(op, operandType) {
  const entry = row(operandType)[op];
  if (!entry) throw new Error(`no opcode for ${operandType} '${op}'`);
  return entry[0];
}

/** WAT mnemonic for a binary op given the operand type. */
export function binaryMnemonic(op, operandType) {
  const entry = row(operandType)[op];
  if (!entry) throw new Error(`no mnemonic for ${operandType} '${op}'`);
  return entry[1];
}

/** Whether unary '-' on this operand type uses f64.neg (vs. i32 `0 - x`). */
export function unaryIsFloatNeg(operandType) {
  return operandType === Type.FLOAT;
}
