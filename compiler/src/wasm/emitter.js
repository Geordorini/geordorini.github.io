// emitter.js — lowers a type-checked Lumen program to a WebAssembly binary.
//
// The emitter is the back end. It walks the AST (already annotated with types
// by the checker) and produces a valid `.wasm` module as a Uint8Array:
//
//   * function index space = imports (extern) first, then defined functions
//   * one deduplicated entry per distinct function signature in the type section
//   * locals are flat per function; nested `let`s get fresh slots (shadowing
//     allocates a new slot rather than reusing one)
//   * control flow is structured: `if`/`else`, and `while` as `block { loop }`
//     with break/continue lowered to `br`/`br_if` at the right relative depth
//
// The lowering choices (which opcode for which operand type) live in
// `lowering.js` so the text emitter can reuse them.

import { ByteBuffer } from './leb128.js';
import {
  SECTION, VAL, FUNC_TYPE, EMPTY_BLOCK, EXPORT_FUNC, MUT_CONST, MUT_VAR, OP,
} from './opcodes.js';
import { Type, WASM_VALTYPE } from '../types.js';
import { N } from '../ast.js';
import { binaryOpcode, unaryIsFloatNeg } from './lowering.js';

const WASM_MAGIC = [0x00, 0x61, 0x73, 0x6d];
const WASM_VERSION = [0x01, 0x00, 0x00, 0x00];
const IMPORT_MODULE = 'env';

export class Emitter {
  constructor(program, checkResult) {
    this.program = program;
    this.functions = checkResult.functions; // name -> signature
    this.globals = checkResult.globals;      // name -> { type, mut }

    this.funcIndex = new Map(); // name -> wasm function index
    this.typeList = [];         // list of { params:[valtype], results:[valtype] }
    this.typeIndexOf = new Map(); // signature key -> index in typeList
    this.funcType = new Map();   // name -> type index

    this.globalIndex = new Map(); // name -> global index
    this.globalInfo = [];         // ordered { name, valtype, mut, initExpr, type }
  }

  // ---- public entry ------------------------------------------------------

  emit() {
    this.assignIndices();
    const out = new ByteBuffer();
    out.bytesFrom(WASM_MAGIC).bytesFrom(WASM_VERSION);
    this.emitTypeSection(out);
    this.emitImportSection(out);
    this.emitFunctionSection(out);
    this.emitGlobalSection(out);
    this.emitExportSection(out);
    this.emitCodeSection(out);
    return out.toUint8Array();
  }

  // ---- index assignment & type interning ---------------------------------

  assignIndices() {
    let index = 0;
    // imports first
    for (const decl of this.program.decls) {
      if (decl.kind === N.ExternDecl) {
        this.funcIndex.set(decl.name, index++);
        this.internType(decl.name);
      }
    }
    // then defined functions
    for (const decl of this.program.decls) {
      if (decl.kind === N.FuncDecl) {
        this.funcIndex.set(decl.name, index++);
        this.internType(decl.name);
      }
    }
    // globals
    let gi = 0;
    for (const decl of this.program.decls) {
      if (decl.kind === N.GlobalDecl) {
        const info = this.globals.get(decl.name);
        this.globalIndex.set(decl.name, gi++);
        this.globalInfo.push({
          name: decl.name,
          valtype: WASM_VALTYPE[info.type],
          mut: decl.mut,
          initExpr: decl.init,
          type: info.type,
        });
      }
    }
  }

  internType(fnName) {
    const sig = this.functions.get(fnName);
    const params = sig.params.map((t) => WASM_VALTYPE[t]);
    const results = sig.ret === Type.VOID ? [] : [WASM_VALTYPE[sig.ret]];
    const key = JSON.stringify([params, results]);
    let idx = this.typeIndexOf.get(key);
    if (idx === undefined) {
      idx = this.typeList.length;
      this.typeList.push({ params, results });
      this.typeIndexOf.set(key, idx);
    }
    this.funcType.set(fnName, idx);
  }

  // ---- sections ----------------------------------------------------------

