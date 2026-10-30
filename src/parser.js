'use strict';

// Error-tolerant parser for Raga. It never throws: a problem is recorded in `errors` and the parser goes on,
// so that half-typed code in an editor still gives a tree to ask questions about.

const { lex } = require('./lexer');

const INTS = ['i8', 'u8', 'i16', 'u16', 'i32', 'u32', 'i64', 'u64', 'i128', 'u128', 'isize', 'usize'];
const FLOATS = ['f32', 'f64', 'f128'];
const PRIMS = new Set([...INTS, ...FLOATS, 'bool', 'char']);
const KEYWORDS = new Set([
  'const', 'let', 'function', 'method', 'class', 'interface', 'trait', 'struct', 'union', 'enum', 'attribute',
  'if', 'elif', 'else', 'for', 'while', 'loop', 'break', 'continue', 'return',
  'try', 'catch', 'finally', 'throw', 'match', 'switch', 'case', 'default',
  'extends', 'implements', 'use',
  'true', 'false', 'null', 'this', 'super',
  'constructor', 'destructor',
]);
const TYPE_HEADS = new Set(['struct', 'union', 'enum', 'class', 'interface', 'trait']);
const CLASS_LIKE = new Set(['class', 'interface', 'trait']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '<<=']);

const LEVELS = {
  '||': 1, '&&': 2, '|': 3, '^': 4, '&': 5, '==': 6, '!=': 6,
  '<': 7, '<=': 7, '>': 7, '>=': 7, '<<': 8, '>>': 8,
  '+': 9, '-': 9, '*': 10, '/': 10, '%': 10,
};

class Parser {
  constructor(text) {
    const { tokens, comments } = lex(text);
    this.text = text;
    this.tk = tokens;
    this.comments = comments;
    this.i = 0;
    this.errors = [];
    this.paren = 0;
  }

  get tok() { return this.tk[this.i]; }
  peek(k = 1) { return this.tk[Math.min(this.i + k, this.tk.length - 1)]; }
  next() { const t = this.tk[this.i]; if (t.t !== 'eof') this.i++; return t; }
  prevEnd() { return this.i > 0 ? this.tk[this.i - 1].e : 0; }
  is(v) { const t = this.tok; return (t.t === 'p' || t.t === 'id') && t.v === v; }
  isAt(k, v) { const t = this.peek(k); return (t.t === 'p' || t.t === 'id') && t.v === v; }
  eat(v) { return this.is(v) ? this.next() : null; }
  expect(v) {
    if (this.is(v)) return this.next();
    this.err(`expected ${v}`);
    return null;
  }
  err(message, tok = this.tok) { this.errors.push({ s: tok.s, e: Math.max(tok.e, tok.s + 1), message }); }
  attempt(fn) {
    const m = this.i;
    const ne = this.errors.length;
    const saved = this.paren;
    const r = fn();
    if (!r) { this.i = m; this.errors.length = ne; this.paren = saved; }
    return r;
  }
  ident() {
    const t = this.tok;
    if (t.t === 'id' && !KEYWORDS.has(t.v)) return this.next();
    return null;
  }
  startsType(t) {
    return t.t === 'id' && (PRIMS.has(t.v) || t.v === 'ptr' || t.v === 'function' || /^[A-Z]/.test(t.v));
  }

  // ---------------------------------------------------------------- program and statements

  parseProgram() {
    const body = [];
    while (this.tok.t !== 'eof') {
      const before = this.i;
      const s = this.parseStmt();
      if (s) body.push(s);
      this.eat(';');
      if (this.i === before) { this.err(`unexpected ${this.tok.v}`); this.next(); }
    }
    return { k: 'Program', body, s: 0, e: this.text.length };
  }

  parseAttrs() {
    const attrs = [];
    while (this.is('[') && this.tok.t === 'p') {
      const open = this.next();
      this.paren++;
      const items = [];
      while (!this.is(']') && this.tok.t !== 'eof') {
        const name = this.tok;
        if (name.t !== 'id') { this.err('expected an attribute name'); break; }
        this.next();
        let args = [];
        if (this.is('(')) args = this.parseArgs();
        items.push({ name: name.v, nameTok: name, args });
        if (!this.eat(',')) break;
      }
      this.paren--;
      const close = this.expect(']');
      attrs.push({ k: 'Attr', items, s: open.s, e: close ? close.e : this.prevEnd() });
    }
    return attrs;
  }

  // break() and break(1): a call, so the parentheses are always written. The number is how many loops around the
  // innermost one are left too.
  parseBreak() {
    const kw = this.next();
    let count = null;
    const t = this.tok;
    if (t.t === 'p' && t.v === '(' && !t.nl) {
      if (this.isAt(1, ')')) { this.next(); this.next(); }
      else {
        this.next();
        this.paren++;
        count = this.parseExpr();
        this.paren--;
        this.expect(')');
      }
    } else if (t.t === 'p' && (t.v === '{' || t.v === '|') && !t.nl) {
      this.err(`${kw.v} takes a number in parentheses, write ${kw.v}(1)`, t);
      this.attempt(() => { if (this.is('|')) this.parsePipes(); return this.is('{') ? this.parseBlock() : null; });
    } else {
      const ends = t.nl || t.t === 'eof' || (t.t === 'p' && (t.v === '}' || t.v === ';'));
      this.err(`${kw.v} is a call: write ${kw.v}(${ends ? '' : 'value'})`, kw);
      if (!ends) count = this.parseExpr();
    }
    return { k: kw.v === 'break' ? 'Break' : 'Continue', count, s: kw.s, e: this.prevEnd() };
  }

