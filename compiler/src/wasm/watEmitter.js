// watEmitter.js — a second back end that produces the WebAssembly *text* format
// (WAT) from the same checked AST. This is display-only (the binary emitter is
// the source of truth for execution), but it shares all lowering decisions via
// lowering.js so the text always matches the bytes. Locals are shown by numeric
// index, exactly as the binary emitter allocates them.

import { Type } from '../types.js';
import { N } from '../ast.js';
import { binaryMnemonic, unaryIsFloatNeg } from './lowering.js';
import { evalConst } from './emitter.js';

const VT = { [Type.INT]: 'i32', [Type.FLOAT]: 'f64', [Type.BOOL]: 'i32' };

class WatEmitter {
  constructor(program, checkResult) {
    this.program = program;
    this.functions = checkResult.functions;
    this.globals = checkResult.globals;
    this.out = [];
    this.indent = 0;
  }

  line(text) {
    this.out.push('  '.repeat(this.indent) + text);
  }

  emit() {
    this.line('(module');
    this.indent++;
    this.emitImports();
    this.emitGlobals();
    for (const decl of this.program.decls) {
      if (decl.kind === N.FuncDecl) this.emitFunc(decl);
    }
    this.emitExports();
    this.indent--;
    this.line(')');
    return this.out.join('\n') + '\n';
  }

  emitImports() {
    for (const decl of this.program.decls) {
      if (decl.kind !== N.ExternDecl) continue;
      const params = decl.params.map((p) => `(param ${VT[p.type.name]})`).join(' ');
      const result =
        decl.retType.name === Type.VOID ? '' : ` (result ${VT[decl.retType.name]})`;
      const parts = ['(func', `$${decl.name}`, params, result.trim()].filter(Boolean);
      this.line(`(import "env" "${decl.name}" ${parts.join(' ')}))`);
    }
  }

  emitGlobals() {
    for (const decl of this.program.decls) {
      if (decl.kind !== N.GlobalDecl) continue;
      const info = this.globals.get(decl.name);
      const vt = VT[info.type];
      const typeSpec = decl.mut ? `(mut ${vt})` : vt;
      const value = evalConst(decl.init);
      const init =
        info.type === Type.FLOAT
          ? `(f64.const ${value})`
          : `(i32.const ${info.type === Type.BOOL ? (value ? 1 : 0) : value})`;
      this.line(`(global $${decl.name} ${typeSpec} ${init})`);
    }
  }

  emitExports() {
    for (const decl of this.program.decls) {
      if (decl.kind === N.FuncDecl && decl.exported) {
        this.line(`(export "${decl.name}" (func $${decl.name}))`);
      }
    }
  }

  emitFunc(fn) {
    this.sig = this.functions.get(fn.name);
    this.locals = [];
    this.scopes = [new Map()];
    this.paramCount = fn.params.length;
    this.labelCounter = 0;
    this.loopStack = [];

    const params = fn.params
      .map((p, i) => {
        this.scopes[0].set(p.name, { index: i, type: p.type.name });
        return `(param ${VT[p.type.name]})`;
      })
      .join(' ');
    const result =
      this.sig.ret === Type.VOID ? '' : ` (result ${VT[this.sig.ret]})`;

    this.line(`(func $${fn.name} ${params}${result}`.replace(/\s+/g, ' ').trimEnd());
    this.indent++;

    // Body instructions are emitted into a buffer first so we can prepend the
    // (local ...) declarations once their count/types are known.
    const savedOut = this.out;
    const savedIndent = this.indent;
    this.out = [];
    this.indent = savedIndent;
    for (const s of fn.body.stmts) this.emitStmt(s);
    if (this.sig.ret !== Type.VOID) this.line('unreachable');
    const bodyLines = this.out;
    this.out = savedOut;
    this.indent = savedIndent;

    for (const vt of this.locals) this.line(`(local ${vt})`);
    this.out.push(...bodyLines);

    this.indent--;
    this.line(')');
  }

  // ---- locals ------------------------------------------------------------

  allocLocal(name, luType) {
    const index = this.paramCount + this.locals.length;
    this.locals.push(VT[luType]);
    this.scopes[this.scopes.length - 1].set(name, { index, type: luType });
    return index;
  }

