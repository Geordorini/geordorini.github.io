// checker.js — static type checker and semantic analyzer.
//
// Responsibilities:
//   * build a global symbol table of functions (extern + defined) and globals
//   * resolve and validate every declaration's types
//   * type-check each statement and expression, annotating expression nodes
//     with a `.type` field the code emitter relies on
//   * enforce mutability, definite-return for non-void functions, and that
//     break/continue only appear inside loops
//
// The checker collects *all* errors it can before giving up, so users see more
// than one problem per run. It throws the first error's CompileError only when
// callers ask for a single-error API; `check()` returns the full list.

import { CompileError } from './diagnostics.js';
import { Type, isNumeric } from './types.js';
import { N } from './ast.js';

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;

class Scope {
  constructor(parent = null) {
    this.parent = parent;
    this.vars = new Map(); // name -> { type, mut }
  }

  declare(name, info) {
    this.vars.set(name, info);
  }

  lookup(name) {
    for (let s = this; s; s = s.parent) {
      if (s.vars.has(name)) return s.vars.get(name);
    }
    return null;
  }

  hasLocal(name) {
    return this.vars.has(name);
  }
}

export class Checker {
  constructor(program) {
    this.program = program;
    this.functions = new Map(); // name -> signature
    this.globals = new Map();   // name -> { type, mut }
    this.errors = [];
  }

  error(message, span) {
    this.errors.push(new CompileError(message, span, 'check'));
  }

  /** Run all passes. Returns { functions, globals, errors }. */
  check() {
    this.collectSignatures();
    this.checkGlobals();
    for (const decl of this.program.decls) {
      if (decl.kind === N.FuncDecl) this.checkFunction(decl);
    }
    return {
      functions: this.functions,
      globals: this.globals,
      errors: this.errors,
    };
  }

  // ---- pass 1: collect top-level signatures ------------------------------

  collectSignatures() {
    for (const decl of this.program.decls) {
      if (decl.kind === N.FuncDecl || decl.kind === N.ExternDecl) {
        if (this.functions.has(decl.name)) {
          this.error(`function '${decl.name}' is already declared`, decl.span);
          continue;
        }
        const seen = new Set();
        for (const p of decl.params) {
          if (seen.has(p.name)) {
            this.error(
              `duplicate parameter '${p.name}' in function '${decl.name}'`,
              p.span,
            );
          }
          seen.add(p.name);
          if (p.type.name === Type.VOID) {
            this.error("parameters cannot have type 'void'", p.type.span);
          }
        }
        this.functions.set(decl.name, {
          name: decl.name,
          params: decl.params.map((p) => p.type.name),
          paramNames: decl.params.map((p) => p.name),
          ret: decl.retType.name,
          imported: decl.kind === N.ExternDecl,
          exported: decl.kind === N.FuncDecl ? decl.exported : false,
          decl,
        });
      }
    }
  }

  // ---- pass 2: globals ---------------------------------------------------

  checkGlobals() {
    for (const decl of this.program.decls) {
      if (decl.kind !== N.GlobalDecl) continue;
      if (this.globals.has(decl.name)) {
        this.error(`global '${decl.name}' is already declared`, decl.span);
        continue;
      }
      // Global initializers must be constant expressions.
      const initType = this.checkConstExpr(decl.init);
      let type = initType;
      if (decl.declaredType) {
        type = decl.declaredType.name;
        if (initType && initType !== type) {
          this.error(
            `global '${decl.name}' declared as '${type}' but initialized ` +
              `with '${initType}'`,
            decl.init.span,
          );
        }
      }
      if (type === Type.VOID) {
        this.error("global cannot have type 'void'", decl.span);
        type = Type.INT;
      }
      this.globals.set(decl.name, { type, mut: decl.mut });
    }
  }

