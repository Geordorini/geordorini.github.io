// index.js — public entry point for the Lumen compiler library.
//
// Import this from Node or the browser:
//   import { compile } from './compiler/src/index.js';
//   const { ok, wasm, errors } = compile(source);

export { compile, formatErrors } from './compiler.js';
export { tokenize, Lexer } from './lexer.js';
export { parse, Parser } from './parser.js';
export { check, Checker } from './checker.js';
export { emit, Emitter } from './wasm/emitter.js';
export { emitWat } from './wasm/watEmitter.js';
export { CompileError, Span } from './diagnostics.js';
export { Type } from './types.js';
