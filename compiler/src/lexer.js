// lexer.js — turns Lumen source text into a flat stream of tokens.
//
// The lexer is a hand-written character scanner. It tracks line/column so that
// every token carries an accurate Span, handles `//` and `/* */` comments,
// and recognizes integer and floating-point literals (including scientific
// notation like `1.5e-3`).

import { Span, CompileError } from './diagnostics.js';
import { T, KEYWORDS, Token } from './token.js';

const isDigit = (c) => c >= '0' && c <= '9';
const isIdentStart = (c) =>
  (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
const isIdentPart = (c) => isIdentStart(c) || isDigit(c);

export class Lexer {
  constructor(source) {
    this.src = source;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.tokens = [];
  }

  /** Scan the entire source and return the token list (ending in EOF). */
  tokenize() {
    while (!this.atEnd()) {
      this.skipTrivia();
      if (this.atEnd()) break;
      this.scanToken();
    }
    this.tokens.push(new Token(T.EOF, '', this.span(this.pos, this.pos)));
    return this.tokens;
  }

  // ---- low-level cursor helpers ------------------------------------------

  atEnd() {
    return this.pos >= this.src.length;
  }

  peek(offset = 0) {
    return this.src[this.pos + offset];
  }

  advance() {
    const c = this.src[this.pos++];
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  match(expected) {
    if (this.peek() === expected) {
      this.advance();
      return true;
    }
    return false;
  }

  span(start, end) {
    return new Span(start, end, this.startLine, this.startCol);
  }

  // ---- trivia (whitespace + comments) ------------------------------------

  skipTrivia() {
    for (;;) {
      const c = this.peek();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.advance();
      } else if (c === '/' && this.peek(1) === '/') {
        while (!this.atEnd() && this.peek() !== '\n') this.advance();
      } else if (c === '/' && this.peek(1) === '*') {
        const openStart = this.pos;
        this.advance();
        this.advance();
        let depth = 1;
        while (!this.atEnd() && depth > 0) {
          if (this.peek() === '/' && this.peek(1) === '*') {
            this.advance();
            this.advance();
            depth++;
          } else if (this.peek() === '*' && this.peek(1) === '/') {
            this.advance();
            this.advance();
            depth--;
          } else {
            this.advance();
          }
        }
        if (depth > 0) {
          throw new CompileError(
            'unterminated block comment',
            new Span(openStart, this.pos, this.line, this.col),
            'lex',
          );
        }
      } else {
        break;
      }
    }
  }

  // ---- token scanning ----------------------------------------------------

  scanToken() {
    this.startLine = this.line;
    this.startCol = this.col;
    const start = this.pos;
    const c = this.advance();

    // single- and double-character operators
    switch (c) {
      case '(': return this.emit(T.LPAREN, start);
      case ')': return this.emit(T.RPAREN, start);
      case '{': return this.emit(T.LBRACE, start);
      case '}': return this.emit(T.RBRACE, start);
      case ',': return this.emit(T.COMMA, start);
      case ';': return this.emit(T.SEMI, start);
      case ':': return this.emit(T.COLON, start);
      case '+': return this.emit(T.PLUS, start);
      case '-': return this.emit(T.MINUS, start);
      case '*': return this.emit(T.STAR, start);
      case '/': return this.emit(T.SLASH, start);
      case '%': return this.emit(T.PERCENT, start);
      case '=': return this.emit(this.match('=') ? T.EQ : T.ASSIGN, start);
      case '!': return this.emit(this.match('=') ? T.NE : T.BANG, start);
      case '<': return this.emit(this.match('=') ? T.LE : T.LT, start);
      case '>': return this.emit(this.match('=') ? T.GE : T.GT, start);
      case '&':
        if (this.match('&')) return this.emit(T.AND, start);
        break;
      case '|':
        if (this.match('|')) return this.emit(T.OR, start);
        break;
    }

    if (isDigit(c)) return this.scanNumber(start);
    if (isIdentStart(c)) return this.scanIdent(start);

    throw new CompileError(
      `unexpected character '${c}'`,
      this.span(start, this.pos),
      'lex',
    );
  }

  emit(kind, start) {
    const text = this.src.slice(start, this.pos);
    this.tokens.push(new Token(kind, text, this.span(start, this.pos)));
  }

  scanNumber(start) {
    while (isDigit(this.peek())) this.advance();
    let isFloat = false;

    // fractional part
    if (this.peek() === '.' && isDigit(this.peek(1))) {
      isFloat = true;
      this.advance(); // consume '.'
      while (isDigit(this.peek())) this.advance();
    }

    // exponent part
    if (this.peek() === 'e' || this.peek() === 'E') {
      const save = this.pos;
      this.advance();
      if (this.peek() === '+' || this.peek() === '-') this.advance();
      if (isDigit(this.peek())) {
        isFloat = true;
        while (isDigit(this.peek())) this.advance();
      } else {
        // not actually an exponent (e.g. `1e` before an identifier); rewind
        this.pos = save;
      }
    }

    const text = this.src.slice(start, this.pos);
    const span = this.span(start, this.pos);
    if (isFloat) {
      this.tokens.push(new Token(T.FLOAT, text, span, parseFloat(text)));
    } else {
      const value = parseInt(text, 10);
      // i32 range check happens in the checker; store as Number here.
      this.tokens.push(new Token(T.INT, text, span, value));
    }
  }

  scanIdent(start) {
    while (isIdentPart(this.peek())) this.advance();
    const text = this.src.slice(start, this.pos);
    const kind = KEYWORDS[text] ?? T.IDENT;
    const span = this.span(start, this.pos);
    if (kind === T.TRUE || kind === T.FALSE) {
      this.tokens.push(new Token(kind, text, span, kind === T.TRUE));
    } else {
      this.tokens.push(new Token(kind, text, span));
    }
  }
}

/** Convenience wrapper: source string → token array. */
export function tokenize(source) {
  return new Lexer(source).tokenize();
}
