// leb128.js — variable-length integer encoding used throughout the wasm binary
// format, plus a small growable byte buffer.

/** A growable byte buffer with helpers for wasm's little-endian encodings. */
export class ByteBuffer {
  constructor() {
    this.bytes = [];
  }

  get length() {
    return this.bytes.length;
  }

  byte(b) {
    this.bytes.push(b & 0xff);
    return this;
  }

  bytesFrom(arr) {
    for (const b of arr) this.bytes.push(b & 0xff);
    return this;
  }

  /** Append another buffer's contents. */
  append(other) {
    for (const b of other.bytes) this.bytes.push(b);
    return this;
  }

  /** Unsigned LEB128. */
  u32(value) {
    let v = value >>> 0;
    do {
      let b = v & 0x7f;
      v >>>= 7;
      if (v !== 0) b |= 0x80;
      this.bytes.push(b);
    } while (v !== 0);
    return this;
  }

  /** Signed LEB128 (used for i32.const operands). */
  i32(value) {
    let v = value | 0; // coerce to 32-bit signed
    let more = true;
    while (more) {
      let b = v & 0x7f;
      v >>= 7; // arithmetic shift keeps the sign
      if ((v === 0 && (b & 0x40) === 0) || (v === -1 && (b & 0x40) !== 0)) {
        more = false;
      } else {
        b |= 0x80;
      }
      this.bytes.push(b);
    }
    return this;
  }

  /** IEEE-754 double, little-endian (f64.const operand). */
  f64(value) {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setFloat64(0, value, true);
    const view = new Uint8Array(buf);
    for (let i = 0; i < 8; i++) this.bytes.push(view[i]);
    return this;
  }

  /** A length-prefixed UTF-8 string (wasm "name"). */
  name(str) {
    const utf8 = new TextEncoder().encode(str);
    this.u32(utf8.length);
    for (const b of utf8) this.bytes.push(b);
    return this;
  }

  /** Prefix a length-delimited vector: write count, then the elements. */
  vec(items, writeItem) {
    this.u32(items.length);
    for (const item of items) writeItem(this, item);
    return this;
  }

  toUint8Array() {
    return new Uint8Array(this.bytes);
  }
}

/** Standalone unsigned-LEB128 encode to a plain array (handy for tests). */
export function encodeU32(value) {
  return new ByteBuffer().u32(value).bytes;
}