  section(out, id, buildContents) {
    const body = new ByteBuffer();
    buildContents(body);
    out.byte(id);
    out.u32(body.length);
    out.append(body);
  }

  emitTypeSection(out) {
    if (this.typeList.length === 0) return;
    this.section(out, SECTION.TYPE, (b) => {
      b.vec(this.typeList, (bb, ty) => {
        bb.byte(FUNC_TYPE);
        bb.vec(ty.params, (v, p) => v.byte(p));
        bb.vec(ty.results, (v, r) => v.byte(r));
      });
    });
  }

  emitImportSection(out) {
    const imports = this.program.decls.filter((d) => d.kind === N.ExternDecl);
    if (imports.length === 0) return;
    this.section(out, SECTION.IMPORT, (b) => {
      b.vec(imports, (bb, decl) => {
        bb.name(IMPORT_MODULE);
        bb.name(decl.name);
        bb.byte(0x00); // import kind: function
        bb.u32(this.funcType.get(decl.name));
      });
    });
  }

  emitFunctionSection(out) {
    const defined = this.program.decls.filter((d) => d.kind === N.FuncDecl);
    if (defined.length === 0) return;
    this.section(out, SECTION.FUNCTION, (b) => {
      b.vec(defined, (bb, decl) => bb.u32(this.funcType.get(decl.name)));
    });
  }

  emitGlobalSection(out) {
    if (this.globalInfo.length === 0) return;
    this.section(out, SECTION.GLOBAL, (b) => {
      b.vec(this.globalInfo, (bb, g) => {
        bb.byte(g.valtype);
        bb.byte(g.mut ? MUT_VAR : MUT_CONST);
        this.emitConstInit(bb, g);
      });
    });
  }

  emitConstInit(bb, g) {
    const value = evalConst(g.initExpr);
    if (g.type === Type.FLOAT) {
      bb.byte(OP.F64_CONST).f64(value);
    } else {
      bb.byte(OP.I32_CONST).i32(g.type === Type.BOOL ? (value ? 1 : 0) : value);
    }
    bb.byte(OP.END);
  }

  emitExportSection(out) {
    const exports = this.program.decls.filter(
      (d) => d.kind === N.FuncDecl && d.exported,
    );
    if (exports.length === 0) return;
    this.section(out, SECTION.EXPORT, (b) => {
      b.vec(exports, (bb, decl) => {
        bb.name(decl.name);
        bb.byte(EXPORT_FUNC);
        bb.u32(this.funcIndex.get(decl.name));
      });
    });
  }

  emitCodeSection(out) {
    const defined = this.program.decls.filter((d) => d.kind === N.FuncDecl);
    if (defined.length === 0) return;
    this.section(out, SECTION.CODE, (b) => {
      b.vec(defined, (bb, decl) => {
        const code = this.emitFunctionBody(decl);
        bb.u32(code.length);
        bb.append(code);
      });
    });
  }

  // ---- function body -----------------------------------------------------

  emitFunctionBody(fn) {
    // per-function emit state
    this.buf = new ByteBuffer();     // instruction stream (no locals, no end)
    this.locals = [];                // valtypes for non-param locals, in order
    this.scopes = [];                // stack of Map(name -> {index, type})
    this.ctrl = [];                  // control-frame stack for br depth
    this.loopStack = [];             // { breakFrame, continueFrame }
    this.sig = this.functions.get(fn.name);
    this.paramCount = fn.params.length;

    const top = new Map();
    fn.params.forEach((p, i) => top.set(p.name, { index: i, type: p.type.name }));
    this.scopes.push(top);

    for (const stmt of fn.body.stmts) this.emitStmt(stmt);
    this.scopes.pop();

    // Value-returning functions get a trailing `unreachable` so the binary
    // validates even when every real path already returned (the checker has
    // guaranteed that). Void functions just end.
    if (this.sig.ret !== Type.VOID) this.buf.byte(OP.UNREACHABLE);

    // assemble: locals vector + body + END
    const body = new ByteBuffer();
    this.emitLocalsVec(body);
    body.append(this.buf);
    body.byte(OP.END);
    return body;
  }

