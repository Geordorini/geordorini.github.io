#!/usr/bin/env node
// lumc.js — the Lumen command-line compiler.
//
// Usage:
//   lumc <file.lum> [options]
//
// Options:
//   -o, --out <file>   write the .wasm binary to <file> (default: <input>.wasm)
//   --wat              print the WAT text listing to stdout
//   --run [fn] [args]  compile in-memory and run exported function `fn`
//                      (default: main) with numeric arguments, printing result
//   --tokens           dump the token stream as JSON
//   --ast              dump the AST as JSON
//   --no-emit          type-check only; do not write output
//   -h, --help         show this help

import { readFileSync, writeFileSync } from 'node:fs';
import { basename } from 'node:path';
import { compile, formatErrors } from '../src/index.js';

function usage() {
  console.log(`lumc — the Lumen compiler

Usage:
  lumc <file.lum> [options]

Options:
  -o, --out <file>   write the .wasm binary (default: <input>.wasm)
  --wat              print the WAT text listing
  --run [fn=main]    compile and run exported function, e.g. --run add 2 3
  --tokens           dump the token stream as JSON
  --ast              dump the AST as JSON
  --no-emit          type-check only
  -h, --help         show this help`);
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0 || argv.includes('-h') || argv.includes('--help')) {
    usage();
    process.exit(argv.length === 0 ? 1 : 0);
  }

  const opts = { wat: false, tokens: false, ast: false, emit: true, run: null };
  let input = null;
  let out = null;
  const runArgs = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--wat') opts.wat = true;
    else if (a === '--tokens') opts.tokens = true;
    else if (a === '--ast') opts.ast = true;
    else if (a === '--no-emit') opts.emit = false;
    else if (a === '-o' || a === '--out') out = argv[++i];
    else if (a === '--run') {
      // remaining args after --run are: [fnName] [numeric args...]
      opts.run = argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[++i] : 'main';
      while (i + 1 < argv.length && !argv[i + 1].startsWith('-')) {
        runArgs.push(Number(argv[++i]));
      }
    } else if (a.startsWith('-')) {
      console.error(`unknown option: ${a}`);
      process.exit(1);
    } else {
      input = a;
    }
  }

  if (!input) {
    console.error('error: no input file');
    process.exit(1);
  }

  let source;
  try {
    source = readFileSync(input, 'utf8');
  } catch (err) {
    console.error(`error: cannot read '${input}': ${err.message}`);
    process.exit(1);
  }

  const result = compile(source, { filename: input, wat: opts.wat || Boolean(opts.run) });

  if (result.errors.length > 0) {
    console.error(formatErrors(result, source, input));
    console.error(`\n${result.errors.length} error(s); compilation failed.`);
    process.exit(1);
  }

  if (opts.tokens) {
    console.log(JSON.stringify(
      result.tokens.map((t) => ({ kind: t.kind, text: t.text })), null, 2,
    ));
  }
  if (opts.ast) {
    console.log(JSON.stringify(result.ast, replacer, 2));
  }
  if (opts.wat) {
    process.stdout.write(result.wat);
  }

  if (opts.run) {
    await runModule(result.wasm, opts.run, runArgs);
    return;
  }

  if (opts.emit && !opts.tokens && !opts.ast && !opts.wat) {
    const outfile = out || input.replace(/\.lum$/, '') + '.wasm';
    writeFileSync(outfile, result.wasm);
    console.log(`wrote ${outfile} (${result.wasm.length} bytes)`);
  } else if (opts.emit && out) {
    writeFileSync(out, result.wasm);
    console.log(`wrote ${out} (${result.wasm.length} bytes)`);
  }
}

// Instantiate the module with a small `env` providing print helpers, then call
// the requested export.
async function runModule(wasmBytes, fnName, args) {
  const env = {
    print: (x) => console.log(x),
    print_int: (x) => console.log(x),
    print_float: (x) => console.log(x),
    print_bool: (x) => console.log(Boolean(x)),
  };
  const { instance } = await WebAssembly.instantiate(wasmBytes, { env });
  const fn = instance.exports[fnName];
  if (typeof fn !== 'function') {
    console.error(`error: exported function '${fnName}' not found`);
    console.error(`available exports: ${Object.keys(instance.exports).join(', ') || '(none)'}`);
    process.exit(1);
  }
  const value = fn(...args);
  if (value !== undefined) console.log(value);
}

// Strip parser/checker back-references (spans are fine) for --ast JSON output.
function replacer(key, value) {
  if (key === 'decl') return undefined; // avoid circular signature -> decl
  return value;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
