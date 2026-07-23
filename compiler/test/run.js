// run.js — end-to-end test suite for the Lumen compiler.
//
// Each positive test compiles source to a wasm binary, instantiates it with
// Node's built-in WebAssembly, calls an exported function, and asserts the
// result. Negative tests assert that compilation fails with an expected error
// substring. Run with:  node test/run.js
//
// This is the proof that the compiler is "fully functional": the bytes it
// emits are validated and executed by a real WebAssembly engine.

import { compile } from '../src/index.js';

let passed = 0;
let failed = 0;
const failures = [];

function fail(name, detail) {
  failed++;
  failures.push(`✗ ${name}\n    ${detail}`);
}

function pass(name) {
  passed++;
}

async function instantiate(source, env = {}) {
  const result = compile(source);
  if (!result.ok) {
    const msg = result.errors.map((e) => e.message).join('; ');
    throw new Error(`compilation failed: ${msg}`);
  }
  // Validate first for a clearer error than instantiate would give.
  if (!WebAssembly.validate(result.wasm)) {
    throw new Error('WebAssembly.validate rejected the emitted module');
  }
  const { instance } = await WebAssembly.instantiate(result.wasm, { env });
  return instance.exports;
}

// A positive test: compile, run `fn(...args)`, compare to `expected`.
async function run(name, source, fn, args, expected, opts = {}) {
  try {
    const exports = await instantiate(source, opts.env || {});
    const got = exports[fn](...args);
    const ok = opts.approx
      ? Math.abs(got - expected) < 1e-9
      : got === expected;
    if (ok) pass(name);
    else fail(name, `expected ${expected}, got ${got}`);
  } catch (err) {
    fail(name, err.message);
  }
}

// A negative test: compilation must fail and include `expectSubstr`.
function expectError(name, source, expectSubstr) {
  const result = compile(source);
  if (result.ok) {
    fail(name, 'expected a compile error but compilation succeeded');
    return;
  }
  const combined = result.errors.map((e) => e.message).join('\n');
  if (combined.includes(expectSubstr)) pass(name);
  else fail(name, `expected error containing "${expectSubstr}", got: ${combined}`);
}