  parseStmt() {
    const attrs = this.parseAttrs();
    const t = this.tok;
    if (t.t === 'id') {
      switch (t.v) {
        case 'const': case 'let': return this.parseVarDecl(attrs);
        case 'if': return this.parseIf();
        case 'while': return this.parseWhile();
        case 'loop': { this.next(); this.emptyParens(); const body = this.parseBlock(); const els = this.parseLoopElse(); return { k: 'Loop', body, else: els, elseTok: els ? els.kw : null, s: t.s, e: els ? els.e : body.e }; }
        case 'for': return this.parseFor();
        case 'match': case 'switch': return this.parseMatch();
        case 'try': return this.parseTry();
        case 'return': return this.parseReturn();
        case 'break': case 'continue': return this.parseBreak();
        case 'else': case 'elif': case 'catch': case 'finally': case 'case': case 'default':
          this.err(`${t.v} without a matching statement`); this.next(); return null;
        default: break;
      }
      if (t.v === 'export' && (this.isAt(1, '(') || this.isAt(1, '{'))) return this.parseExport();
      const d = this.attempt(() => this.tryTypedDecl(attrs));
      if (d) return d;
    }
    if (t.t === 'p' && t.v === '{') return this.parseBlock();
    if (attrs.length && (t.t === 'eof' || t.v === '}')) return { k: 'AttrOnly', attrs, s: attrs[0].s, e: attrs[attrs.length - 1].e };
    return this.parseExprStmt(attrs);
  }

  parseVarDecl(attrs) {
    const kw = this.next();
    // const or let or a type, never a mix: `const u8 x = 1`
    if (this.startsType(this.tok) && this.tok.t === 'id') {
      const mixed = this.attempt(() => { const ty = this.parseType(); return ty && this.tok.t === 'id' && this.isAt(1, '=') ? ty : null; });
      if (mixed) this.err(`${kw.v} or a type, not both: write ${kw.v} name = ... or ${mixed.name} name = ...`, kw);
    }
    const nameTok = this.ident();
    if (!nameTok) { this.err('expected a name'); return { k: 'Error', s: kw.s, e: kw.e }; }
    let init = null;
    if (this.expect('=')) init = this.parseExpr();
    const d = { k: 'Decl', kind: kw.v, name: nameTok.v, nameTok, init, attrs, s: kw.s, e: this.prevEnd() };
    return d;
  }

  tryTypedDecl(attrs) {
    const first = this.tok;
    if (!(this.startsType(first) || (first.t === 'id' && this.isAt(1, '.')))) return null;
    const typeNode = this.parseType();
    if (!typeNode) return null;
    const nameTok = this.ident();
    if (!nameTok) return null;
    // a declaration with no value: `String name`, as in the block of a struct (the analyzer decides where it is allowed)
    if (!(this.is('=') && this.tok.t === 'p')) {
      if (typeNode && (this.tok.nl || this.tok.t === 'eof' || (this.tok.t === 'p' && (this.tok.v === ';' || this.tok.v === '}')))) {
        return { k: 'Decl', kind: 'typed', typeNode, name: nameTok.v, nameTok, init: null, noInit: true, attrs, s: first.s, e: this.prevEnd() };
      }
      return null;
    }
    this.next();
    const init = (this.is('get') || this.is('set')) && (this.isAt(1, '{') || this.isAt(1, '|')) ? this.parseAccessor() : this.parseExpr();
    return { k: 'Decl', kind: 'typed', typeNode, name: nameTok.v, nameTok, init, attrs, s: first.s, e: this.prevEnd() };
  }

  parseExprStmt() {
    const start = this.tok;
    const expr = this.parseExpr();
    const t = this.tok;
    if (t.t === 'p' && ASSIGN_OPS.has(t.v) && (!t.nl || this.paren > 0)) {
      this.next();
      const value = this.parseExpr();
      return { k: 'Assign', op: t.v, target: expr, value, s: start.s, e: this.prevEnd() };
    }
    if (t.t === 'p' && t.v === '>' && this.isAt(1, '>=') && this.peek().s === t.e) {
      this.next(); this.next();
      const value = this.parseExpr();
      return { k: 'Assign', op: '>>=', target: expr, value, s: start.s, e: this.prevEnd() };
    }
    return { k: 'ExprStmt', expr, s: start.s, e: this.prevEnd() };
  }

  parseBlock() {
    const open = this.tok;
    if (!this.is('{')) { this.err('expected {'); return { k: 'Block', body: [], s: open.s, e: open.s }; }
    this.next();
    const saved = this.paren;
    this.paren = 0;
    const body = [];
    while (!this.is('}') && this.tok.t !== 'eof') {
      const before = this.i;
      const s = this.parseStmt();
      if (s) body.push(s);
      this.eat(';');
      if (this.i === before) { this.err(`unexpected ${this.tok.v}`); this.next(); }
    }
    this.paren = saved;
    const close = this.expect('}');
    return { k: 'Block', body, s: open.s, e: close ? close.e : this.prevEnd() };
  }

  parseCond() {
    this.expect('(');
    this.paren++;
    const cond = this.parseExpr();
    this.paren--;
    this.expect(')');
    return cond;
  }

  parseIf() {
    const kw = this.next();
    const cond = this.parseCond();
    const then = this.parseBlock();
    const elifs = [];
    let els = null;
    for (;;) {
      if (this.is('elif')) {
        this.next();
        const c = this.parseCond();
        elifs.push({ cond: c, body: this.parseBlock() });
      } else if (this.is('else')) {
        this.next();
        this.emptyParens();
        els = this.parseBlock();
        break;
      } else break;
    }
    return { k: 'If', cond, then, elifs, else: els, s: kw.s, e: this.prevEnd() };
  }

