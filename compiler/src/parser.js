// parser.js — recursive-descent parser with Pratt expression parsing.
//
// Top level is a sequence of declarations (functions, externs, globals).
// Statements are parsed recursively; expressions use a precedence-climbing
// (Pratt) scheme driven by the BINARY_PRECEDENCE table. The parser produces
// the AST defined in ast.js and raises CompileError with precise spans.

import { CompileError } from './diagnostics.js';
import { T } from './token.js';
import * as ast from './ast.js';

// Binary operator precedence (higher binds tighter). Used by parseBinary.
const BINARY_PRECEDENCE = {
  [T.OR]: 1,
  [T.AND]: 2,
  [T.EQ]: 3, [T.NE]: 3,
  [T.LT]: 4, [T.LE]: 4, [T.GT]: 4, [T.GE]: 4,
  [T.PLUS]: 5, [T.MINUS]: 5,
  [T.STAR]: 6, [T.SLASH]: 6, [T.PERCENT]: 6,
};

const TYPE_TOKENS = new Set([T.TY_INT, T.TY_FLOAT, T.TY_BOOL, T.TY_VOID]);

export class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.i = 0;
  }

  // ---- token cursor ------------------------------------------------------

  peek(offset = 0) {
    return this.tokens[Math.min(this.i + offset, this.tokens.length - 1)];
  }

  at(kind) {
    return this.peek().kind === kind;
  }

  advance() {
    return this.tokens[this.i++];
  }

  check(kind) {
    if (this.at(kind)) return this.advance();
    return null;
  }

  expect(kind, what) {
    if (this.at(kind)) return this.advance();
    const tok = this.peek();
    const got = tok.kind === T.EOF ? 'end of input' : `'${tok.text}'`;
    throw new CompileError(
      `expected ${what || `'${kind}'`}, found ${got}`,
      tok.span,
      'parse',
    );
  }

  // ---- top level ---------------------------------------------------------

  parseProgram() {
    const decls = [];
    while (!this.at(T.EOF)) {
      decls.push(this.parseTopLevel());
    }
    return ast.Program(decls);
  }

  parseTopLevel() {
    if (this.at(T.EXTERN)) return this.parseExtern();
    if (this.at(T.EXPORT) || this.at(T.FN)) return this.parseFunc();
    if (this.at(T.LET)) return this.parseGlobal();
    const tok = this.peek();
    throw new CompileError(
      `expected a top-level declaration (fn, export fn, extern fn, or let), ` +
        `found '${tok.text || 'end of input'}'`,
      tok.span,
      'parse',
    );
  }

  parseExtern() {
    const start = this.expect(T.EXTERN).span;
    this.expect(T.FN, "'fn' after 'extern'");
    const name = this.expect(T.IDENT, 'function name');
    const params = this.parseParamList();
    const retType = this.parseOptionalReturnType();
    const end = this.expect(T.SEMI, "';' after extern declaration").span;
    return ast.ExternDecl(name.text, params, retType, start.to(end));
  }

  parseFunc() {
    const exportTok = this.check(T.EXPORT);
    const fnTok = this.expect(T.FN, "'fn'");
    const start = (exportTok || fnTok).span;
    const name = this.expect(T.IDENT, 'function name');
    const params = this.parseParamList();
    const retType = this.parseOptionalReturnType();
    const body = this.parseBlock();
    return ast.FuncDecl(
      name.text, params, retType, body, Boolean(exportTok), start.to(body.span),
    );
  }

  parseGlobal() {
    const start = this.expect(T.LET).span;
    const mut = Boolean(this.check(T.MUT));
    const name = this.expect(T.IDENT, 'global name');
    const declaredType = this.check(T.COLON) ? this.parseType() : null;
    this.expect(T.ASSIGN, "'=' in global initializer");
    const init = this.parseExpr();
    const end = this.expect(T.SEMI, "';' after global declaration").span;
    return ast.GlobalDecl(name.text, mut, declaredType, init, start.to(end));
  }

  parseParamList() {
    this.expect(T.LPAREN, "'(' before parameters");
    const params = [];
    if (!this.at(T.RPAREN)) {
      do {
        const name = this.expect(T.IDENT, 'parameter name');
        this.expect(T.COLON, "':' after parameter name");
        const type = this.parseType();
        params.push(ast.Param(name.text, type, name.span.to(type.span)));
      } while (this.check(T.COMMA));
    }
    this.expect(T.RPAREN, "')' after parameters");
    return params;
  }

  parseOptionalReturnType() {
    if (this.check(T.COLON)) return this.parseType();
    return { name: 'void', span: this.peek().span };
  }

  parseType() {
    const tok = this.peek();
    if (!TYPE_TOKENS.has(tok.kind)) {
      throw new CompileError(
        `expected a type (int, float, bool, or void), found '${tok.text}'`,
        tok.span,
        'parse',
      );
    }
    this.advance();
    return { name: tok.text, span: tok.span };
  }

  // ---- statements --------------------------------------------------------

  parseBlock() {
    const start = this.expect(T.LBRACE, "'{'").span;
    const stmts = [];
    while (!this.at(T.RBRACE) && !this.at(T.EOF)) {
      stmts.push(this.parseStmt());
    }
    const end = this.expect(T.RBRACE, "'}'").span;
    return ast.Block(stmts, start.to(end));
  }

  parseStmt() {
    switch (this.peek().kind) {
      case T.LET: return this.parseLet();
      case T.IF: return this.parseIf();
      case T.WHILE: return this.parseWhile();
      case T.RETURN: return this.parseReturn();
      case T.BREAK: {
        const t = this.advance();
        const end = this.expect(T.SEMI, "';' after 'break'").span;
        return ast.BreakStmt(t.span.to(end));
      }
      case T.CONTINUE: {
        const t = this.advance();
        const end = this.expect(T.SEMI, "';' after 'continue'").span;
        return ast.ContinueStmt(t.span.to(end));
      }
      case T.LBRACE: return this.parseBlock();
      default: return this.parseAssignOrExpr();
    }
  }

  parseLet() {
    const start = this.expect(T.LET).span;
    const mut = Boolean(this.check(T.MUT));
    const name = this.expect(T.IDENT, 'variable name');
    const declaredType = this.check(T.COLON) ? this.parseType() : null;
    this.expect(T.ASSIGN, "'=' in let binding");
    const init = this.parseExpr();
    const end = this.expect(T.SEMI, "';' after let binding").span;
    return ast.LetStmt(name.text, mut, declaredType, init, start.to(end));
  }

  parseIf() {
    const start = this.expect(T.IF).span;
    this.expect(T.LPAREN, "'(' after 'if'");
    const cond = this.parseExpr();
    this.expect(T.RPAREN, "')' after condition");
    const then = this.parseBlock();
    let otherwise = null;
    if (this.check(T.ELSE)) {
      // `else if` chains: the else branch is another if-statement.
      otherwise = this.at(T.IF) ? this.parseIf() : this.parseBlock();
    }
    const end = otherwise ? otherwise.span : then.span;
    return ast.IfStmt(cond, then, otherwise, start.to(end));
  }

  parseWhile() {
    const start = this.expect(T.WHILE).span;
    this.expect(T.LPAREN, "'(' after 'while'");
    const cond = this.parseExpr();
    this.expect(T.RPAREN, "')' after condition");
    const body = this.parseBlock();
    return ast.WhileStmt(cond, body, start.to(body.span));
  }

  parseReturn() {
    const start = this.expect(T.RETURN).span;
    let value = null;
    if (!this.at(T.SEMI)) value = this.parseExpr();
    const end = this.expect(T.SEMI, "';' after return").span;
    return ast.ReturnStmt(value, start.to(end));
  }

  parseAssignOrExpr() {
    const expr = this.parseExpr();
    if (this.at(T.ASSIGN)) {
      this.advance();
      if (expr.kind !== ast.N.Ident) {
        throw new CompileError(
          'left-hand side of assignment must be a variable',
          expr.span,
          'parse',
        );
      }
      const value = this.parseExpr();
      const end = this.expect(T.SEMI, "';' after assignment").span;
      return ast.AssignStmt(expr.name, value, expr.span.to(end));
    }
    const end = this.expect(T.SEMI, "';' after expression").span;
    return ast.ExprStmt(expr, expr.span.to(end));
  }

  // ---- expressions (Pratt) ----------------------------------------------

  parseExpr() {
    return this.parseBinary(0);
  }

  parseBinary(minPrec) {
    let left = this.parseUnary();
    for (;;) {
      const kind = this.peek().kind;
      const prec = BINARY_PRECEDENCE[kind];
      if (prec === undefined || prec < minPrec) break;
      const opTok = this.advance();
      // All our binary operators are left-associative, so parse the RHS with
      // a minimum precedence one higher than the current operator.
      const right = this.parseBinary(prec + 1);
      left = ast.Binary(opTok.kind, left, right, left.span.to(right.span));
    }
    return left;
  }

  parseUnary() {
    if (this.at(T.MINUS) || this.at(T.BANG)) {
      const opTok = this.advance();
      const operand = this.parseUnary();
      return ast.Unary(opTok.kind, operand, opTok.span.to(operand.span));
    }
    return this.parseCall();
  }

  parseCall() {
    let expr = this.parsePrimary();
    while (this.at(T.LPAREN)) {
      if (expr.kind !== ast.N.Ident) {
        throw new CompileError(
          'only named functions can be called',
          expr.span,
          'parse',
        );
      }
      this.advance(); // '('
      const args = [];
      if (!this.at(T.RPAREN)) {
        do {
          args.push(this.parseExpr());
        } while (this.check(T.COMMA));
      }
      const end = this.expect(T.RPAREN, "')' after arguments").span;
      expr = ast.Call(expr.name, args, expr.span.to(end));
    }
    return expr;
  }

  parsePrimary() {
    const tok = this.peek();
    switch (tok.kind) {
      case T.INT:
        this.advance();
        return ast.IntLit(tok.value, tok.span);
      case T.FLOAT:
        this.advance();
        return ast.FloatLit(tok.value, tok.span);
      case T.TRUE:
      case T.FALSE:
        this.advance();
        return ast.BoolLit(tok.value, tok.span);
      case T.IDENT:
        this.advance();
        return ast.Ident(tok.text, tok.span);
      case T.LPAREN: {
        this.advance();
        const inner = this.parseExpr();
        this.expect(T.RPAREN, "')' to close grouping");
        return inner;
      }
      default:
        throw new CompileError(
          `expected an expression, found '${tok.text || 'end of input'}'`,
          tok.span,
          'parse',
        );
    }
  }
}

/** Convenience wrapper: token array → Program AST. */
export function parse(tokens) {
  return new Parser(tokens).parseProgram();
}
