// ast.js — Abstract Syntax Tree node constructors.
//
// Nodes are plain objects tagged with a `kind` string and a `span`. The type
// checker later attaches a `.type` field to every expression node. Using small
// factory functions (rather than classes) keeps the tree easy to serialize to
// JSON for the playground's AST viewer.

export const N = Object.freeze({
  Program: 'Program',
  FuncDecl: 'FuncDecl',
  ExternDecl: 'ExternDecl',
  GlobalDecl: 'GlobalDecl',
  Param: 'Param',

  Block: 'Block',
  LetStmt: 'LetStmt',
  AssignStmt: 'AssignStmt',
  IfStmt: 'IfStmt',
  WhileStmt: 'WhileStmt',
  ReturnStmt: 'ReturnStmt',
  BreakStmt: 'BreakStmt',
  ContinueStmt: 'ContinueStmt',
  ExprStmt: 'ExprStmt',

  IntLit: 'IntLit',
  FloatLit: 'FloatLit',
  BoolLit: 'BoolLit',
  Ident: 'Ident',
  Unary: 'Unary',
  Binary: 'Binary',
  Call: 'Call',
});

// Each helper just bundles fields with the node kind and span.
export const Program = (decls) => ({ kind: N.Program, decls });

export const FuncDecl = (name, params, retType, body, exported, span) => ({
  kind: N.FuncDecl, name, params, retType, body, exported, span,
});

export const ExternDecl = (name, params, retType, span) => ({
  kind: N.ExternDecl, name, params, retType, span,
});

export const GlobalDecl = (name, mut, declaredType, init, span) => ({
  kind: N.GlobalDecl, name, mut, declaredType, init, span,
});

export const Param = (name, type, span) => ({ kind: N.Param, name, type, span });

export const Block = (stmts, span) => ({ kind: N.Block, stmts, span });

export const LetStmt = (name, mut, declaredType, init, span) => ({
  kind: N.LetStmt, name, mut, declaredType, init, span,
});

export const AssignStmt = (name, value, span) => ({
  kind: N.AssignStmt, name, value, span,
});

export const IfStmt = (cond, then, otherwise, span) => ({
  kind: N.IfStmt, cond, then, otherwise, span,
});

export const WhileStmt = (cond, body, span) => ({
  kind: N.WhileStmt, cond, body, span,
});

export const ReturnStmt = (value, span) => ({ kind: N.ReturnStmt, value, span });
export const BreakStmt = (span) => ({ kind: N.BreakStmt, span });
export const ContinueStmt = (span) => ({ kind: N.ContinueStmt, span });
export const ExprStmt = (expr, span) => ({ kind: N.ExprStmt, expr, span });

export const IntLit = (value, span) => ({ kind: N.IntLit, value, span });
export const FloatLit = (value, span) => ({ kind: N.FloatLit, value, span });
export const BoolLit = (value, span) => ({ kind: N.BoolLit, value, span });
export const Ident = (name, span) => ({ kind: N.Ident, name, span });

export const Unary = (op, operand, span) => ({ kind: N.Unary, op, operand, span });
export const Binary = (op, left, right, span) => ({
  kind: N.Binary, op, left, right, span,
});
export const Call = (callee, args, span) => ({ kind: N.Call, callee, args, span });
