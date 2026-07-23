// compiler.js — the end-to-end pipeline: source text -> wasm bytes.
//
// This orchestrates the four phases (lex, parse, check, emit) and returns a
// structured result so callers (CLI, tests, playground) can inspect any
// intermediate stage or the collected diagnostics.

import { tokenize } from './lexer.js';
import { parse } from './parser.js';
import { check } from './checker.js';
import { emit } from './wasm/emitter.js';
import { emitWat } from './wasm/watEmitter.js';
import { CompileError } from './diagnostics.js';

/**
 * Compile Lumen source to a WebAssembly module.
 *
 * @param {string} source
 * @param {object} [opts]
 * @param {string} [opts.filename] used in error messages
 * @param {boolean} [opts.wat] also produce a WAT text listing
 * @returns {{
 *   ok: boolean,
 *   tokens?: object[],
 *   ast?: object,
 *   check?: object,
 *   wasm?: Uint8Array,
 *   wat?: string,
 *   errors: CompileError[],
 * }}
 */
export function compile(source, opts = {}) {
  const filename = opts.filename || '<input>';
  const result = { ok: false, errors: [] };

  // Phase 1 & 2: lexing and parsing raise on the first hard error.
  let tokens;
  let ast;
  try {
    tokens = tokenize(source);
    result.tokens = tokens;
    ast = parse(tokens);
    result.ast = ast;
  } catch (err) {
    if (err instanceof CompileError) {
      result.errors.push(err);
      return result;
    }
    throw err;
  }

  // Phase 3: type checking accumulates every error it can find.
  const checkResult = check(ast);
  result.check = checkResult;
  if (checkResult.errors.length > 0) {
    result.errors.push(...checkResult.errors);
    return result;
  }

  // Phase 4: code emission.
  try {
    result.wasm = emit(ast, checkResult);
    if (opts.wat) result.wat = emitWat(ast, checkResult);
  } catch (err) {
    if (err instanceof CompileError) {
      result.errors.push(err);
      return result;
    }
    throw err;
  }

  result.ok = true;
  return result;
}

/**
 * Format all diagnostics from a compile result into a single string.
 */
export function formatErrors(result, source, filename = '<input>') {
  return result.errors.map((e) => e.format(source, filename)).join('\n\n');
}