  // a loop may be followed by an else link on the line of its closing brace: it runs when the loop ran out and did not break
  parseLoopElse() {
    if (!(this.is('else') && !this.tok.nl)) return null;
    const kw = this.next();
    this.emptyParens();
    const block = this.parseBlock();
    block.kw = kw;
    return block;
  }

  parseWhile() {
    const kw = this.next();
    const cond = this.parseCond();
    const body = this.parseBlock();
    const els = this.parseLoopElse();
    return { k: 'While', cond, body, else: els, s: kw.s, e: els ? els.e : body.e };
  }

  parsePipes() {
    const names = [];
    if (!this.is('|')) return names;
    this.next();
    while (this.tok.t === 'id' && !this.is('|')) {
      names.push(this.next());
      if (!this.eat(',')) break;
    }
    this.expect('|');
    return names;
  }

  // |target, ...rest|: names between pipes, the last one may collect the rest with ...
  parsePipesVariadic() {
    const names = [];
    if (!this.is('|')) return names;
    this.next();
    while ((this.tok.t === 'id' || this.is('...')) && !this.is('|')) {
      const dots = this.is('...') ? this.next() : null;
      if (this.tok.t !== 'id') { this.err('expected a name after ...'); break; }
      const nameTok = this.next();
      names.push(dots ? Object.assign({}, nameTok, { variadic: true, s: dots.s }) : nameTok);
      if (!this.eat(',')) break;
    }
    this.expect('|');
    return names;
  }

  parseFor() {
    const kw = this.next();
    const iter = this.parseCond();
    const params = this.parsePipes();
    const body = this.parseBlock();
    const els = this.parseLoopElse();
    return { k: 'For', iter, params, body, else: els, s: kw.s, e: els ? els.e : body.e };
  }

  parseMatch() {
    const kw = this.next();
    const subject = this.parseCond();
    const cases = [];
    let def = null;
    const open = this.expect('{');
    const saved = this.paren;
    this.paren = 0;
    while (open && !this.is('}') && this.tok.t !== 'eof') {
      if (this.is('case')) {
        const c = this.next();
        this.expect('(');
        this.paren++;
        const patterns = [];
        while (!this.is(')') && this.tok.t !== 'eof') {
          patterns.push(this.parseExpr());
          if (!this.eat(',')) break;
        }
        this.paren--;
        this.expect(')');
        const params = this.parsePipes();
        const body = this.parseBlock();
        cases.push({ patterns, params, body, s: c.s, e: body.e });
      } else if (this.is('default')) {
        this.next();
        def = this.parseBlock();
      } else {
        this.err('expected case or default');
        this.next();
      }
    }
    this.paren = saved;
    const close = this.expect('}');
    return { k: kw.v === 'match' ? 'Match' : 'Switch', subject, cases, default: def, s: kw.s, e: close ? close.e : this.prevEnd() };
  }

  // a head that takes nothing may leave its parentheses out: try { } is try() { }
  emptyParens() {
    if (this.is('(') && this.tok.t === 'p' && this.isAt(1, ')')) { this.next(); this.next(); }
  }

  parseTry() {
    const kw = this.next();
    this.emptyParens();
    const body = this.parseBlock();
    let catchParams = null;
    let catchBody = null;
    let fin = null;
    if (this.is('catch')) {
      this.next();
      this.emptyParens();
      catchParams = this.is('|') ? this.parsePipes() : [];
      catchBody = this.parseBlock();
    }
    if (this.is('finally')) { this.next(); this.emptyParens(); fin = this.parseBlock(); }
    return { k: 'Try', body, catchParams, catchBody, finally: fin, s: kw.s, e: this.prevEnd() };
  }

  // return(value), return(), and a block as the one argument: return { 1, 2 } or return |x| { ... }
  parseReturn() {
    const kw = this.next();
    let value = null;
    let block = null;
    const t = this.tok;
    if (t.t === 'p' && t.v === '(' && !t.nl) {
      if (this.isAt(1, ')')) { this.next(); this.next(); }
      else {
        this.next();
        this.paren++;
        value = this.parseExpr();
        this.paren--;
        if (this.is(',')) this.err('return gives one value', this.tok);
        while (this.eat(',')) this.parseExpr();
        this.expect(')');
      }
    } else if (!t.nl && t.t === 'p' && t.v === '{') {
      block = this.parseTrailingBlock([]);
    } else if (!t.nl && t.t === 'p' && t.v === '|' && this.looksLikePipes0()) {
      const names = this.parsePipes();
      block = this.parseTrailingBlock(names);
    } else {
      const ends = t.nl || t.t === 'eof' || (t.t === 'p' && (t.v === '}' || t.v === ';'));
      this.err(`return is a call: write return(${ends ? '' : 'value'})`, kw);
      if (!ends) value = this.parseExpr();
    }
    return { k: 'Return', value, block, s: kw.s, e: this.prevEnd() };
  }

  // export { a, b }: a call whose last argument is a block of names of this file's declarations
  parseExport() {
    const kw = this.next();
    const names = [];
    const readNames = (close) => {
      while (!this.is(close) && this.tok.t !== 'eof') {
        const n = this.ident();
        if (!n) {
          this.err('export takes names of declarations of this file: export { a, b }');
          while (!this.is(',') && !this.is(close) && this.tok.t !== 'eof') this.next();
        } else names.push(n);
        if (!this.eat(',')) break;
      }
    };
    if (this.is('(')) {
      // the old form with parentheses, read so that the rest of the file is still understood
      this.err('export takes a block of names: write export { a, b }', kw);
      this.next();
      this.paren++;
      readNames(')');
      this.paren--;
      const close = this.expect(')');
      return { k: 'Export', names, kwTok: kw, s: kw.s, e: close ? close.e : this.prevEnd() };
    }
    if (!this.is('{')) {
      this.err('export takes a block of names: write export { a, b }', kw);
      return { k: 'Export', names, kwTok: kw, s: kw.s, e: this.prevEnd() };
    }
    this.next();
    this.paren++;
    readNames('}');
    this.paren--;
    const close = this.expect('}');
    return { k: 'Export', names, kwTok: kw, s: kw.s, e: close ? close.e : this.prevEnd() };
  }