  /** A constant expression: literal, or unary minus of a numeric literal. */
  checkConstExpr(expr) {
    switch (expr.kind) {
      case N.IntLit:
        this.checkIntLit(expr);
        expr.type = Type.INT;
        return Type.INT;
      case N.FloatLit:
        expr.type = Type.FLOAT;
        return Type.FLOAT;
      case N.BoolLit:
        expr.type = Type.BOOL;
        return Type.BOOL;
      case N.Unary:
        if (
          expr.op === '-' &&
          (expr.operand.kind === N.IntLit || expr.operand.kind === N.FloatLit)
        ) {
          const t = this.checkConstExpr(expr.operand);
          expr.type = t;
          return t;
        }
        this.error('global initializer must be a constant', expr.span);
        return null;
      default:
        this.error('global initializer must be a constant', expr.span);
        return null;
    }
  }

  // ---- pass 3: function bodies -------------------------------------------

  checkFunction(fn) {
    this.currentFn = this.functions.get(fn.name);
    this.loopDepth = 0;
    const scope = new Scope(null);
    for (const p of fn.params) {
      if (scope.hasLocal(p.name)) continue; // duplicate already reported
      scope.declare(p.name, { type: p.type.name, mut: true });
    }
    this.checkBlock(fn.body, scope);

    // Definite return analysis for value-returning functions.
    if (this.currentFn.ret !== Type.VOID && !this.blockReturns(fn.body)) {
      this.error(
        `function '${fn.name}' must return a value of type ` +
          `'${this.currentFn.ret}' on all paths`,
        fn.body.span,
      );
    }
  }

  checkBlock(block, parentScope) {
    const scope = new Scope(parentScope);
    for (const stmt of block.stmts) {
      this.checkStmt(stmt, scope);
    }
  }

  checkStmt(stmt, scope) {
    switch (stmt.kind) {
      case N.LetStmt: return this.checkLet(stmt, scope);
      case N.AssignStmt: return this.checkAssign(stmt, scope);
      case N.IfStmt: return this.checkIf(stmt, scope);
      case N.WhileStmt: return this.checkWhile(stmt, scope);
      case N.ReturnStmt: return this.checkReturn(stmt, scope);
      case N.Block: return this.checkBlock(stmt, scope);
      case N.BreakStmt:
      case N.ContinueStmt:
        if (this.loopDepth === 0) {
          const word = stmt.kind === N.BreakStmt ? 'break' : 'continue';
          this.error(`'${word}' used outside of a loop`, stmt.span);
        }
        return;
      case N.ExprStmt:
        this.checkExpr(stmt.expr, scope);
        return;
      default:
        this.error(`unhandled statement '${stmt.kind}'`, stmt.span);
    }
  }

  checkLet(stmt, scope) {
    const initType = this.checkExpr(stmt.init, scope);
    let type = initType;
    if (stmt.declaredType) {
      type = stmt.declaredType.name;
      if (type === Type.VOID) {
        this.error("variable cannot have type 'void'", stmt.declaredType.span);
      } else if (initType !== Type.VOID && initType !== type) {
        this.error(
          `cannot initialize '${stmt.name}' of type '${type}' with a value ` +
            `of type '${initType}'`,
          stmt.init.span,
        );
      }
    } else if (initType === Type.VOID) {
      this.error(
        `cannot infer a type for '${stmt.name}' from a void expression`,
        stmt.span,
      );
      type = Type.INT;
    }
    if (scope.hasLocal(stmt.name)) {
      this.error(
        `variable '${stmt.name}' is already declared in this scope`,
        stmt.span,
      );
    }
    scope.declare(stmt.name, { type, mut: stmt.mut });
    stmt.resolvedType = type;
  }

  checkAssign(stmt, scope) {
    const valueType = this.checkExpr(stmt.value, scope);
    const local = scope.lookup(stmt.name);
    const global = this.globals.get(stmt.name);
    const target = local || global;
    if (!target) {
      this.error(`cannot assign to undeclared variable '${stmt.name}'`, stmt.span);
      return;
    }
    if (!target.mut) {
      this.error(
        `cannot assign to immutable '${stmt.name}' ` +
          `(declare it with 'let mut' to allow reassignment)`,
        stmt.span,
      );
    }
    if (valueType !== Type.VOID && valueType !== target.type) {
      this.error(
        `cannot assign a value of type '${valueType}' to '${stmt.name}' ` +
          `of type '${target.type}'`,
        stmt.value.span,
      );
    }
    stmt.isGlobal = !local && Boolean(global);
  }

