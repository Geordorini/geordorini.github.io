# Lumen

A **production-quality, from-scratch compiler** for a small statically-typed
toy language named **Lumen**, targeting **WebAssembly**. It is written in plain
JavaScript (ES modules) with **zero dependencies**, runs in both Node.js and the
browser, and emits a real `.wasm` **binary** — not text that something else
assembles for you.

```
source (.lum)  ──▶  Lexer  ──▶  Parser  ──▶  Type Checker  ──▶  Wasm Emitter  ──▶  .wasm bytes
                   tokens        AST         typed AST          binary module
```

Every stage is hand-written:

| Stage | File | What it does |
| --- | --- | --- |
| **Lexer** | `src/lexer.js` | Character scanner → tokens, with line/col spans, `//` and `/* */` comments, and int/float literals (incl. `1.5e-3`). |
| **Parser** | `src/parser.js` | Recursive descent + Pratt precedence climbing → AST. |
| **Type checker** | `src/checker.js` | Full static analysis: types, mutability, arity, definite-return, scope resolution. Collects *all* errors, not just the first. |
| **Emitter (binary)** | `src/wasm/emitter.js` | Lowers the typed AST to a valid WebAssembly binary module. |
| **Emitter (text)** | `src/wasm/watEmitter.js` | A second back end producing readable WAT, sharing all lowering decisions. |

An interactive **[browser playground](playground/index.html)** compiles and runs
Lumen entirely client-side.

---

## Quick start

```bash
cd compiler

# run the full test suite (compiles, instantiates real wasm, checks results)
npm test

# compile & run an exported function
node bin/lumc.js examples/fib.lum --run fib 25          # -> 75025

# emit a .wasm binary
node bin/lumc.js examples/math.lum -o math.wasm

# inspect intermediate stages
node bin/lumc.js examples/fib.lum --wat                 # WebAssembly text
node bin/lumc.js examples/fib.lum --ast                 # AST as JSON
node bin/lumc.js examples/fib.lum --tokens              # token stream
```

Use it as a library:

```js
import { compile } from './src/index.js';

const { ok, wasm, wat, errors } = compile('export fn sq(x: int): int { return x * x; }', { wat: true });
const { instance } = await WebAssembly.instantiate(wasm, { env: {} });
instance.exports.sq(9); // 81
```

---

## The Lumen language

### Types

`int` (32-bit signed, → `i32`), `float` (64-bit IEEE-754, → `f64`),
`bool` (→ `i32` 0/1), and `void`. The type system is **strict**: there are no
implicit conversions, so `1 + 2.0` is a compile error — mix intentionally.

### Functions

```lumen
export fn add(a: int, b: int): int {   // `export` makes it a wasm export
  return a + b;
}

fn helper(x: float): float { return x * 2.0; }   // internal (not exported)

extern fn print(x: int): void;          // imported from the host ("env.print")
```

### Variables

```lumen
let x = 10;          // immutable, type inferred as int
let mut y: float = 0.0;   // mutable, explicit type
y = y + 1.0;         // reassignment requires `mut`
```

Reassigning an immutable binding, or assigning a mismatched type, is a compile
error.

### Control flow

```lumen
if (cond) { ... } else if (other) { ... } else { ... }

while (cond) {
  if (done) { break; }
  if (skip) { continue; }
}
```

Value-returning functions must return on **every** path — the checker proves it
(`function 'f' must return a value ... on all paths`).

### Operators

- Arithmetic: `+ - * /` (int **or** float), `%` (int only)
- Comparison: `< <= > >=` (numeric), `== !=` (any matching type)
- Logical: `&& ||` (short-circuiting, lowered to structured `if`), `!`
- Unary: `-` (numeric negation)

### Globals

```lumen
let PI = 3.14159;        // constant global
let mut counter = 0;     // mutable global
```

Global initializers must be constant expressions.

See [`examples/`](examples/) for Fibonacci, Newton's-method `sqrt`, GCD, a prime
sieve that calls a host `print`, and more.

---

## How the WebAssembly back end works

The emitter (`src/wasm/emitter.js`) assembles the module section by section,
writing bytes directly with LEB128 encoding (`src/wasm/leb128.js`):

- **Type section** — one deduplicated entry per distinct function signature.
- **Import section** — each `extern fn` becomes an `env.<name>` function import.
  Imports occupy the low function indices, before defined functions.
- **Function / Code sections** — locals are flat per function; nested `let`s
  (including shadowing) each get a fresh local slot.
- **Global / Export sections** — globals with constant initializers; exported
  functions by name.

Interesting lowering details:

- **`while`** becomes `block { loop { <cond> i32.eqz br_if $exit; <body> br $loop } }`.
  `break`/`continue` are `br` instructions whose *relative depth* is computed
  from a control-frame stack, so they work correctly through arbitrary nesting.
- **`&&` / `||`** short-circuit via a structured `if (result i32)` rather than
  bitwise ops, so side effects in the right operand are only evaluated when
  needed.
- **Unary `-`** on `int` compiles to `0 - x` (wasm has no `i32.neg`); on `float`
  it uses `f64.neg`.
- Value-returning functions get a trailing `unreachable` so the module always
  validates even though the checker has already proven all paths return.

The output is verified two ways in `npm test`: every emitted module is passed to
`WebAssembly.validate` and then actually instantiated and executed, with results
asserted against expected values.

---

## Project layout

```
compiler/
├── bin/lumc.js            CLI: compile, run, --wat/--ast/--tokens
├── src/
│   ├── lexer.js           tokenizer
│   ├── token.js           token kinds & keywords
│   ├── parser.js          recursive-descent + Pratt parser
│   ├── ast.js             AST node constructors
│   ├── types.js           the type universe
│   ├── checker.js         static type checker / semantic analysis
│   ├── diagnostics.js     spans + rustc-style error formatting
│   ├── compiler.js        the lex→parse→check→emit pipeline
│   ├── index.js           public API
│   └── wasm/
│       ├── leb128.js      byte buffer + LEB128 / IEEE-754 encoding
│       ├── opcodes.js     section IDs, value types, instruction opcodes
│       ├── lowering.js    shared op→instruction decisions
│       ├── emitter.js     AST → wasm binary
│       └── watEmitter.js  AST → wasm text (WAT)
├── examples/              sample .lum programs
├── test/
│   ├── run.js             end-to-end compile-and-execute tests
│   └── browser.mjs        headless-browser playground smoke test
└── playground/index.html  in-browser IDE
```

## Testing

```bash
npm test            # 41 compile-and-run + negative-diagnostic tests
```

The negative tests confirm the checker rejects type mismatches, missing
returns, immutable assignment, undeclared variables, wrong arity, non-`bool`
conditions, `break` outside loops, and more — each with a specific message.

## License

MIT.