  // ---------------------------------------------------------------- types

  // Type: name, name<args>, module.Name, ptr<T>, function(types) ret
  parseType() {
    const t = this.tok;
    if (t.t !== 'id' || (KEYWORDS.has(t.v) && t.v !== 'function')) return null;
    if (t.v === 'function') {
      this.next();
      if (!this.expect('(')) return null;
      this.paren++;
      const params = [];
      while (!this.is(')') && this.tok.t !== 'eof') {
        const ty = this.parseType();
        if (!ty) { this.err('expected a type'); this.next(); continue; }
        let name = null;
        if (this.tok.t === 'id' && !KEYWORDS.has(this.tok.v) && !this.startsType(this.tok)) name = this.next();
        params.push({ type: ty, nameTok: name });
        if (!this.eat(',')) break;
      }
      this.paren--;
      this.expect(')');
      let ret = null;
      if (this.startsType(this.tok) && !this.tok.nl) ret = this.parseType();
      return { k: 'FnType', params, ret, s: t.s, e: this.prevEnd() };
    }
    this.next();
    let name = t.v;
    let path = [t];
    while (this.is('.') && this.peek().t === 'id' && /^[A-Z]/.test(this.peek().v) && this.peek().s === this.tok.e) {
      this.next();
      const seg = this.next();
      path.push(seg);
      name = seg.v;
    }
    let args = [];
    if (this.is('<') && this.tok.t === 'p') {
      const got = this.attempt(() => this.parseTypeArgs());
      if (got) args = got;
    }
    return { k: 'Type', name, path, args, s: t.s, e: this.prevEnd() };
  }

  parseTypeArgs() {
    if (!this.eat('<')) return null;
    const args = [];
    for (;;) {
      const ty = this.parseType();
      if (!ty) return null;
      args.push(ty);
      if (this.eat(',')) continue;
      break;
    }
    if (!this.eat('>')) return null;
    return args;
  }

  parseTypeParams() {
    const params = [];
    if (!(this.is('<') && this.tok.t === 'p')) return params;
    this.next();
    while (this.tok.t === 'id' && !this.is('>')) {
      params.push(this.next());
      if (!this.eat(',')) break;
    }
    this.expect('>');
    return params;
  }

  // ---------------------------------------------------------------- expressions

  parseExpr() {
    return this.parseBinary(1);
  }

  binOp() {
    const t = this.tok;
    if (t.t !== 'p') return null;
    if (t.nl && this.paren === 0) return null;
    let v = t.v;
    let len = 1;
    if (v === '>' && this.isAt(1, '>') && this.peek().s === t.e && !(this.isAt(2, '=') && this.peek(2).s === this.peek().e)) { v = '>>'; len = 2; }
    else if (v === '>' && this.isAt(1, '>=') && this.peek().s === t.e) return null;     // >>= is an assignment
    if (!(v in LEVELS)) return null;
    if (v === '|' && this.looksLikePipes()) return null;
    return { v, len, level: LEVELS[v] };
  }

  looksLikePipes() {
    let k = 1;
    if (this.peek(k).t !== 'id') return false;
    while (this.peek(k).t === 'id') {
      k++;
      if (this.isAt(k, ',')) k++;
      else break;
    }
    return this.isAt(k, '|') && this.isAt(k + 1, '{');
  }

  parseBinary(min) {
    let left = this.parseUnary();
    for (;;) {
      const op = this.binOp();
      if (!op || op.level < min) break;
      for (let n = 0; n < op.len; n++) this.next();
      const right = this.parseBinary(op.level + 1);
      left = { k: 'Binary', op: op.v, left, right, s: left.s, e: this.prevEnd() };
    }
    return left;
  }

  parseUnary() {
    const t = this.tok;
    if (t.t === 'p' && (t.v === '-' || t.v === '!' || t.v === '~' || t.v === '&')) {
      this.next();
      const expr = this.parseUnary();
      return { k: 'Unary', op: t.v, expr, s: t.s, e: this.prevEnd() };
    }
    return this.parsePostfix(this.parsePrimary());
  }

  parseArgs() {
    this.expect('(');
    this.paren++;
    const args = [];
    while (!this.is(')') && this.tok.t !== 'eof') {
      const before = this.i;
      const t = this.tok;
      if (t.t === 'id' && this.isAt(1, '=') && this.peek().t === 'p' && !KEYWORDS.has(t.v)) {
        this.next(); this.next();
        args.push({ name: t.v, nameTok: t, value: this.parseExpr() });
      } else {
        args.push({ name: null, value: this.parseExpr() });
      }
      if (!this.eat(',')) break;
      if (this.i === before) { this.next(); }
    }
    this.paren--;
    this.expect(')');
    return args;
  }

  parseCall(callee, typeArgs) {
    const open = this.tok;
    const args = this.parseArgs();
    const last = this.tk[this.i - 1];
    const call = { k: 'Call', callee, typeArgs: typeArgs || null, args, open, s: callee.s, e: this.prevEnd(), closed: !!last && last.t === 'p' && last.v === ')' && this.i > 0, closeEnd: this.prevEnd() };
    return this.finishCall(call);
  }