  resolveLocal(name) {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      if (this.scopes[i].has(name)) return this.scopes[i].get(name);
    }
    return null;
  }

  // ---- statements --------------------------------------------------------

  emitStmt(stmt) {
    switch (stmt.kind) {
      case N.LetStmt: {
        this.emitExpr(stmt.init);
        const index = this.allocLocal(stmt.name, stmt.resolvedType);
        this.line(`local.set ${index}`);
        return;
      }
      case N.AssignStmt: {
        this.emitExpr(stmt.value);
        if (stmt.isGlobal) this.line(`global.set $${stmt.name}`);
        else this.line(`local.set ${this.resolveLocal(stmt.name).index}`);
        return;
      }
      case N.IfStmt: return this.emitIf(stmt);
      case N.WhileStmt: return this.emitWhile(stmt);
      case N.ReturnStmt:
        if (stmt.value) this.emitExpr(stmt.value);
        this.line('return');
        return;
      case N.BreakStmt:
        this.line(`br $${this.loopStack[this.loopStack.length - 1].brk}`);
        return;
      case N.ContinueStmt:
        this.line(`br $${this.loopStack[this.loopStack.length - 1].cont}`);
        return;
      case N.Block: {
        this.scopes.push(new Map());
        for (const s of stmt.stmts) this.emitStmt(s);
        this.scopes.pop();
        return;
      }
      case N.ExprStmt:
        this.emitExpr(stmt.expr);
        if (stmt.expr.type !== Type.VOID) this.line('drop');
        return;
      default:
        throw new Error(`wat: unhandled statement ${stmt.kind}`);
    }
  }

  emitIf(stmt) {
    this.emitExpr(stmt.cond);
    this.line('if');
    this.indent++;
    this.scopes.push(new Map());
    for (const s of stmt.then.stmts) this.emitStmt(s);
    this.scopes.pop();
    this.indent--;
    if (stmt.otherwise) {
      this.line('else');
      this.indent++;
      if (stmt.otherwise.kind === N.IfStmt) {
        this.emitIf(stmt.otherwise);
      } else {
        this.scopes.push(new Map());
        for (const s of stmt.otherwise.stmts) this.emitStmt(s);
        this.scopes.pop();
      }
      this.indent--;
    }
    this.line('end');
  }

  emitWhile(stmt) {
    const brk = `b${this.labelCounter}`;
    const cont = `l${this.labelCounter}`;
    this.labelCounter++;
    this.line(`block $${brk}`);
    this.indent++;
    this.line(`loop $${cont}`);
    this.indent++;
    this.loopStack.push({ brk, cont });

    this.emitExpr(stmt.cond);
    this.line('i32.eqz');
    this.line(`br_if $${brk}`);
    this.scopes.push(new Map());
    for (const s of stmt.body.stmts) this.emitStmt(s);
    this.scopes.pop();
    this.line(`br $${cont}`);

    this.loopStack.pop();
    this.indent--;
    this.line('end');
    this.indent--;
    this.line('end');
  }

  // ---- expressions -------------------------------------------------------

  emitExpr(expr) {
    switch (expr.kind) {
      case N.IntLit: this.line(`i32.const ${expr.value}`); return;
      case N.BoolLit: this.line(`i32.const ${expr.value ? 1 : 0}`); return;
      case N.FloatLit: this.line(`f64.const ${expr.value}`); return;
      case N.Ident:
        if (expr.isGlobal) this.line(`global.get $${expr.name}`);
        else this.line(`local.get ${this.resolveLocal(expr.name).index}`);
        return;
      case N.Unary: return this.emitUnary(expr);
      case N.Binary: return this.emitBinary(expr);
      case N.Call:
        for (const a of expr.args) this.emitExpr(a);
        this.line(`call $${expr.callee}`);
        return;
      default:
        throw new Error(`wat: unhandled expression ${expr.kind}`);
    }
  }

  emitUnary(expr) {
    if (expr.op === '-') {
      if (unaryIsFloatNeg(expr.operand.type)) {
        this.emitExpr(expr.operand);
        this.line('f64.neg');
      } else {
        this.line('i32.const 0');
        this.emitExpr(expr.operand);
        this.line('i32.sub');
      }
      return;
    }
    this.emitExpr(expr.operand);
    this.line('i32.eqz');
  }

  emitBinary(expr) {
    if (expr.op === '&&' || expr.op === '||') {
      this.emitExpr(expr.left);
      this.line('if (result i32)');
      this.indent++;
      if (expr.op === '&&') {
        this.emitExpr(expr.right);
        this.indent--;
        this.line('else');
        this.indent++;
        this.line('i32.const 0');
      } else {
        this.line('i32.const 1');
        this.indent--;
        this.line('else');
        this.indent++;
        this.emitExpr(expr.right);
      }
      this.indent--;
      this.line('end');
      return;
    }
    this.emitExpr(expr.left);
    this.emitExpr(expr.right);
    this.line(binaryMnemonic(expr.op, expr.left.type));
  }
}

export function emitWat(program, checkResult) {
  return new WatEmitter(program, checkResult).emit();
}