  checkIf(stmt, scope) {
    const condType = this.checkExpr(stmt.cond, scope);
    if (condType !== Type.BOOL && condType !== Type.VOID) {
      this.error(
        `if-condition must be 'bool', found '${condType}'`,
        stmt.cond.span,
      );
    }
    this.checkBlock(stmt.then, scope);
    if (stmt.otherwise) {
      if (stmt.otherwise.kind === N.IfStmt) this.checkIf(stmt.otherwise, scope);
      else this.checkBlock(stmt.otherwise, scope);
    }
  }

  checkWhile(stmt, scope) {
    const condType = this.checkExpr(stmt.cond, scope);
    if (condType !== Type.BOOL && condType !== Type.VOID) {
      this.error(
        `while-condition must be 'bool', found '${condType}'`,
        stmt.cond.span,
      );
    }
    this.loopDepth++;
    this.checkBlock(stmt.body, scope);
    this.loopDepth--;
  }

  checkReturn(stmt, scope) {
    const expected = this.currentFn.ret;
    if (stmt.value) {
      const actual = this.checkExpr(stmt.value, scope);
      if (expected === Type.VOID) {
        this.error(
          `function '${this.currentFn.name}' returns void; cannot return a value`,
          stmt.value.span,
        );
      } else if (actual !== Type.VOID && actual !== expected) {
        this.error(
          `expected return type '${expected}', found '${actual}'`,
          stmt.value.span,
        );
      }
    } else if (expected !== Type.VOID) {
      this.error(
        `function '${this.currentFn.name}' must return a value of type ` +
          `'${expected}'`,
        stmt.span,
      );
    }
  }

  // ---- expressions -------------------------------------------------------

  /** Type-check an expression, annotate it with `.type`, and return the type. */
  checkExpr(expr, scope) {
    let t;
    switch (expr.kind) {
      case N.IntLit:
        this.checkIntLit(expr);
        t = Type.INT;
        break;
      case N.FloatLit:
        t = Type.FLOAT;
        break;
      case N.BoolLit:
        t = Type.BOOL;
        break;
      case N.Ident:
        t = this.checkIdent(expr, scope);
        break;
      case N.Unary:
        t = this.checkUnary(expr, scope);
        break;
      case N.Binary:
        t = this.checkBinary(expr, scope);
        break;
      case N.Call:
        t = this.checkCall(expr, scope);
        break;
      default:
        this.error(`unhandled expression '${expr.kind}'`, expr.span);
        t = Type.VOID;
    }
    expr.type = t;
    return t;
  }

  checkIntLit(expr) {
    if (!Number.isInteger(expr.value) || expr.value < 0 || expr.value > I32_MAX) {
      // Negative literals arrive as unary-minus; a bare literal above I32_MAX
      // (or the special-cased I32_MIN magnitude) is out of range here.
      if (expr.value !== -I32_MIN) {
        this.error(
          `integer literal ${expr.value} is out of range for 'int' ` +
            `(${I32_MIN}..${I32_MAX})`,
          expr.span,
        );
      }
    }
  }

  checkIdent(expr, scope) {
    const local = scope.lookup(expr.name);
    if (local) {
      expr.isGlobal = false;
      return local.type;
    }
    const global = this.globals.get(expr.name);
    if (global) {
      expr.isGlobal = true;
      return global.type;
    }
    if (this.functions.has(expr.name)) {
      this.error(
        `'${expr.name}' is a function; it must be called with '()'`,
        expr.span,
      );
      return Type.VOID;
    }
    this.error(`undeclared variable '${expr.name}'`, expr.span);
    return Type.VOID;
  }

  checkUnary(expr, scope) {
    const t = this.checkExpr(expr.operand, scope);
    if (t === Type.VOID) return Type.VOID; // error already reported
    if (expr.op === '-') {
      if (!isNumeric(t)) {
        this.error(`unary '-' requires a numeric operand, found '${t}'`, expr.span);
        return Type.INT;
      }
      return t;
    }
    // '!'
    if (t !== Type.BOOL) {
      this.error(`unary '!' requires a 'bool' operand, found '${t}'`, expr.span);
    }
    return Type.BOOL;
  }