  // what may follow a call: a trailing block, then the next steps of a chain
  finishCall(call) {
    // a trailing block: f(x) |n| { ... } or f(x) { ... }
    const pipes = this.attempt(() => {
      if (!(this.is('|') && this.looksLikePipes0())) return null;
      const names = this.parsePipes();
      return this.is('{') ? names : null;
    });
    if (pipes || (this.is('{') && !this.tok.nl)) {
      call.block = this.parseTrailingBlock(pipes || []);
      call.e = this.prevEnd();
    }
    // a chain: calls that return values are chained with a dot, user().select().limit(1). When the last argument of a
    // call is a block (a callback, an Array or a struct), a dot after the closing brace would look strange, so the next
    // name follows the brace on the same line without it:  user { } select { } limit (1). Each step is a call of a member
    // of what the step before it gave back, with its block as the last argument. A step may end with its block or with
    // its parentheses.
    while (this.tok.t === 'id' && !this.tok.nl && !KEYWORDS.has(this.tok.v) && (this.isAt(1, '(') || this.isAt(1, '|') || this.isAt(1, '{'))) {
      const nameTok = this.next();
      let cargs = [];
      if (this.is('(')) cargs = this.parseArgs();
      const cpipes = this.attempt(() => {
        if (!(this.is('|') && this.looksLikePipes0())) return null;
        const names = this.parsePipes();
        return this.is('{') ? names : null;
      });
      const hasBlock = !!cpipes || (this.is('{') && !this.tok.nl);
      const blk = hasBlock ? this.parseTrailingBlock(cpipes || []) : null;
      (call.clauses || (call.clauses = [])).push({
        name: nameTok.v, nameTok, args: cargs, params: cpipes || [], body: blk ? blk.body : null, items: blk ? blk.items : null,
        s: nameTok.s, e: blk ? blk.body.e : this.prevEnd(),
      });
      call.e = this.prevEnd();
    }
    return call;
  }

  // The { } after a call fills the last parameter. Its meaning depends on that parameter's type, which the parser does
  // not know, so a block is read twice: as a body (a function, or a struct written as name = value lines)
  // and as an Array literal (a list of values). The analyzer picks the reading that the parameter's type asks for.
  parseTrailingBlock(params) {
    let items = null;
    let after = null;
    {
      const m = this.i, ne = this.errors.length, pp = this.paren;
      const lit = this.parseCollection('Array', '{', '}');
      if (this.errors.length === ne) { items = lit; after = this.i; }
      this.i = m; this.errors.length = ne; this.paren = pp;
    }
    const nb = this.errors.length;
    const body = this.parseBlock();
    if (items && this.errors.length > nb && after !== null) {
      // only the Array reading is valid
      this.errors.length = nb;
      this.i = after;
      return { params, body: { k: 'Block', body: [], s: items.s, e: items.e }, items, s: items.s, e: items.e };
    }
    return { params, body, items, s: body.s, e: body.e };
  }

  looksLikePipes0() {
    let k = 1;
    while (this.peek(k).t === 'id') {
      k++;
      if (this.isAt(k, ',')) k++;
      else break;
    }
    return this.isAt(k, '|');
  }

  // A call without parentheses. After a name, on the same line, only a block can follow:
  //   { or |names| {    a trailing block and no other argument:  run { ... }
  // A name after a name is not an argument without parentheses: it is read as the call it was meant to be, so the rest
  // of the line is still checked, and reported. A written-out value (a number, a String, true) is reported too.
  tryParenless(e) {
    const t = this.tok;
    if (t.nl || t.t === 'eof') return null;
    // a type name is never called without parentheses: `String name` and `i32 id` are declarations, not String(name)
    if (e.name && (PRIMS.has(e.name) || /^[A-Z]/.test(e.name))) return null;
    const mk = (args) => ({ k: 'Call', callee: e, typeArgs: e.typeArgs || null, args, open: null, parenless: true, s: e.s, e: this.prevEnd(), closed: true, closeEnd: this.prevEnd() });
    if (t.t === 'p' && (t.v === '{' || (t.v === '|' && this.looksLikePipes()))) {
      return this.finishCall(mk([]));
    }
    const arg = this.parenlessOperand(e);
    if (!arg) return null;
    return mk([{ name: null, value: arg }]);
  }

  parenlessOperand(callee) {
    const t = this.tok;
    const written = t.t === 'num' || t.t === 'chr' || t.t === 'str' || (t.t === 'p' && t.v === '[')
      || (t.t === 'id' && (t.v === 'true' || t.v === 'false' || t.v === 'null'));
    if (written) {
      const what = t.t === 'str' ? 'a String' : t.t === 'p' ? 'a List' : t.t === 'id' ? t.v : 'a value';
      this.err(`${what} is written out, so it needs parentheses: write f(...) and not f ${t.v}`, t);
      return this.parsePrimary();
    }
    if (t.t !== 'id' || (KEYWORDS.has(t.v) && t.v !== 'this')) return null;
    // a name, with the members after it
    const first = this.tok;
    let e = this.parsePrimary();
    while (this.is('.') && this.peek().t === 'id' && !this.peek().nl && !KEYWORDS.has(this.peek().v)) {
      this.next();
      const nameTok = this.next();
      e = { k: 'Member', obj: e, name: nameTok.v, nameTok, typeArgs: null, s: e.s, e: this.prevEnd() };
    }
    this.err(`a name is not an argument without parentheses, only a block is: write ${this.text.slice(callee.s, callee.e)}(${first.v})`, first);
    return this.tryParenless(e) || e;
  }

