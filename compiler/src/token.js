// token.js — token kinds produced by the lexer.

/** Enumeration of every token kind the lexer can emit. */
export const T = Object.freeze({
  // literals & identifiers
  INT: 'INT',
  FLOAT: 'FLOAT',
  IDENT: 'IDENT',

  // keywords
  FN: 'fn',
  LET: 'let',
  MUT: 'mut',
  IF: 'if',
  ELSE: 'else',
  WHILE: 'while',
  RETURN: 'return',
  BREAK: 'break',
  CONTINUE: 'continue',
  EXPORT: 'export',
  EXTERN: 'extern',
  TRUE: 'true',
  FALSE: 'false',
  // type keywords are lexed as IDENT and recognized in the parser,
  // except these reserved primitives:
  TY_INT: 'int',
  TY_FLOAT: 'float',
  TY_BOOL: 'bool',
  TY_VOID: 'void',

  // punctuation / operators
  LPAREN: '(',
  RPAREN: ')',
  LBRACE: '{',
  RBRACE: '}',
  COMMA: ',',
  SEMI: ';',
  COLON: ':',
  ASSIGN: '=',
  PLUS: '+',
  MINUS: '-',
  STAR: '*',
  SLASH: '/',
  PERCENT: '%',
  BANG: '!',
  LT: '<',
  GT: '>',
  LE: '<=',
  GE: '>=',
  EQ: '==',
  NE: '!=',
  AND: '&&',
  OR: '||',

  EOF: 'EOF',
});

/** Reserved words mapped to their token kind. */
export const KEYWORDS = Object.freeze({
  fn: T.FN,
  let: T.LET,
  mut: T.MUT,
  if: T.IF,
  else: T.ELSE,
  while: T.WHILE,
  return: T.RETURN,
  break: T.BREAK,
  continue: T.CONTINUE,
  export: T.EXPORT,
  extern: T.EXTERN,
  true: T.TRUE,
  false: T.FALSE,
  int: T.TY_INT,
  float: T.TY_FLOAT,
  bool: T.TY_BOOL,
  void: T.TY_VOID,
});

/** A lexical token: a kind, its raw text, an optional value, and a span. */
export class Token {
  constructor(kind, text, span, value = null) {
    this.kind = kind;
    this.text = text;
    this.span = span;
    this.value = value; // numeric value for INT/FLOAT literals
  }
}