  checkBinary(expr, scope) {
    const op = expr.op;
    const lt = this.checkExpr(expr.left, scope);
    const rt = this.checkExpr(expr.right, scope);
    if (lt === Type.VOID || rt === Type.VOID) return Type.VOID;

    const arithmetic = ['+', '-', '*', '/'];
    const compareOrder = ['<', '<=', '>', '>='];
    const equality = ['==', '!='];
    const logical = ['&&', '||'];

    if (arithmetic.includes(op)) {
      if (isNumeric(lt) && lt === rt) return lt;
      this.error(
        `operator '${op}' expects two matching numeric operands, ` +
          `found '${lt}' and '${rt}'`,
        expr.span,
      );
      return isNumeric(lt) ? lt : Type.INT;
    }
    if (op === '%') {
      if (lt === Type.INT && rt === Type.INT) return Type.INT;
      this.error(
        `operator '%' requires two 'int' operands, found '${lt}' and '${rt}'`,
        expr.span,
      );
      return Type.INT;
    }
    if (compareOrder.includes(op)) {
      if (isNumeric(lt) && lt === rt) return Type.BOOL;
      this.error(
        `operator '${op}' expects two matching numeric operands, ` +
          `found '${lt}' and '${rt}'`,
        expr.span,
      );
      return Type.BOOL;
    }
    if (equality.includes(op)) {
      if (lt === rt) return Type.BOOL;
      this.error(
        `operator '${op}' expects operands of the same type, ` +
          `found '${lt}' and '${rt}'`,
        expr.span,
      );
      return Type.BOOL;
    }
    if (logical.includes(op)) {
      if (lt === Type.BOOL && rt === Type.BOOL) return Type.BOOL;
      this.error(
        `operator '${op}' requires two 'bool' operands, found '${lt}' and '${rt}'`,
        expr.span,
      );
      return Type.BOOL;
    }
    this.error(`unknown operator '${op}'`, expr.span);
    return Type.VOID;
  }

  checkCall(expr, scope) {
    const sig = this.functions.get(expr.callee);
    if (!sig) {
      if (scope.lookup(expr.callee) || this.globals.has(expr.callee)) {
        this.error(`'${expr.callee}' is a variable, not a function`, expr.span);
      } else {
        this.error(`call to undeclared function '${expr.callee}'`, expr.span);
      }
      for (const a of expr.args) this.checkExpr(a, scope);
      return Type.VOID;
    }
    if (expr.args.length !== sig.params.length) {
      this.error(
        `function '${expr.callee}' expects ${sig.params.length} argument(s), ` +
          `got ${expr.args.length}`,
        expr.span,
      );
    }
    for (let i = 0; i < expr.args.length; i++) {
      const at = this.checkExpr(expr.args[i], scope);
      const pt = sig.params[i];
      if (pt !== undefined && at !== Type.VOID && at !== pt) {
        this.error(
          `argument ${i + 1} of '${expr.callee}' expects '${pt}', found '${at}'`,
          expr.args[i].span,
        );
      }
    }
    return sig.ret;
  }

  // ---- definite-return analysis ------------------------------------------
  // Returns true if the statement/block is guaranteed to return (or diverge)
  // on every path. Used to reject functions that fall off the end.

  blockReturns(block) {
    for (const stmt of block.stmts) {
      if (this.stmtReturns(stmt)) return true;
    }
    return false;
  }

  stmtReturns(stmt) {
    switch (stmt.kind) {
      case N.ReturnStmt:
        return true;
      case N.Block:
        return this.blockReturns(stmt);
      case N.IfStmt:
        // An if returns only if it has an else and both branches return.
        if (!stmt.otherwise) return false;
        return (
          this.blockReturns(stmt.then) &&
          (stmt.otherwise.kind === N.IfStmt
            ? this.stmtReturns(stmt.otherwise)
            : this.blockReturns(stmt.otherwise))
        );
      default:
        return false;
    }
  }
}

/**
 * Type-check a program. Returns { functions, globals, errors }. Callers decide
 * whether to proceed to code generation based on `errors.length`.
 */
export function check(program) {
  return new Checker(program).check();
}