  parsePostfix(e) {
    for (;;) {
      const t = this.tok;
      if (t.t === 'eof') break;
      if (t.nl && this.paren === 0) break;
      if ((e.k === 'Ident' && !e.isKeyword) || (e.k === 'Member' && !e.incomplete)) {
        const call = this.tryParenless(e);
        if (call) return call;
      }
      if (t.t === 'p' && t.v === '.') {
        const n = this.peek();
        if (n.t === 'p' && n.v === '*') {
          this.next(); this.next();
          e = { k: 'Deref', obj: e, s: e.s, e: this.prevEnd() };
          continue;
        }
        if (n.t === 'id' && !n.nl && !(KEYWORDS.has(n.v) && n.v !== 'default')) {
          this.next();
          const nameTok = this.next();
          let typeArgs = null;
          if (this.is('<') && this.tok.t === 'p') typeArgs = this.attempt(() => { const a = this.parseTypeArgs(); return a && (this.is('(') || this.is('.')) ? a : null; });
          e = { k: 'Member', obj: e, name: nameTok.v, nameTok, typeArgs, s: e.s, e: this.prevEnd() };
          continue;
        }
        // a dot with nothing after it: kept so that completion can ask for the members
        const dot = this.next();
        this.err('expected a name after the dot', dot);
        e = { k: 'Member', obj: e, name: '', nameTok: null, dot, incomplete: true, s: e.s, e: dot.e };
        break;
      }
      if (t.t === 'p' && t.v === '(') {
        const typeArgs = e.typeArgs && e.k === 'Ident' ? e.typeArgs : (e.k === 'Member' && e.typeArgs ? e.typeArgs : null);
        e = this.parseCall(e, typeArgs);
        continue;
      }
      break;
    }
    return e;
  }

  parsePrimary() {
    const t = this.tok;
    if (t.t === 'num') { this.next(); return { k: 'Num', v: t.v, s: t.s, e: t.e }; }
    if (t.t === 'str') { this.next(); return { k: 'Str', v: t.v, s: t.s, e: t.e }; }
    if (t.t === 'chr') { this.next(); return { k: 'Char', v: t.v, s: t.s, e: t.e }; }
    if (t.t === 'p') {
      if (t.v === '(') return this.parseParenOrTuple();
      if (t.v === '[') return this.parseCollection('List', '[', ']');
      if (t.v === '{') return this.parseCollection('Array', '{', '}');
      this.err(`unexpected ${t.v}`);
      return { k: 'Error', s: t.s, e: t.s };
    }
    if (t.t === 'id') {
      switch (t.v) {
        case 'true': case 'false': this.next(); return { k: 'Bool', v: t.v, s: t.s, e: t.e };
        case 'null': this.next(); return { k: 'Null', s: t.s, e: t.e };
        case 'this': case 'super': this.next(); return { k: 'Ident', name: t.v, s: t.s, e: t.e, isKeyword: true };
        case 'throw': this.next(); return { k: 'Ident', name: 'throw', s: t.s, e: t.e, isKeyword: true };
        case 'function': case 'method': return this.parseFunction();
        case 'attribute': return this.parseAttributeHead();
        case 'struct': case 'union': case 'enum': case 'class': case 'interface': case 'trait': return this.parseTypeHead();
        default: break;
      }
      if (KEYWORDS.has(t.v)) {
        this.err(`unexpected keyword ${t.v}`);
        this.next();
        return { k: 'Error', s: t.s, e: t.e };
      }
      this.next();
      const id = { k: 'Ident', name: t.v, s: t.s, e: t.e };
      if (this.is('<') && this.tok.t === 'p' && !this.tok.nl) {
        // f<i32>(x) and Type<i32>.member as before, and now f<i32> alone: a generic function with its type filled in, used as a value
        const endsValue = () => this.tok.t === 'eof' || this.tok.nl || (this.tok.t === 'p' && [',', ')', '}', ']', ';'].includes(this.tok.v));
        const args = this.attempt(() => { const a = this.parseTypeArgs(); return a && (this.is('(') || this.is('.') || endsValue()) ? a : null; });
        if (args) { id.typeArgs = args; id.e = this.prevEnd(); }
      }
      return id;
    }
    this.err('expected an expression');
    return { k: 'Error', s: t.s, e: t.s };
  }

  parseParenOrTuple() {
    const open = this.next();
    this.paren++;
    const items = [];
    let comma = false;
    while (!this.is(')') && this.tok.t !== 'eof') {
      const before = this.i;
      items.push(this.parseExpr());
      if (this.eat(',')) { comma = true; continue; }
      if (this.i === before) this.next();
      break;
    }
    this.paren--;
    const close = this.expect(')');
    const end = close ? close.e : this.prevEnd();
    if (items.length === 0) return { k: 'Tuple', items, s: open.s, e: end };
    if (items.length === 1 && !comma) return { k: 'Paren', expr: items[0], s: open.s, e: end };
    return { k: 'Tuple', items, s: open.s, e: end };
  }

  parseCollection(kind, open, close) {
    const o = this.next();
    this.paren++;
    const items = [];
    while (!this.is(close) && this.tok.t !== 'eof') {
      const before = this.i;
      items.push(this.parseExpr());
      if (this.eat(',')) continue;
      if (this.i === before) this.next();
      break;
    }
    this.paren--;
    const c = this.expect(close);
    return { k: kind === 'List' ? 'ListLit' : 'ArrayLit', items, s: o.s, e: c ? c.e : this.prevEnd() };
  }