  emitLocalsVec(body) {
    // Compress runs of identical valtypes into (count, type) pairs.
    const groups = [];
    for (const vt of this.locals) {
      const last = groups[groups.length - 1];
      if (last && last.vt === vt) last.count++;
      else groups.push({ vt, count: 1 });
    }
    body.vec(groups, (b, g) => b.u32(g.count).byte(g.vt));
  }

  // ---- scope / locals helpers -------------------------------------------

  pushScope() {
    this.scopes.push(new Map());
  }

  popScope() {
    this.scopes.pop();
  }

  allocLocal(name, luType) {
    const index = this.paramCount + this.locals.length;
    this.locals.push(WASM_VALTYPE[luType]);
    this.scopes[this.scopes.length - 1].set(name, { index, type: luType });
    return index;
  }

  resolveLocal(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    return null;
  }

  // ---- control-frame helpers ---------------------------------------------

  pushFrame(tag) {
    const frame = { tag };
    this.ctrl.push(frame);
    return frame;
  }

  popFrame() {
    this.ctrl.pop();
  }

  relDepth(frame) {
    return this.ctrl.length - 1 - this.ctrl.indexOf(frame);
  }

  // ---- statements --------------------------------------------------------

  emitStmt(stmt) {
    switch (stmt.kind) {
      case N.LetStmt: return this.emitLet(stmt);
      case N.AssignStmt: return this.emitAssign(stmt);
      case N.IfStmt: return this.emitIf(stmt);
      case N.WhileStmt: return this.emitWhile(stmt);
      case N.ReturnStmt: return this.emitReturn(stmt);
      case N.BreakStmt: {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.buf.byte(OP.BR).u32(this.relDepth(loop.breakFrame));
        return;
      }
      case N.ContinueStmt: {
        const loop = this.loopStack[this.loopStack.length - 1];
        this.buf.byte(OP.BR).u32(this.relDepth(loop.continueFrame));
        return;
      }
      case N.Block: {
        this.pushScope();
        for (const s of stmt.stmts) this.emitStmt(s);
        this.popScope();
        return;
      }
      case N.ExprStmt: {
        this.emitExpr(stmt.expr);
        if (stmt.expr.type !== Type.VOID) this.buf.byte(OP.DROP);
        return;
      }
      default:
        throw new Error(`emitter: unhandled statement ${stmt.kind}`);
    }
  }

  emitLet(stmt) {
    this.emitExpr(stmt.init);
    const index = this.allocLocal(stmt.name, stmt.resolvedType);
    this.buf.byte(OP.LOCAL_SET).u32(index);
  }

  emitAssign(stmt) {
    this.emitExpr(stmt.value);
    if (stmt.isGlobal) {
      this.buf.byte(OP.GLOBAL_SET).u32(this.globalIndex.get(stmt.name));
    } else {
      const local = this.resolveLocal(stmt.name);
      this.buf.byte(OP.LOCAL_SET).u32(local.index);
    }
  }

  emitIf(stmt) {
    this.emitExpr(stmt.cond);
    this.buf.byte(OP.IF).byte(EMPTY_BLOCK);
    this.pushFrame('if');
    this.pushScope();
    for (const s of stmt.then.stmts) this.emitStmt(s);
    this.popScope();
    if (stmt.otherwise) {
      this.buf.byte(OP.ELSE);
      if (stmt.otherwise.kind === N.IfStmt) {
        this.emitIf(stmt.otherwise);
      } else {
        this.pushScope();
        for (const s of stmt.otherwise.stmts) this.emitStmt(s);
        this.popScope();
      }
    }
    this.popFrame();
    this.buf.byte(OP.END);
  }

