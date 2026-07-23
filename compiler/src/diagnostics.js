// diagnostics.js — source locations and compiler error reporting.
//
// Every token, AST node, and error carries a `Span` so that diagnostics can
// point at the exact slice of source that caused a problem. The `CompileError`
// class renders a GCC/rustc-style message with a caret underline.

/** A half-open range into the source text: [start, end). */
export class Span {
  constructor(start, end, line, col) {
    this.start = start; // byte offset of first char
    this.end = end;     // byte offset one past the last char
    this.line = line;   // 1-based line of `start`
    this.col = col;     // 1-based column of `start`
  }

  /** Merge two spans into the smallest span covering both. */
  to(other) {
    return new Span(
      Math.min(this.start, other.start),
      Math.max(this.end, other.end),
      this.line,
      this.col,
    );
  }
}

/**
 * A compiler diagnostic. `phase` is one of lex | parse | check so tools can
 * group errors. `span` is optional (some errors are whole-program).
 */
export class CompileError extends Error {
  constructor(message, span, phase = 'compile') {
    super(message);
    this.name = 'CompileError';
    this.span = span || null;
    this.phase = phase;
  }

  /**
   * Render the error against the original source, with a line excerpt and a
   * caret underline pointing at the offending span.
   */
  format(source, filename = '<input>') {
    if (!this.span) return `error[${this.phase}]: ${this.message}`;
    const { line, col } = this.span;
    const lines = source.split('\n');
    const srcLine = lines[line - 1] ?? '';
    const width = Math.max(1, this.span.end - this.span.start);
    const gutter = String(line);
    const pad = ' '.repeat(gutter.length);
    const underline = ' '.repeat(Math.max(0, col - 1)) + '^'.repeat(width);
    return [
      `error[${this.phase}]: ${this.message}`,
      `${pad}--> ${filename}:${line}:${col}`,
      `${pad} |`,
      `${gutter} | ${srcLine}`,
      `${pad} | ${underline}`,
    ].join('\n');
  }
}