  parseParams() {
    const params = [];
    if (!this.expect('(')) return params;
    this.paren++;
    while (!this.is(')') && this.tok.t !== 'eof') {
      const before = this.i;
      const ps = this.tok;
      const typeNode = this.parseType();
      if (!typeNode) { this.err('expected a parameter type'); this.next(); continue; }
      const variadic = !!this.eat('...');
      const nameTok = this.ident();
      if (!nameTok) this.err('expected a parameter name');
      let def = null;
      if (this.is('=') && this.tok.t === 'p') { this.next(); def = this.parseExpr(); }
      params.push({ name: nameTok ? nameTok.v : '', nameTok, typeNode, variadic, default: def, s: ps.s, e: this.prevEnd() });
      if (!this.eat(',')) break;
      if (this.i === before) this.next();
    }
    this.paren--;
    this.expect(')');
    return params;
  }

  // function<T>(params) [ReturnType] { body }
  // method<T>(params) [ReturnType] { body } method(params) { body } ...   (overloads follow the closing brace on the same line)
  parseFunction() {
    const kw = this.next();
    const fn = this.parseSignature(kw);
    if (kw.v === 'method') {
      fn.isMethod = true;
      fn.overloads = [];
      while (this.is('method') && !this.tok.nl) fn.overloads.push(this.parseSignature(this.next()));
      fn.e = this.prevEnd();
    }
    return fn;
  }

  parseSignature(kw) {
    const typeParams = this.parseTypeParams();
    const params = this.parseParams();
    let ret = null;
    if (this.startsType(this.tok) && !this.tok.nl) ret = this.parseType();
    let body = null;
    if (this.is('{')) body = this.parseBlock();
    return { k: 'Func', typeParams, params, ret, body, s: kw.s, e: this.prevEnd() };
  }

  // get { ... } set |value| { ... }: the parts of an accessor, in this order, each once
  parseAccessor() {
    const start = this.tok;
    let getter = null;
    let setter = null;
    if (this.is('get')) {
      const kw = this.next();
      getter = { kw, body: this.parseBlock() };
    }
    if (this.is('set') && (!getter || !this.tok.nl)) {
      const kw = this.next();
      const params = this.parsePipes();
      setter = { kw, params, body: this.parseBlock() };
    }
    return { k: 'Accessor', getter, setter, s: start.s, e: this.prevEnd() };
  }

  parseAttributeHead() {
    const kw = this.next();
    const params = this.parseParams();
    const head = { k: 'AttrHead', params, build: null, call: null, s: kw.s, e: this.prevEnd() };
    // const note = attribute(String text)                              metadata only
    // ... |target, text| { }                                            a build hook: runs once per use while building
    // ... call |target, args, next| { }                                 a call hook: runs on every call
    const startsBlock = () => this.tok.t === 'p' && (this.tok.v === '|' || this.tok.v === '{') && !this.tok.nl;
    if (startsBlock()) {
      const open = this.tok;
      const pipes = this.parsePipesVariadic();
      const body = this.parseBlock();
      head.build = { params: pipes, body, s: open.s, e: body.e };
      head.e = this.prevEnd();
    }
    while (this.tok.t === 'id' && this.tok.v === 'call' && !this.tok.nl && (this.isAt(1, '|') || this.isAt(1, '{'))) {
      const kwTok = this.next();
      const pipes = this.parsePipesVariadic();
      const body = this.parseBlock();
      if (head.call) this.err('an attribute has one call block', kwTok);
      else head.call = { kwTok, params: pipes, body, s: kwTok.s, e: body.e };
      head.e = this.prevEnd();
    }
    return head;
  }

  // struct<T> { ... } extends(A) implements(B) use(C)
  parseTypeHead() {
    const kw = this.next();
    const typeParams = this.parseTypeParams();
    const head = { k: 'TypeHead', kind: kw.v, typeParams, members: [], clauses: [], s: kw.s, kwTok: kw };
    if (!this.is('{')) { this.err('expected {'); head.e = this.prevEnd(); return head; }
    const open = this.next();
    head.openTok = open;
    const saved = this.paren;
    this.paren = 0;
    if (kw.v === 'enum') this.parseEnumBody(head);
    else this.parseMembers(head);
    this.paren = saved;
    const close = this.expect('}');
    head.closeTok = close;
    head.bodyEnd = close ? close.e : this.prevEnd();
    while ((this.is('extends') || this.is('implements') || this.is('use')) && this.isAt(1, '(')) {
      const ck = this.next();
      this.next();
      this.paren++;
      const types = [];
      while (!this.is(')') && this.tok.t !== 'eof') {
        const ty = this.parseType();
        if (!ty) { this.err('expected a type'); this.next(); continue; }
        types.push(ty);
        if (!this.eat(',')) break;
      }
      this.paren--;
      this.expect(')');
      head.clauses.push({ kind: ck.v, types, s: ck.s });
    }
    head.e = this.prevEnd();
    return head;
  }

  // the end of a member of a struct, union or enum body: a new line, `;` or the closing brace
  endMember(what) {
    if (this.eat(';')) return;
    if (this.tok.nl || this.is('}') || this.tok.t === 'eof') return;
    if (this.is(',')) { this.err(`separate ${what} with ; or a new line, not a comma`); this.next(); return; }
    this.err(`separate ${what} with ; or a new line`);
  }