  emitWhile(stmt) {
    // block { loop { if (!cond) br block; body; br loop } }
    this.buf.byte(OP.BLOCK).byte(EMPTY_BLOCK);
    const breakFrame = this.pushFrame('block');
    this.buf.byte(OP.LOOP).byte(EMPTY_BLOCK);
    const continueFrame = this.pushFrame('loop');
    this.loopStack.push({ breakFrame, continueFrame });

    this.emitExpr(stmt.cond);
    this.buf.byte(OP.I32_EQZ);
    this.buf.byte(OP.BR_IF).u32(this.relDepth(breakFrame));

    this.pushScope();
    for (const s of stmt.body.stmts) this.emitStmt(s);
    this.popScope();

    this.buf.byte(OP.BR).u32(this.relDepth(continueFrame));

    this.loopStack.pop();
    this.popFrame(); // loop
    this.buf.byte(OP.END);
    this.popFrame(); // block
    this.buf.byte(OP.END);
  }

  emitReturn(stmt) {
    if (stmt.value) this.emitExpr(stmt.value);
    this.buf.byte(OP.RETURN);
  }

  // ---- expressions -------------------------------------------------------

  emitExpr(expr) {
    switch (expr.kind) {
      case N.IntLit:
        this.buf.byte(OP.I32_CONST).i32(expr.value);
        return;
      case N.BoolLit:
        this.buf.byte(OP.I32_CONST).i32(expr.value ? 1 : 0);
        return;
      case N.FloatLit:
        this.buf.byte(OP.F64_CONST).f64(expr.value);
        return;
      case N.Ident:
        if (expr.isGlobal) {
          this.buf.byte(OP.GLOBAL_GET).u32(this.globalIndex.get(expr.name));
        } else {
          this.buf.byte(OP.LOCAL_GET).u32(this.resolveLocal(expr.name).index);
        }
        return;
      case N.Unary:
        return this.emitUnary(expr);
      case N.Binary:
        return this.emitBinary(expr);
      case N.Call:
        return this.emitCall(expr);
      default:
        throw new Error(`emitter: unhandled expression ${expr.kind}`);
    }
  }

  emitUnary(expr) {
    if (expr.op === '-') {
      if (unaryIsFloatNeg(expr.operand.type)) {
        this.emitExpr(expr.operand);
        this.buf.byte(OP.F64_NEG);
      } else {
        // i32 has no neg: compute 0 - x
        this.buf.byte(OP.I32_CONST).i32(0);
        this.emitExpr(expr.operand);
        this.buf.byte(OP.I32_SUB);
      }
      return;
    }
    // '!' : logical not on bool (i32) -> eqz
    this.emitExpr(expr.operand);
    this.buf.byte(OP.I32_EQZ);
  }

  emitBinary(expr) {
    if (expr.op === '&&' || expr.op === '||') return this.emitLogical(expr);
    this.emitExpr(expr.left);
    this.emitExpr(expr.right);
    const opcode = binaryOpcode(expr.op, expr.left.type);
    this.buf.byte(opcode);
  }

  emitLogical(expr) {
    // Short-circuit via structured if producing an i32 result.
    this.emitExpr(expr.left);
    this.buf.byte(OP.IF).byte(VAL.I32);
    this.pushFrame('if');
    if (expr.op === '&&') {
      this.emitExpr(expr.right);
      this.buf.byte(OP.ELSE);
      this.buf.byte(OP.I32_CONST).i32(0);
    } else {
      this.buf.byte(OP.I32_CONST).i32(1);
      this.buf.byte(OP.ELSE);
      this.emitExpr(expr.right);
    }
    this.popFrame();
    this.buf.byte(OP.END);
  }

  emitCall(expr) {
    for (const arg of expr.args) this.emitExpr(arg);
    this.buf.byte(OP.CALL).u32(this.funcIndex.get(expr.callee));
  }
}

/** Fold a constant expression (used for global initializers) to a JS number. */
export function evalConst(expr) {
  switch (expr.kind) {
    case N.IntLit: return expr.value;
    case N.FloatLit: return expr.value;
    case N.BoolLit: return expr.value ? 1 : 0;
    case N.Unary:
      if (expr.op === '-') return -evalConst(expr.operand);
      return evalConst(expr.operand);
    default:
      throw new Error('evalConst: non-constant global initializer');
  }
}

/** Emit a checked program to wasm bytes. */
export function emit(program, checkResult) {
  return new Emitter(program, checkResult).emit();
}