async function main() {
  // ---- arithmetic --------------------------------------------------------
  await run('int add', `export fn add(a: int, b: int): int { return a + b; }`,
    'add', [2, 3], 5);

  await run('int precedence', `export fn f(): int { return 2 + 3 * 4 - 1; }`,
    'f', [], 13);

  await run('int div/mod', `export fn f(a: int, b: int): int { return a / b + a % b; }`,
    'f', [17, 5], 3 + 2);

  await run('unary minus', `export fn f(x: int): int { return -x - -3; }`,
    'f', [10], -10 + 3);

  await run('float math',
    `export fn f(a: float, b: float): float { return a * b + 1.5; }`,
    'f', [2.0, 4.0], 9.5, { approx: true });

  await run('float divide',
    `export fn f(a: float, b: float): float { return a / b; }`,
    'f', [7.0, 2.0], 3.5, { approx: true });

  await run('scientific literal',
    `export fn f(): float { return 1.5e3 + 2.0; }`, 'f', [], 1502.0, { approx: true });

  // ---- comparisons & logic ----------------------------------------------
  await run('comparison', `export fn f(a: int, b: int): bool { return a < b; }`,
    'f', [3, 5], 1);

  await run('equality bool', `export fn f(a: bool, b: bool): bool { return a == b; }`,
    'f', [1, 0], 0);

  await run('logical and short-circuit',
    `export fn f(a: bool, b: bool): bool { return a && b; }`, 'f', [1, 1], 1);

  await run('logical or',
    `export fn f(a: bool, b: bool): bool { return a || b; }`, 'f', [0, 0], 0);

  await run('not', `export fn f(a: bool): bool { return !a; }`, 'f', [0], 1);

  await run('complex bool',
    `export fn f(x: int): bool { return x > 0 && x < 10 || x == 100; }`,
    'f', [100], 1);

  // ---- control flow ------------------------------------------------------
  await run('if/else', `
    export fn max(a: int, b: int): int {
      if (a > b) { return a; } else { return b; }
    }`, 'max', [7, 12], 12);

  await run('else-if chain', `
    export fn sign(x: int): int {
      if (x > 0) { return 1; }
      else if (x < 0) { return -1; }
      else { return 0; }
    }`, 'sign', [-42], -1);

  await run('while sum', `
    export fn sum(n: int): int {
      let mut total = 0;
      let mut i = 1;
      while (i <= n) { total = total + i; i = i + 1; }
      return total;
    }`, 'sum', [100], 5050);

  await run('break', `
    export fn firstMultiple(n: int): int {
      let mut i = 1;
      while (true) {
        if (i % n == 0 && i > 0) { break; }
        i = i + 1;
      }
      return i;
    }`, 'firstMultiple', [7], 7);

  await run('continue', `
    export fn sumEven(n: int): int {
      let mut total = 0;
      let mut i = 0;
      while (i < n) {
        i = i + 1;
        if (i % 2 == 1) { continue; }
        total = total + i;
      }
      return total;
    }`, 'sumEven', [10], 2 + 4 + 6 + 8 + 10);

  await run('nested loops with break', `
    export fn f(): int {
      let mut count = 0;
      let mut i = 0;
      while (i < 5) {
        let mut j = 0;
        while (j < 5) {
          if (j == 3) { break; }
          count = count + 1;
          j = j + 1;
        }
        i = i + 1;
      }
      return count;
    }`, 'f', [], 15);

  // ---- recursion ---------------------------------------------------------
  await run('fibonacci', `
    export fn fib(n: int): int {
      if (n < 2) { return n; }
      return fib(n - 1) + fib(n - 2);
    }`, 'fib', [15], 610);

  await run('factorial', `
    export fn fact(n: int): int {
      if (n <= 1) { return 1; }
      return n * fact(n - 1);
    }`, 'fact', [10], 3628800);

  await run('mutual recursion', `
    fn isEven(n: int): bool {
      if (n == 0) { return true; }
      return isOdd(n - 1);
    }
    fn isOdd(n: int): bool {
      if (n == 0) { return false; }
      return isEven(n - 1);
    }
    export fn test(n: int): bool { return isEven(n); }`,
    'test', [10], 1);

  // ---- globals -----------------------------------------------------------
  await run('mutable global counter', `
    let mut counter = 0;
    export fn bump(): int { counter = counter + 1; return counter; }`,
    'bump', [], 1);

  await run('const global', `
    let PI = 3.14159;
    export fn area(r: float): float { return PI * r * r; }`,
    'area', [2.0], 3.14159 * 4, { approx: true });

  await run('negative global init', `
    let mut base = -5;
    export fn f(): int { return base; }`, 'f', [], -5);

  // ---- shadowing & scoping ----------------------------------------------
  await run('block shadowing', `
    export fn f(): int {
      let x = 1;
      { let x = 100; }
      return x;
    }`, 'f', [], 1);

  await run('local type inference', `
    export fn f(): float {
      let x = 2.5;
      let y = x * 2.0;
      return y;
    }`, 'f', [], 5.0, { approx: true });

  // ---- imports (extern) --------------------------------------------------
  {
    const log = [];
    await run('extern print import', `
      extern fn print(x: int): void;
      export fn shout(n: int): void { print(n); print(n * 2); }`,
      'shout', [21], undefined, { env: { print: (x) => log.push(x) } });
    if (log.join(',') === '21,42') pass('extern print side effects');
    else fail('extern print side effects', `log was [${log.join(',')}]`);
  }

  await run('void function', `
    let mut acc = 0;
    fn addTo(x: int): void { acc = acc + x; }
    export fn run(): int { addTo(3); addTo(4); return acc; }`,
    'run', [], 7);

  // ---- negative (type/semantic errors) ----------------------------------
  expectError('type mismatch add', `fn f(): int { return 1 + true; }`,
    'matching numeric operands');
  expectError('missing return', `fn f(): int { let x = 1; }`,
    'must return a value');
  expectError('assign immutable', `fn f(): int { let x = 1; x = 2; return x; }`,
    'immutable');
  expectError('undeclared var', `fn f(): int { return y; }`,
    'undeclared variable');
  expectError('wrong arg count',
    `fn g(a: int): int { return a; } fn f(): int { return g(1, 2); }`,
    'expects 1 argument');
  expectError('condition not bool', `fn f(): int { if (1) { return 1; } return 0; }`,
    "must be 'bool'");
  expectError('break outside loop', `fn f(): int { break; return 0; }`,
    'outside of a loop');
  expectError('return value from void', `fn f(): void { return 1; }`,
    'returns void');
  expectError('mixed numeric', `fn f(a: int, b: float): float { return a + b; }`,
    'matching numeric operands');
  expectError('duplicate function', `fn f(): int { return 0; } fn f(): int { return 1; }`,
    'already declared');
  expectError('modulo on float', `fn f(a: float, b: float): float { return a % b; }`,
    "requires two 'int' operands");

  // ---- report ------------------------------------------------------------
  console.log(`\n${'─'.repeat(50)}`);
  if (failures.length) {
    console.log(failures.join('\n'));
    console.log(`${'─'.repeat(50)}`);
  }
  console.log(`${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