  // enum { const Red = 0; const Green = 1 }: every member is an initialization with an integer value
  parseEnumBody(head) {
    while (!this.is('}') && this.tok.t !== 'eof') {
      const before = this.i;
      if (this.eat(';')) continue;
      const attrs = this.parseAttrs();
      if (this.is('const')) {
        const d = this.parseVarDecl(attrs);
        if (d.k === 'Decl' && d.init && d.init.k === 'Func') {
          head.members.push({ k: 'Member', member: 'decl', decl: d, attrs });
        } else if (d.k === 'Decl') {
          const v = d.init;
          const isInt = v && ((v.k === 'Num' && /^[0-9]/.test(String(v.v)) && !/[.eE]/.test(String(v.v).replace(/^0[xX]/, ''))) || (v.k === 'Unary' && v.op === '-' && v.expr.k === 'Num' && !/[.]/.test(String(v.expr.v))));
          if (!isInt) this.err(`an enum member is written const ${d.name} = 0, with an integer value`, d.nameTok);
          head.members.push({ k: 'Member', member: 'enumMember', name: d.name, nameTok: d.nameTok, value: isInt ? v : null, s: d.s, e: d.e });
        }
        this.endMember('members');
        continue;
      }
      const n = this.ident();
      if (n) {
        if (this.is('=') && this.tok.t === 'p') { this.next(); this.parseExpr(); }
        this.err(`write each member as const ${n.v} = 0, with its own value`, n);
        head.members.push({ k: 'Member', member: 'enumMember', name: n.v, nameTok: n, value: null, s: n.s, e: this.prevEnd() });
        this.endMember('members');
        continue;
      }
      if (this.is(',')) { this.err('separate members with ; or a new line, not a comma'); this.next(); continue; }
      if (this.i === before) { this.err(`unexpected ${this.tok.v}`); this.next(); }
    }
  }

  parseMembers(head) {
    const classLike = CLASS_LIKE.has(head.kind);
    while (!this.is('}') && this.tok.t !== 'eof') {
      const before = this.i;
      if (this.eat(';')) continue;
      const attrs = this.parseAttrs();
      const t = this.tok;
      if (t.t === 'eof' || (t.t === 'p' && t.v === '}')) break;
      if (t.t === 'id' && (t.v === 'const' || (classLike && t.v === 'let'))) {
        const d = classLike ? this.parseMemberDecl(attrs) : this.parseVarDecl(attrs);
        head.members.push({ k: 'Member', member: 'decl', decl: d, attrs });
        continue;
      }
      if (classLike) {
        // a field with its first value: Type name = value
        const d = this.attempt(() => this.tryTypedDecl(attrs));
        if (d) { head.members.push({ k: 'Member', member: 'decl', decl: d, attrs }); continue; }
      }
      // fields: Type name  (struct, union, interface)
      const f = this.attempt(() => this.parseFieldGroup(head, attrs));
      if (f) continue;
      if (this.i === before) { this.err(`unexpected ${this.tok.v}`); this.next(); }
    }
  }

  // inside class, interface and trait: const name = value | let name = value | Type name = value | method ... | get ... set ...
  // constructor and destructor are names here, not only keywords
  parseMemberDecl(attrs) {
    const kw = this.next();
    let typeNode = null;
    if (this.startsType(this.tok)) {
      typeNode = this.attempt(() => { const ty = this.parseType(); return ty && this.tok.t === 'id' && this.isAt(1, '=') ? ty : null; });
    }
    if (typeNode) this.err(`${kw.v} or a type, not both: write the type alone, ${typeNode.name} name = ...`, kw);
    let nameTok = this.ident();
    if (!nameTok && (this.is('constructor') || this.is('destructor'))) nameTok = this.next();
    if (!nameTok) { this.err('expected a name'); return { k: 'Error', s: kw.s, e: kw.e }; }
    let init = null;
    if (this.expect('=')) {
      if ((this.is('get') || this.is('set')) && (this.isAt(1, '{') || this.isAt(1, '|'))) init = this.parseAccessor();
      else init = this.parseExpr();
    }
    return { k: 'Decl', kind: kw.v, typeNode, name: nameTok.v, nameTok, init, attrs, s: kw.s, e: this.prevEnd() };
  }

  // struct and union fields: Type name [= default], one per line or separated by `;`
  parseFieldGroup(head, attrs) {
    const start = this.tok;
    const typeNode = this.parseType();
    if (!typeNode) return null;
    // a bare type name on its own was a variant named from outside, inside a union: it is now an initialization
    if (this.tok.nl || this.is('}') || this.is(',') || this.is(';') || this.tok.t === 'eof') {
      const nm = typeNode.path[typeNode.path.length - 1];
      if (head.kind === 'union') this.err(`a variant named from outside is written const ${typeNode.name} = ${typeNode.name}`, nm);
      else this.err('expected a field name after the type', nm);
      head.members.push({ k: 'Member', member: 'variantRef', typeNode, name: typeNode.name, nameTok: nm, attrs, s: start.s, e: this.prevEnd() });
      this.endMember('fields');
      return true;
    }
    // `default` is a keyword, but it is a fine field name (a field named default)
    const nameTok = this.ident() || (this.is('default') && !this.tok.nl ? this.next() : null);
    if (!nameTok) return null;
    // an optional default value: f64 x = 0.0
    let def = null;
    if (this.is('=') && this.tok.t === 'p') { this.next(); def = this.parseExpr(); }
    head.members.push({ k: 'Member', member: 'field', name: nameTok.v, nameTok, typeNode, default: def, attrs, s: start.s, e: this.prevEnd() });
    this.endMember('fields');
    return true;
  }
}

function parse(text) {
  const p = new Parser(text);
  const ast = p.parseProgram();
  return { ast, errors: p.errors, tokens: p.tk, comments: p.comments, text };
}

module.exports = { parse, KEYWORDS, PRIMS, INTS, FLOATS, TYPE_HEADS, CLASS_LIKE };
