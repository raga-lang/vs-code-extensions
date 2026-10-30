'use strict';

// Binder and type inference for Raga. An Analysis is made from the text of one file.
// It builds scopes and symbols, infers the type of every expression, collects diagnostics,
// and keeps everything the editor features (hover, completion, ...) ask for in queries.js.

const { parse, PRIMS, INTS, FLOATS, KEYWORDS } = require('./parser');
const { T, str, subst, unify, plain, sameFn, hasParam, isUnk } = require('./types');
const preludeText = require('./prelude');

// ------------------------------------------------------------------ scopes and symbols

class Scope {
  constructor(parent, kind, s, e) {
    this.parent = parent;
    this.kind = kind;     // builtin | file | type | function | block
    this.s = s;
    this.e = e;
    this.syms = new Map();
  }
  declare(sym) { this.syms.set(sym.name, sym); return sym; }
  lookup(name) {
    for (let sc = this; sc; sc = sc.parent) {
      const s = sc.syms.get(name);
      if (s) return s;
    }
    return null;
  }
}

// kind: var | param | func | type | variant | field | method | property | enumMember | tparam | attribute | ctor
class Sym {
  constructor(kind, name, props) {
    this.kind = kind;
    this.name = name;
    Object.assign(this, props);
  }
}

// the modifiers are members of three built-in enums: Visibility.Private, Inheritance.Final, Ownership.Static.
// Inside the checks they are handled as lower case words: private, final, static
const MOD_ENUMS = {
  Visibility: ['Public', 'Protected', 'Private'],
  Inheritance: ['Final', 'Abstract', 'Virtual', 'Override'],
  Ownership: ['Instance', 'Static'],
};
const MODS = new Set(Object.values(MOD_ENUMS).flat().map((m) => m.toLowerCase()));
const ENUM_OF_WORD = {};
for (const [e, ms] of Object.entries(MOD_ENUMS)) for (const m of ms) ENUM_OF_WORD[m.toLowerCase()] = e;

// what each special attribute accepts, and the modifiers that cannot go together
const VISIBILITY = ['public', 'protected', 'private'];
const SPECIAL_MODS = {
  class: ['final', 'abstract'],
  method: ['static', 'instance', 'abstract', 'virtual', 'override', 'final', ...VISIBILITY],
  field: ['static', 'instance', ...VISIBILITY],
  accessor: ['static', 'instance', 'virtual', 'override', 'final', ...VISIBILITY],
  get: VISIBILITY,
  set: VISIBILITY,
};
const CONTRADICTIONS = [
  ['abstract', 'final'], ['static', 'override'], ['virtual', 'static'],
  ['public', 'private'], ['public', 'protected'], ['protected', 'private'],
];
const enumWord = (e, m) => `${e}.${m[0].toUpperCase()}${m.slice(1)}`;
// Visibility.Private -> { enumName: 'Visibility', member: 'Private', word: 'private' }, or null when the expression is not one
function modifierOf(v) {
  if (!v || v.k !== 'Member' || !v.obj || v.obj.k !== 'Ident' || !MOD_ENUMS[v.obj.name]) return null;
  return { enumName: v.obj.name, member: v.name, word: v.name.toLowerCase(), known: MOD_ENUMS[v.obj.name].includes(v.name) };
}
const ATTR_TARGETS = { class: ['class'], method: ['method'], field: ['field'], accessor: ['accessor'], get: ['accessor'], set: ['accessor'] };

let preludeAnalysis = null;
function getPrelude() {
  if (!preludeAnalysis) preludeAnalysis = new Analysis(preludeText, { prelude: true });
  return preludeAnalysis;
}

class Analysis {
  constructor(text, opts = {}) {
    this.text = text;
    this.opts = opts;
    this.isPrelude = !!opts.prelude;
    this.parsed = parse(text);
    this.ast = this.parsed.ast;
    this.comments = this.parsed.comments;
    this.diags = [];
    this.refs = [];       // { s, e, sym, node } every use of a name that resolved to a symbol
    this.decls = [];      // { s, e, sym } every declaring name
    this.scopes = [];
    this.calls = [];
    this.matches = [];
    this.exprs = [];      // every expression that was typed
    this.hints = [];      // inlay hints { offset, label }
    this.lineStarts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') this.lineStarts.push(i + 1);
    this.root = this.isPrelude ? new Scope(null, 'builtin', 0, text.length) : getPrelude().fileScope;
    this.fileScope = new Scope(this.root, 'file', 0, text.length);
    this.scopes.push(this.fileScope);
    this.exports = new Map();
    this.exportNode = null;
    this.primSyms = {};
    for (const p of PRIMS) this.primSyms[p] = new Sym('type', p, { tkind: 'prim', prim: true, tparams: [], fields: [], methods: new Map() });
    this.primSyms.ptr = new Sym('type', 'ptr', { tkind: 'prim', prim: true, tparams: ['T'], fields: [], methods: new Map() });
    this.ctx0 = { fn: null, loops: 0, thisType: null };
    this.run();
  }

  // ------------------------------------------------------------ helpers

  lineOf(off) {
    let lo = 0;
    let hi = this.lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (this.lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  // the comment lines directly above the line that holds `off`
  docAt(off) {
    const line = this.lineOf(off);
    const out = [];
    for (let l = line - 1; l >= 0; l--) {
      const ls = this.lineStarts[l];
      const le = (this.lineStarts[l + 1] || this.text.length + 1) - 1;
      const c = this.comments.find((x) => x.s >= ls && x.e <= le + 1);
      if (!c) break;
      if (this.text.slice(ls, c.s).trim() !== '') break;
      out.unshift(c.text.replace(/^ /, ''));
    }
    // a decorative banner is not documentation
    const doc = out.filter((l) => !/^[=\-]{6,}$/.test(l.trim())).join('\n').trim();
    return doc;
  }

  diag(s, e, message, severity = 'error') {
    if (this.isPrelude) return;
    if (this.diags.some((d) => d.s === s && d.e === e && d.message === message)) return;
    this.diags.push({ s, e, message, severity });
  }

  newScope(parent, kind, s, e) {
    const sc = new Scope(parent, kind, s, e);
    this.scopes.push(sc);
    return sc;
  }

  // a field, a property or an enum member: it has a place in the code but it is not a name in scope
  declareMember(sym, tok) {
    sym.s = tok.s; sym.e = tok.e; sym.nameTok = tok; sym.uri = this.opts.uri; sym.analysis = this;
    this.decls.push({ s: tok.s, e: tok.e, sym });
    return sym;
  }

  declare(scope, sym, tok) {
    if (tok) {
      sym.s = tok.s; sym.e = tok.e; sym.nameTok = tok;
      this.decls.push({ s: tok.s, e: tok.e, sym });
    }
    sym.uri = this.opts.uri;
    sym.analysis = this;
    sym.scope0 = scope;
    const prev = scope.syms.get(sym.name);
    if (prev && ['var', 'func', 'type'].includes(prev.kind) && ['var', 'func', 'type'].includes(sym.kind) && scope.kind !== 'builtin' && tok) {
      this.diag(tok.s, tok.e, `${sym.name} is already declared in this scope`);
    }
    scope.declare(sym);
    return sym;
  }

  ref(node, sym, s, e) {
    if (!sym) return;
    node.sym = sym;
    this.refs.push({ s: s === undefined ? node.s : s, e: e === undefined ? node.e : e, sym, node });
  }

  // ------------------------------------------------------------ run

  run() {
    const ctx = this.ctx0;
    this.checkStmts(this.ast.body, this.fileScope, ctx, true);
    this.checkExport();
    if (!this.isPrelude) {
      // a parser error is shown too, so a typing mistake does not hide behind a quiet editor
      for (const e of this.parsed.errors) this.diag(e.s, e.e, e.message);
    }
  }

  checkExport() {
    const exps = this.ast.body.filter((n) => n.k === 'Export');
    if (!exps.length) return;
    if (exps.length > 1) this.diag(exps[1].s, exps[1].e, 'a file has at most one export call');
    const ex = exps[0];
    this.exportNode = ex;
    if (this.ast.body[this.ast.body.length - 1] !== exps[exps.length - 1]) this.diag(ex.s, ex.e, 'the export call is the last statement of the file');
    const seen = new Set();
    for (const n of ex.names) {
      const sym = this.fileScope.syms.get(n.v);
      if (!sym) { this.diag(n.s, n.e, `${n.v} is not declared in this file`); continue; }
      if (seen.has(n.v)) this.diag(n.s, n.e, `${n.v} is exported twice`);
      seen.add(n.v);
      this.exports.set(n.v, sym);
      this.refs.push({ s: n.s, e: n.e, sym, node: { sym } });
    }
  }

  // ------------------------------------------------------------ statements

  checkStmts(list, scope, ctx, top) {
    for (const st of list) this.checkStmt(st, scope, ctx, top);
  }

  checkBlock(block, scope, ctx, declare) {
    const sc = this.newScope(scope, 'block', block.s, block.e);
    if (declare) declare(sc);
    this.checkStmts(block.body, sc, ctx, false);
    return sc;
  }

  checkStmt(st, scope, ctx, top) {
    switch (st.k) {
      case 'Decl': return this.checkDecl(st, scope, ctx, top);
      case 'ExprStmt': {
        const ty = this.inferExpr(st.expr, scope, null, ctx);
        // a name is the function, never a call: as a whole statement it does nothing
        if (ty && ty.k === 'fn' && (st.expr.k === 'Ident' || st.expr.k === 'Member') && !this.isPrelude) {
          const text = this.text.slice(st.expr.s, st.expr.e);
          this.diag(st.expr.s, st.expr.e, `${text} is a function and this does not call it: write ${text}()`);
        }
        return undefined;
      }
      case 'Assign': return this.checkAssign(st, scope, ctx);
      case 'Block': return this.checkBlock(st, scope, ctx);
      case 'If': {
        this.inferExpr(st.cond, scope, null, ctx);
        this.checkBlock(st.then, scope, ctx);
        for (const el of st.elifs) { this.inferExpr(el.cond, scope, null, ctx); this.checkBlock(el.body, scope, ctx); }
        if (st.else) this.checkBlock(st.else, scope, ctx);
        return undefined;
      }
      case 'While':
        this.inferExpr(st.cond, scope, null, ctx);
        this.checkBlock(st.body, scope, { ...ctx, loops: ctx.loops + 1 });
        if (st.else) this.checkBlock(st.else, scope, ctx);
        return undefined;
      case 'Loop':
        this.checkBlock(st.body, scope, { ...ctx, loops: ctx.loops + 1 });
        if (st.else) {
          if (st.else.kw) this.diag(st.else.kw.s, st.else.kw.e, 'a loop with no condition only ends with break, so its else would never run');
          this.checkBlock(st.else, scope, ctx);
        }
        return undefined;
      case 'For':
        this.checkFor(st, scope, ctx);
        if (st.else) this.checkBlock(st.else, scope, ctx);
        return undefined;
      case 'Match': case 'Switch': return this.checkMatch(st, scope, ctx);
      case 'Try': {
        this.checkBlock(st.body, scope, ctx);
        if (st.catchBody) {
          const errSym = this.prelude('IError');
          this.checkBlock(st.catchBody, scope, ctx, (sc) => {
            (st.catchParams || []).forEach((p) => this.declare(sc, new Sym('param', p.v, { type: errSym ? T.named(errSym) : T.unk, visibleFrom: p.s }), p));
          });
        }
        if (st.finally) this.checkBlock(st.finally, scope, ctx);
        return undefined;
      }
      case 'Return': {
        let ty = T.void;
        if (st.value) ty = this.inferExpr(st.value, scope, ctx.fn && ctx.fn.declRet, ctx);
        else if (st.block) {
          // return { 1, 2 } and return |x| { ... }: the block is the value, and the declared type says what it is
          const want = ctx.fn && ctx.fn.declRet;
          if (want && want.k === 'fn') { this.checkTrailingBlock(st.block, want, scope, ctx); ty = want; }
          else if (st.block.items) ty = this.inferExpr(st.block.items, scope, want, ctx);
          else { this.checkTrailingBlock(st.block, null, scope, ctx); ty = T.unk; }
          st.value = st.block.items || st.block.body;
        }
        if (!ctx.fn) { if (!this.isPrelude) this.diag(st.s, st.e, 'return belongs to functions only'); return undefined; }
        ctx.fn.returns.push(ty);
        if (ctx.fn.declRet && st.value) this.checkCompatible(ctx.fn.declRet, ty, st.value);
        return undefined;
      }
      case 'Break': case 'Continue': {
        const word = st.k.toLowerCase();
        if (!ctx.loops) { this.diag(st.s, st.e, `${word} belongs to loops only`); return undefined; }
        if (!st.count) return undefined;
        // the number says how many loops around the innermost one are left too: break 1 leaves two loops
        const c = st.count;
        const lit = c.k === 'Num' ? c : (c.k === 'Unary' && c.expr && c.expr.k === 'Num') ? c.expr : null;
        const text = lit ? String(lit.v).replace(/_/g, '') : '';
        if (!lit || !/^(0x[0-9a-f]+|0b[01]+|0o[0-7]+|\d+)$/i.test(text)) {
          this.diag(c.s, c.e, 'the number of loops to leave is a whole number written in the code');
        } else if (c.k === 'Unary' && c.op === '-' && Number(text) !== 0) {
          this.diag(c.s, c.e, `${word} cannot take a negative number: 0 is the innermost loop`);
        } else {
          const n = Number(text);
          if (n >= ctx.loops) this.diag(c.s, c.e, `${word}(${n}) leaves ${n + 1} loops but only ${ctx.loops} surround${ctx.loops === 1 ? 's' : ''} it`);
        }
        return undefined;
      }
      case 'Export': case 'AttrOnly': case 'Error': return undefined;
      default: return undefined;
    }
  }

  prelude(name) {
    const p = this.isPrelude ? this : getPrelude();
    const s = p.fileScope.syms.get(name);
    return s || null;
  }

  checkFor(st, scope, ctx) {
    const iterT = this.inferExpr(st.iter, scope, null, ctx);
    const [a, b] = this.iterTypes(iterT);
    this.checkBlock(st.body, scope, { ...ctx, loops: ctx.loops + 1 }, (sc) => {
      st.params.forEach((p, i) => {
        const type = i === 0 ? a : (i === 1 ? b : T.unk);
        const sym = this.declare(sc, new Sym('var', p.v, { type, mutable: false, isConst: true, visibleFrom: p.s, loopVar: true }), p);
        this.hints.push({ offset: p.e, label: `: ${str(type)}`, sym });
      });
    });
  }

  // the types a for loop gives to its names
  iterTypes(t) {
    if (!t || t.k !== 'named') return [T.unk, T.unk];
    const n = t.sym.name;
    const usize = T.prim('usize');
    if (['List', 'Array', 'Set'].includes(n) && t.sym.builtin) return [t.args[0] || T.unk, n === 'Set' ? T.unk : usize];
    if (n === 'Range' && t.sym.builtin) return [t.args[0] || T.unk, usize];
    if (n === 'Map' && t.sym.builtin) return [t.args[0] || T.unk, t.args[1] || T.unk];
    if (n === 'String' && t.sym.builtin) return [T.prim('char'), usize];
    return [T.unk, T.unk];
  }

  checkMatch(st, scope, ctx) {
    const isMatch = st.k === 'Match';
    const subj = this.inferExpr(st.subject, scope, null, ctx);
    this.matches.push({ node: st, type: subj });
    const owner = subj && subj.k === 'named' ? subj.sym : null;
    if (!isMatch && subj && !this.isPrelude) {
      if (subj.k === 'named' && subj.sym.builtin && subj.sym.name === 'String') this.diag(st.subject.s, st.subject.e, 'a String cannot be switched on: switch takes integers and chars');
      else if (subj.k === 'prim' && (subj.n === 'f32' || subj.n === 'f64' || subj.n === 'f128')) this.diag(st.subject.s, st.subject.e, 'a float cannot be switched on');
    }
    const seenCases = new Set();
    for (const c of st.cases) {
      let variantSym = null;
      for (const p of c.patterns) {
        if (isMatch && p.k === 'Ident' && owner) {
          const found = this.variantsOf(owner).get(p.name);
          if (found) { variantSym = found; this.ref(p, found); p.ty = T.named(found, subj.args); }
          else if (owner.tkind === 'enum' || owner.tkind === 'union') this.diag(p.s, p.e, `${owner.name} has no variant ${p.name}`);
        } else if (isMatch && p.k === 'Ident') {
          const s = scope.lookup(p.name);
          if (s) this.ref(p, s);
        } else {
          const pt = this.inferExpr(p, scope, subj, ctx);
          if (!isMatch && !this.isPrelude) {
            if (pt && subj && pt.k === 'prim' && subj.k === 'prim' && !pt.lit && pt.n !== subj.n) this.diag(p.s, p.e, `the case is ${pt.n}, the subject is ${subj.n}`);
            if (p.k === 'Num' || p.k === 'Char') {
              const key = p.v;
              if (seenCases.has(key)) this.diag(p.s, p.e, `${key} appears twice in this switch`);
              seenCases.add(key);
            }
          }
        }
      }
      this.checkBlock(c.body, scope, ctx, (sc) => {
        c.params.forEach((p, i) => {
          const type = i === 0 && variantSym ? (variantSym.wraps ? T.named(variantSym.wraps) : T.named(variantSym, subj.args)) : T.unk;
          const sym = this.declare(sc, new Sym('var', p.v, { type, isConst: true, visibleFrom: p.s }), p);
          if (variantSym) this.hints.push({ offset: p.e, label: `: ${str(type)}`, sym });
        });
      });
    }
    if (st.default) this.checkBlock(st.default, scope, ctx);
  }

  // variants of a tagged union, the members of an enum
  variantsOf(sym) {
    if (sym.kind === 'variant') return new Map();
    if (sym.tkind === 'union' && sym.variants && sym.variants.size) return sym.variants;
    if (sym.tkind === 'enum') return sym.enumMembers || new Map();
    return new Map();
  }

  // ------------------------------------------------------------ declarations

  checkDecl(d, scope, ctx, top) {
    const init = d.init;
    this.checkSpecialAttrs(d.attrs, init && init.k === 'TypeHead' ? init.kind : init && init.k === 'Func' && init.isMethod ? 'method' : 'other');
    if (d.kind === 'typed') {
      const declared = this.resolveType(d.typeNode, scope);
      let ty = declared;
      // a variable always has a value (u8 late is an error); only a record block, where the members are data, may leave it out
      if (d.noInit && !this.isPrelude ) this.diag(d.nameTok.s, d.nameTok.e, `${d.name} needs a value: write ${d.name} = ... after the type`);
      if (init) {
        const it = this.inferExpr(init, scope, declared, ctx);
        this.checkCompatible(declared, it, init);
      }
      const sym = this.declare(scope, new Sym('var', d.name, { type: ty, mutable: true, declNode: d, doc: this.docAt(d.attrs.length ? d.attrs[0].s : d.s), visibleFrom: init ? init.e : d.e }), d.nameTok);
      sym.explicit = true;
      this.checkTopBuiltin(d, scope);
      return;
    }
    if (!init) { this.declare(scope, new Sym('var', d.name, { type: T.unk, declNode: d, visibleFrom: d.e }), d.nameTok); return; }
    const doc = this.docAt(d.attrs.length ? d.attrs[0].s : d.s);
    this.checkTopBuiltin(d, scope);
    if (init.k === 'TypeHead') { this.declareType(d, init, scope, ctx, doc); return; }
    if (init.k === 'Func') {
      if (init.isMethod) this.diag(init.s, init.s + 6, 'a method is written inside a class, interface or trait. Outside, use function');
      const fsym = this.declareFunction(d, init, scope, ctx, doc, null);
      return;
    }
    if (init.k === 'AttrHead') { this.declareAttribute(d, init, scope, doc); return; }
    if (init.k === 'Ident' && !init.typeArgs && (PRIMS.has(init.name) || this.isTypeName(init.name, scope))) {
      const target = this.resolveTypeName(init.name, [], scope, init);
      this.declare(scope, new Sym('type', d.name, { tkind: 'alias', target, tparams: [], fields: [], methods: new Map(), doc, declNode: d, visibleFrom: d.s }), d.nameTok);
      return;
    }
    if (init.k === 'Ident' && init.typeArgs && this.isTypeName(init.name, scope)) {
      const target = this.resolveTypeName(init.name, init.typeArgs.map((a) => this.resolveType(a, scope)), scope, init);
      this.declare(scope, new Sym('type', d.name, { tkind: 'alias', target, tparams: [], fields: [], methods: new Map(), doc, declNode: d, visibleFrom: d.s }), d.nameTok);
      return;
    }
    const ty = this.inferExpr(init, scope, null, ctx);
    if (ty && ty.k === 'null') this.diag(init.s, init.e, 'null is not a value. It only fits a declared ptr<T>, write ptr<i32> p = null.');
    const sym = this.declare(scope, new Sym('var', d.name, {
      type: ty && ty.k === 'prim' ? ty : (ty || T.unk), mutable: d.kind === 'let', isConst: d.kind === 'const', declNode: d, doc, visibleFrom: init.e,
    }), d.nameTok);
    if (ty && ty.k === 'module') sym.module = ty.info;
    this.hints.push({ offset: d.nameTok.e, label: `: ${str(plain(ty))}`, sym });
  }

  // the modifiers of [class(...)], [method(...)], [field(...)], [accessor(...)], [get(...)], [set(...)]
  // target: class | method | field | accessor | other (what the attribute sits above)
  checkSpecialAttrs(attrs, target) {
    const seen = {};
    for (const at of attrs || []) {
      for (const it of at.items) {
        const allowed = SPECIAL_MODS[it.name];
        if (!allowed) continue;
        const where = target === 'interface' || target === 'trait' ? 'class' : target;
        if (!ATTR_TARGETS[it.name].includes(where)) {
          this.diag(it.nameTok.s, it.nameTok.e, `[${it.name}(...)] belongs on ${it.name === 'class' ? 'a class' : it.name === 'method' ? 'a method' : it.name === 'field' ? 'a field' : 'an accessor'}`);
          continue;
        }
        const mods = seen[it.name] || (seen[it.name] = new Set());
        const accepts = () => Object.entries(MOD_ENUMS).map(([e, ms]) => {
          const ok = ms.filter((m) => allowed.includes(m.toLowerCase()));
          return ok.length ? `${e}.${ok.join(', ')}` : '';
        }).filter(Boolean).join('; ');
        for (const a of it.args) {
          const v = a.value;
          if (!v) continue;
          const mod = modifierOf(v);
          if (!mod) {
            if (v.k === 'Ident' && ENUM_OF_WORD[v.name]) {
              this.diag(v.s, v.e, `${v.name} is not a name any more: write ${enumWord(ENUM_OF_WORD[v.name], v.name)}`);
            } else {
              this.diag(v.s, v.e, `[${it.name}(...)] takes modifiers from Visibility, Inheritance and Ownership: ${accepts()}`);
            }
            continue;
          }
          if (!mod.known) {
            this.diag(v.s, v.e, `${mod.enumName} has no member ${mod.member}`);
            continue;
          }
          if (!allowed.includes(mod.word)) {
            this.diag(v.s, v.e, `[${it.name}(...)] does not take ${mod.enumName}.${mod.member}. It accepts ${accepts()}`);
            continue;
          }
          for (const [x, y] of CONTRADICTIONS) {
            if ((mod.word === x && mods.has(y)) || (mod.word === y && mods.has(x))) this.diag(v.s, v.e, `${enumWord(ENUM_OF_WORD[x], x)} and ${enumWord(ENUM_OF_WORD[y], y)} contradict each other`);
          }
          mods.add(mod.word);
        }
      }
    }
    for (const kind of ['method', 'accessor']) {
      const m = seen[kind];
      if (m && m.has('final') && !m.has('virtual') && !m.has('override') && !m.has('static')) {
        const at = (attrs || []).find((x) => x.items.some((i) => i.name === kind));
        if (at) this.diag(at.s, at.e, `Inheritance.Final needs Inheritance.Virtual or Inheritance.Override: there is nothing to forbid replacing`);
      }
    }
  }

  // the modifiers written in [kind(...)] attributes
  modsOf(attrs, kind) {
    const out = new Set();
    for (const at of attrs || []) for (const it of at.items) if (it.name === kind) for (const a of it.args) { const m = modifierOf(a.value); if (m && m.known) out.add(m.word); }
    return out;
  }

  checkTopBuiltin(d, scope) {
    if (scope !== this.fileScope || this.isPrelude) return;
    const b = getPrelude().fileScope.syms.get(d.name);
    if (b) this.diag(d.nameTok.s, d.nameTok.e, `${d.name} is built in, choose another name`);
  }

  isTypeName(name, scope) {
    const s = scope.lookup(name);
    return !!s && s.kind === 'type';
  }

  // ---- types written in the code

  resolveType(node, scope) {
    if (!node) return T.unk;
    if (node.k === 'FnType') {
      return T.fn(node.params.map((p) => ({ name: p.nameTok ? p.nameTok.v : '', type: this.resolveType(p.type, scope) })), node.ret ? this.resolveType(node.ret, scope) : T.void);
    }
    const args = node.args.map((a) => this.resolveType(a, scope));
    if (node.name === 'ptr' && node.path.length === 1) return T.ptr(args[0] || T.unk);
    if (PRIMS.has(node.name) && node.path.length === 1) return T.prim(node.name);
    return this.resolveTypeName(node.name, args, scope, node, node.path);
  }

  resolveTypeName(name, args, scope, node, path) {
    if (PRIMS.has(name) && (!path || path.length === 1)) return T.prim(name);
    let sym = null;
    if (path && path.length > 1) {
      // module.Type
      const mod = scope.lookup(path[0].v);
      if (mod && mod.module) sym = mod.module.exports.get(name) || null;
      if (mod) this.refs.push({ s: path[0].s, e: path[0].e, sym: mod, node: {} });
      if (!sym) { if (mod && mod.module) this.diag(node.s, node.e, `${name} is not exported by ${path[0].v}`); return T.unk; }
    } else {
      sym = scope.lookup(name);
    }
    if (!sym) {
      if (node && node.s !== undefined) this.diag(node.s, node.e, `the type ${name} is not declared`);
      return T.unk;
    }
    if (node && node.s !== undefined && sym) {
      const tok = path ? path[path.length - 1] : node;
      this.refs.push({ s: tok.s, e: tok.e, sym, node: node });
    }
    if (sym.kind === 'tparam') return T.param(name);
    if (sym.kind === 'type') {
      if (sym.tkind === 'alias') return sym.target || T.unk;
      if (sym.builtin && sym.name === 'Map' && args.length === 1 && node && node.s !== undefined) {
        this.diag(node.s, node.e, 'a Map has two type arguments: Map<K, V>');
        return T.named(sym, [T.unk, args[0]]);
      }
      if (sym.builtin && sym.name === 'Map' && args.length === 2 && node && node.args && node.args[0] && node.args[0].s !== undefined) {
        this.checkMapKey(args[0], node.args[0].s, node.args[0].e);
      }
      return T.named(sym, args);
    }
    return T.unk;
  }

  // ---- type heads: struct, union, enum, class, interface, trait

  declareType(d, head, scope, ctx, doc) {
    const sym = new Sym('type', d.name, {
      tkind: head.kind, tparams: head.typeParams.map((t) => t.v), node: head, doc, declNode: d, attrs: d.attrs,
      fields: [], methods: new Map(), props: new Map(), variants: new Map(), enumMembers: new Map(), ctors: [], dtor: null,
      builtin: this.isPrelude, visibleFrom: d.s,
    });
    this.declare(scope, sym, d.nameTok);
    this.buildType(sym, head, scope, ctx);
    return sym;
  }

  buildType(sym, head, outer, ctx) {
    const body = this.newScope(outer, 'type', head.openTok ? head.openTok.s : head.s, head.bodyEnd !== undefined ? head.bodyEnd : head.e);
    sym.bodyScope = body;
    sym.outerScope = outer;
    head.tparams0 = sym.tparams;
    head.typeParams.forEach((tp) => this.declare(body, new Sym('tparam', tp.v, { type: T.param(tp.v), visibleFrom: 0 }), tp));
    const selfType = T.named(sym, sym.tparams.map((n) => T.param(n)));
    sym.selfType = selfType;
    const pending = [];
    const classLike = sym.tkind === 'class' || sym.tkind === 'interface' || sym.tkind === 'trait';
    const fieldDefaults = [];
    for (const m of head.members) {
      if (m.member === 'field') {
        const fs = new Sym('field', m.name, { typeNode: m.typeNode, owner: sym, scopeFor: body, defNode: m.default || null, doc: this.lineOf(m.s) === this.lineOf(head.s) ? '' : this.docAt(m.s) });
        this.declareMember(fs, m.nameTok);
        sym.fields.push(fs);
        if (m.default && sym.tkind === 'interface' && !this.isPrelude) this.diag(m.default.s, m.default.e, 'an interface field has no default: it lists a promise, the class gives the value');
        else if (m.default) fieldDefaults.push(fs);
      } else if (m.member === 'variantRef' && sym.tkind === 'union') {
        const wrapped = this.resolveType(m.typeNode, body);
        const wf = new Sym('field', 'value', { owner: sym, type: wrapped, typeNode: null });
        const vs = new Sym('variant', m.name, {
          tkind: 'struct', owner: sym, tparams: sym.tparams, node: null, doc: this.docAt(m.s), wraps: wrapped.k === 'named' ? wrapped.sym : null,
          fields: [wf], methods: new Map(), props: new Map(), variants: new Map(), enumMembers: new Map(), ctors: [], builtin: this.isPrelude, visibleFrom: m.s,
          bodyScope: body, selfType: wrapped,
        });
        vs.s = m.nameTok.s; vs.e = m.nameTok.e; vs.nameTok = m.nameTok; vs.uri = this.opts.uri; vs.analysis = this;
        this.decls.push({ s: vs.s, e: vs.e, sym: vs });
        sym.variants.set(m.name, vs);
      } else if (m.member === 'enumMember') {
        const es = new Sym('enumMember', m.name, { owner: sym, valueNode: m.value, doc: this.docAt(m.s) });
        if (m.value) {
          const raw = m.value.k === 'Unary' ? -Number(m.value.expr.v) : Number(String(m.value.v).replace(/_/g, ''));
          es.value = raw;
          const same = [...sym.enumMembers.values()].find((o) => o.value === raw);
          if (same && !this.isPrelude) this.diag(m.nameTok.s, m.nameTok.e, `${same.name} and ${m.name} have the same value`);
        }
        this.declareMember(es, m.nameTok);
        sym.enumMembers.set(m.name, es);
      } else if (m.member === 'decl') {
        const dd = m.decl;
        // a bodiless `Type name` in an interface or a trait lists a field that the class gives; in a class it needs a value
        if (dd && dd.k === 'Decl' && dd.noInit && classLike) {
          if (sym.tkind === 'class' && dd.synthetic) continue;
          if (sym.tkind === 'class') { this.diag(dd.nameTok.s, dd.nameTok.e, `${dd.name} needs a value: a field of a class is written ${dd.name} = ... after the type`); continue; }
          const fs = new Sym('field', dd.name, { typeNode: dd.typeNode, owner: sym, scopeFor: body, doc: this.docAt(dd.s) });
          this.declareMember(fs, dd.nameTok);
          sym.fields.push(fs);
          continue;
        }
        if (dd.k !== 'Decl' || !dd.init) continue;
        if (classLike && this.buildClassMember(sym, dd, body, ctx, selfType, pending)) continue;
        if (dd.init.k === 'Func') {
          this.checkSpecialAttrs(dd.attrs, 'method');
          if (dd.init.isMethod) this.diag(dd.init.s, dd.init.s + 6, 'the methods of a struct, enum and union are written with function');
          const isStatic = this.modsOf(m.attrs || [], 'method').has('static');
          const ms = this.declareFunction(dd, dd.init, body, ctx, this.docAt(dd.attrs && dd.attrs.length ? dd.attrs[0].s : dd.s), { owner: sym, isStatic, selfType });
          sym.methods.set(dd.name, ms);
          pending.push(ms);
        } else if (sym.tkind === 'union' && (dd.init.k === 'Ident' || (dd.init.k === 'Member' && dd.init.obj.k === 'Ident' && dd.init.nameTok))) {
          // const Square = Square: a variant named from outside, the right side is the struct type in the enclosing scope
          const rhs = dd.init;
          const path = rhs.k === 'Ident' ? [{ v: rhs.name, s: rhs.s, e: rhs.e }] : [{ v: rhs.obj.name, s: rhs.obj.s, e: rhs.obj.e }, rhs.nameTok];
          const typeNode = { k: 'Type', name: path[path.length - 1].v, path, args: rhs.typeArgs || [], s: rhs.s, e: rhs.e };
          const wrapped = this.resolveType(typeNode, outer);
          const wf = new Sym('field', 'value', { owner: sym, type: wrapped, typeNode: null });
          const vs = new Sym('variant', dd.name, {
            tkind: 'struct', owner: sym, tparams: sym.tparams, node: null, doc: this.docAt(dd.s), wraps: wrapped.k === 'named' ? wrapped.sym : null,
            fields: [wf], methods: new Map(), props: new Map(), variants: new Map(), enumMembers: new Map(), ctors: [], builtin: this.isPrelude, visibleFrom: dd.s,
            bodyScope: body, selfType: wrapped,
          });
          vs.s = dd.nameTok.s; vs.e = dd.nameTok.e; vs.nameTok = dd.nameTok; vs.uri = this.opts.uri; vs.analysis = this;
          this.decls.push({ s: vs.s, e: vs.e, sym: vs });
          sym.variants.set(dd.name, vs);
        } else if (dd.init.k === 'TypeHead' && sym.tkind === 'union') {
          const vs = new Sym('variant', dd.name, {
            tkind: 'struct', owner: sym, tparams: sym.tparams, node: dd.init, doc: this.docAt(dd.s), declNode: dd,
            fields: [], methods: new Map(), props: new Map(), variants: new Map(), enumMembers: new Map(), ctors: [], builtin: this.isPrelude, visibleFrom: dd.s,
          });
          this.declareMember(vs, dd.nameTok);
          sym.variants.set(dd.name, vs);
          this.buildType(vs, dd.init, body, ctx);
        } else if (dd.init.k === 'TypeHead') {
          this.declareType(dd, dd.init, body, ctx, this.docAt(dd.s));
        }
      }
    }
    // clauses: extends, implements, use
    sym.extendsT = []; sym.implementsT = []; sym.usesT = [];
    // only a class takes all three clauses: an interface may extend other interfaces and a trait may use other traits
    const allowed = { class: ['extends', 'implements', 'use'], interface: ['extends'], trait: ['use'] }[head.kind] || [];
    for (const cl of head.clauses) {
      if (!allowed.includes(cl.kind) && !this.isPrelude) {
        this.diag(cl.s, cl.s + cl.kind.length, `${head.kind === 'enum' ? 'an' : 'a'} ${head.kind} has no ${cl.kind}(...) clause${head.kind === 'struct' || head.kind === 'union' || head.kind === 'enum' ? ': write a class' : ''}`);
      }
      for (const tn of cl.types) {
        const ty = this.resolveType(tn, outer);
        // implements takes interfaces: a class is extended
        if (cl.kind === 'implements' && ty && ty.k === 'named' && ty.sym.tkind === 'class' && !this.isPrelude) {
          this.diag(tn.s, tn.e, ty.sym.builtin && ty.sym.name === 'Error' ? 'Error is a class: write implements(IError) or extends(Error)' : `${ty.sym.name} is a class, not an interface: write extends(${ty.sym.name})`);
        }
        if (cl.kind === 'extends') sym.extendsT.push(ty);
        else if (cl.kind === 'implements') sym.implementsT.push(ty);
        else sym.usesT.push(ty);
      }
    }
    // a class must have every field and method that an interface it implements lists, its own, inherited or from a trait
    if (sym.tkind === 'class' && !this.isPrelude && sym.implementsT.length) {
      const have = new Set();
      const gather = (cs, seen) => {
        if (!cs || seen.has(cs)) return;
        seen.add(cs);
        for (const f of cs.fields || []) have.add(f.name);
        for (const m of (cs.methods || new Map()).keys()) have.add(m);
        for (const pr of (cs.props || new Map()).keys()) have.add(pr);
        for (const list of [cs.extendsT || [], cs.usesT || []]) for (const t of list) if (t && t.k === 'named') gather(t.sym, seen);
      };
      gather(sym, new Set());
      const required = (is, seen, out) => {
        if (!is || seen.has(is)) return out;
        seen.add(is);
        for (const f of is.fields || []) out.push(f.name);
        for (const m of (is.methods || new Map()).keys()) out.push(m);
        for (const t of is.extendsT || []) if (t && t.k === 'named') required(t.sym, seen, out);
        return out;
      };
      for (const cl of head.clauses) {
        if (cl.kind !== 'implements') continue;
        cl.types.forEach((tn) => {
          const ty = this.resolveType(tn, outer);
          if (!ty || ty.k !== 'named' || ty.sym.tkind !== 'interface') return;
          const missing = required(ty.sym, new Set(), []).filter((n) => !have.has(n));
          if (missing.length) this.diag(tn.s, tn.e, `${sym.name} does not have ${missing.join(', ')}, which ${ty.sym.name} requires`);
        });
      }
    }
    // checks that need the whole body
    // default values of struct and union fields: an expression of the field's type, outside the other fields
    for (const fs of fieldDefaults) {
      const declared = this.fieldType(fs);
      const it = this.inferExpr(fs.defNode, body, declared && !isUnk(declared) ? declared : null, this.ctx0);
      if (declared && !isUnk(declared)) this.checkCompatible(declared, it, fs.defNode);
    }
    if (!this.isPrelude) this.checkTypeBody(sym, head);
    // bodies of methods, constructors, properties: in the order written
    for (const ps of sym.props.values()) this.checkProperty(ps);
    for (const ms of pending) this.checkFunctionBody(ms);
  }

  // a member of a class, an interface or a trait: a method, a constructor, a destructor, an accessor or a field.
  // Returns false for what is not one of these (a type nested in the body).
  buildClassMember(sym, dd, body, ctx, selfType, pending) {
    const init = dd.init;
    const attrs = dd.attrs || [];
    const doc = this.docAt(attrs.length ? attrs[0].s : dd.s);
    if (init.k === 'TypeHead' || init.k === 'AttrHead') return false;
    const taken = sym.methods.has(dd.name) || sym.props.has(dd.name) || sym.fields.some((f) => f.name === dd.name) || (dd.name === 'constructor' && sym.ctors.length) || (dd.name === 'destructor' && sym.dtor);
    if (taken) this.diag(dd.nameTok.s, dd.nameTok.e, `${dd.name} is already declared in ${sym.name}. Overloads of a method follow its closing brace on the same line`);

    // a field whose type is written as a function type holds a function value (a closure), it is not a method
    if (init.k === 'Func' && !(dd.typeNode && !init.isMethod)) {
      if (!init.isMethod) this.diag(init.s, init.s + 8, 'the methods of a class, interface and trait are written with method');
      const special = dd.name === 'constructor' ? 'constructor' : dd.name === 'destructor' ? 'destructor' : 'method';
      this.checkSpecialAttrs(attrs, special === 'method' ? 'method' : 'other');
      if (special !== 'method' && attrs.length) this.diag(attrs[0].s, attrs[attrs.length - 1].e, `${dd.name} takes no attributes`);
      const mods = this.modsOf(attrs, 'method');
      const forms = [init, ...(init.overloads || [])];
      const syms = forms.map((fn, i) => {
        const m = { member: special, name: dd.name, nameTok: dd.nameTok, typeParams: fn.typeParams, params: fn.params, ret: fn.ret, body: fn.body, attrs, s: fn.s, e: fn.e };
        const ms = this.declareClassMethod(m, sym, body, selfType, i > 0, doc);
        if (!fn.body && !mods.has('abstract') && special === 'method') this.diag(fn.s, fn.s + 6, 'a method without a body is marked [method(Inheritance.Abstract)], or give it a body');
        if (fn.body && mods.has('abstract')) this.diag(fn.s, fn.s + 6, 'an abstract method has no body');
        pending.push(ms);
        return ms;
      });
      // two forms with the same parameter types cannot be told apart
      const keyOf = (ms) => ms.params.map((p) => str(p.type)).join(', ');
      syms.forEach((ms, i) => {
        const j = syms.findIndex((o) => keyOf(o) === keyOf(ms));
        if (j !== i && !this.isPrelude) this.diag(forms[i].s, forms[i].s + 6, `${dd.name}(${keyOf(ms)}) is already written above: overloads differ in their parameter types`);
      });
      if (special === 'constructor') sym.ctors.push(...syms);
      else if (special === 'destructor') {
        sym.dtor = syms[0];
        if (syms.length > 1 || syms[0].params.length) this.diag(forms[0].s, forms[0].s + 6, 'a destructor has no parameters and a class has one');
      } else {
        syms[0].overloads = syms;
        sym.methods.set(dd.name, syms[0]);
      }
      return true;
    }

    if (init.k === 'Accessor') {
      this.checkSpecialAttrs(attrs, 'accessor');
      const mods = this.modsOf(attrs, 'accessor');
      const ps = new Sym('property', dd.name, {
        typeNode: dd.typeNode, owner: sym, scopeFor: body, node: { typeNode: dd.typeNode, getter: init.getter, setter: init.setter },
        doc, attrs, selfType, isStatic: mods.has('static'),
      });
      this.declareMember(ps, dd.nameTok);
      sym.props.set(dd.name, ps);
      if (init.setter && !init.getter && !dd.typeNode) this.diag(dd.nameTok.s, dd.nameTok.e, `an accessor with only a set needs its type written instead of const: i32 ${dd.name} = set |value| { ... }`);
      if (init.setter && init.setter.params.length !== 1) this.diag(init.setter.kw.s, init.setter.kw.e, 'set has one parameter, written |value|');
      return true;
    }

    // a field with its first value: Type name = value, let name = value, const name = value
    if (sym.tkind === 'interface' && !this.isPrelude) this.diag(init.s, init.e, 'an interface field has no default: it lists a promise, the class gives the value');
    this.checkSpecialAttrs(attrs, 'field');
    const mods = this.modsOf(attrs, 'field');
    const fs = new Sym('field', dd.name, {
      typeNode: dd.typeNode, owner: sym, scopeFor: body, doc, isStatic: mods.has('static'), isConst: dd.kind === 'const', initNode: init, attrs,
    });
    this.declareMember(fs, dd.nameTok);
    sym.fields.push(fs);
    const declared = dd.typeNode ? this.resolveType(dd.typeNode, body) : null;
    const it = this.inferExpr(init, body, declared, this.ctx0);
    if (declared) {
      fs.type = declared;
      this.checkCompatible(declared, it, init);
    } else {
      if (it && it.k === 'null') this.diag(init.s, init.e, 'null is not a value. It only fits a declared ptr<T>, write ptr<i32> p = null.');
      fs.type = plain(it) || T.unk;
      this.hints.push({ offset: dd.nameTok.e, label: `: ${str(fs.type)}`, sym: fs });
    }
    return true;
  }

  checkTypeBody(sym, head) {
    // a field cannot hold its own type directly: a value of it could never be created
    for (const f of sym.fields) {
      const tn = f.typeNode;
      if (tn && tn.k === 'Type' && tn.name === sym.name && tn.path.length === 1 && !sym.node.members.some((m) => m.member === 'decl' && m.decl.name === sym.name)) {
        this.diag(tn.s, tn.e, `a ${sym.name} could never be created, a field cannot hold its own type directly. Use Optional<${sym.name}>, List<${sym.name}> or Weak<${sym.name}>`);
      }
    }
  }

  declareAttribute(d, head, scope, doc) {
    const sym = new Sym('attribute', d.name, { node: head, doc, declNode: d, params: [], visibleFrom: d.s });
    sym.params = head.params.map((p) => ({ name: p.name, type: this.resolveType(p.typeNode, scope), def: p.default, variadic: p.variadic }));
    sym.hooks = { build: !!head.build, call: !!head.call };
    this.declare(scope, sym, d.nameTok);
    if (head.build) this.checkAttributeBuild(d, head, sym, scope);
    if (head.call) this.checkAttributeCall(d, head, scope);
  }

  // what the build hook receives as target: it depends on [on(Kind.X)] above the attribute
  attributeTargetType(d) {
    for (const at of d.attrs || []) {
      for (const it of at.items) {
        if (it.name !== 'on' || !it.args.length) continue;
        const v = it.args[0].value;
        const kind = v && v.k === 'Member' ? v.name : '';
        const info = { Function: 'BindingInfo', Method: 'BindingInfo', Field: 'FieldInfo', Struct: 'TypeInfo', Class: 'TypeInfo', Enum: 'TypeInfo', Union: 'TypeInfo', Type: 'TypeInfo' }[kind];
        const s = info ? this.prelude(info) : null;
        if (s) return T.named(s, []);
      }
    }
    return T.unk;
  }

  anyArray() {
    const arr = this.prelude('Array');
    const any = this.prelude('Any');
    return arr && any ? T.named(arr, [T.named(any, [])]) : T.unk;
  }

  // |target, path, verb| { }: the block names target and then every declared parameter, in order. Nothing is in scope by magic.
  checkAttributeBuild(d, head, sym, scope) {
    const block = head.build;
    const declared = head.params.length;
    const ps = block.params;
    const variadic = ps.length && ps[ps.length - 1].variadic;
    const target = this.attributeTargetType(d);
    let types;
    if (variadic) {
      if (declared) this.diag(ps[ps.length - 1].s, ps[ps.length - 1].e, 'a ...name collector is for an attribute that declares no parameters: attribute() |target, ...rest|');
      else if (ps.length !== 2) this.diag(ps[0].s, ps[ps.length - 1].e, 'the block takes target and ...rest');
      types = [target, this.anyArray()];
    } else {
      if (ps.length !== 1 + declared) {
        const first = ps[0] || { s: block.body.s, e: block.body.s + 1 };
        const last = ps[ps.length - 1] || first;
        this.diag(first.s, last.e, declared ? `the block takes target and the ${declared} declared parameter${declared === 1 ? '' : 's'}` : 'the block takes target only');
      }
      types = [target, ...sym.params.map((p) => (p.variadic ? this.anyArray() : p.type))];
    }
    this.checkTrailingBlock(block, T.fn(types.map((t, i) => ({ name: ps[i] ? ps[i].v : '', type: t })), T.void, []), scope, null);
  }

  // call |target, args, next| { }: runs on every call; next runs the original function with the arguments given
  checkAttributeCall(d, head, scope) {
    const block = head.call;
    const ps = block.params;
    // an attribute limited to methods with [on(Kind.Method)] also gets the object the method is called on
    const onMethod = (d.attrs || []).some((at) => at.items.some((it) => it.name === 'on' && it.args.length && it.args[0].value && it.args[0].value.k === 'Member' && it.args[0].value.name === 'Method'));
    const want = onMethod ? 4 : 3;
    if (ps.length !== want) {
      const first = ps[0] || { s: block.body.s, e: block.body.s + 1 };
      const last = ps[ps.length - 1] || first;
      this.diag(first.s, last.e, onMethod ? 'the call block of a method takes target, receiver, args and next' : 'the call block takes target, args and next (an attribute on methods, [on(Kind.Method)], also takes receiver)');
    }
    const any = this.prelude('Any');
    const anyT = any ? T.named(any, []) : T.unk;
    const args = this.anyArray();
    const next = T.fn([{ name: 'args', type: args }], anyT, []);
    const params = [{ name: 'target', type: this.attributeTargetType(d) }];
    if (onMethod) params.push({ name: 'receiver', type: anyT });
    params.push({ name: 'args', type: args }, { name: 'next', type: next });
    this.checkTrailingBlock(block, T.fn(params, anyT, []), scope, null);
  }

  // ---- functions

  // [operator(Op.Add)]: the member must be one of Op, and the parameters must fit: a binary operator takes two values (a function)
  // or one besides the object (a method), a unary one takes one (a function) or none (a method)
  checkOperatorAttr(attrs, paramCount, isMethod) {
    if (this.isPrelude) return;
    const UNARY = ['Neg', 'Not', 'BitNot'];
    const opSym = this.prelude('Op');
    const valid = opSym && opSym.enumMembers ? [...opSym.enumMembers.keys()] : [];
    for (const a of attrs || []) {
      for (const it of a.items || []) {
        if (it.name !== 'operator' || !it.args || !it.args[0]) continue;
        const v = it.args[0].value;
        const member = v && v.k === 'Member' && v.obj && v.obj.k === 'Ident' && v.obj.name === 'Op' ? v.name : null;
        if (!member) { this.diag(v.s, v.e, 'an operator is written Op.Add, with a member of Op'); continue; }
        if (valid.length && !valid.includes(member)) { this.diag(v.s, v.e, `Op has no member ${member}`); continue; }
        const unary = UNARY.includes(member);
        const want = (unary ? 1 : 2) - (isMethod ? 1 : 0);
        if (paramCount !== want) {
          const who = isMethod ? `a method takes ${want === 0 ? 'no parameter' : 'one parameter, the right operand'}` : `a function takes ${want}`;
          this.diag(v.s, v.e, `Op.${member} is ${unary ? 'unary' : 'binary'}: ${who}`);
        }
      }
    }
  }

  declareFunction(d, fn, scope, ctx, doc, owner) {
    if (d && d.attrs) this.checkOperatorAttr(d.attrs, fn.params.length, !!owner);
    const sym = new Sym('func', d.name, {
      node: fn, declNode: d, doc, tparams: fn.typeParams.map((t) => t.v), defScope: scope, owner: owner ? owner.owner : null,
      isStatic: owner ? owner.isStatic : false, selfType: owner ? owner.selfType : null, returns: [], visibleFrom: d.s, builtin: this.isPrelude,
    });
    if (owner) sym.isMethod = true;
    this.declare(scope, sym, d.nameTok);
    this.setupFunction(sym, fn, scope, owner ? owner.selfType : null, owner ? owner.owner : null);
    if (!owner) this.checkFunctionBody(sym);
    return sym;
  }

  declareClassMethod(m, owner, scope, selfType, overload, docText) {
    if (m.member === 'method') this.checkOperatorAttr(m.attrs, m.params.length, !m.attrs || !this.modsOf(m.attrs, 'method').has('static'));
    const isStatic = this.modsOf(m.attrs, 'method').has('static');
    const fnNode = { k: 'Func', typeParams: m.typeParams || [], params: m.params, ret: m.ret, body: m.body, s: m.s, e: m.e };
    const sym = new Sym(m.member === 'method' ? 'method' : m.member === 'constructor' ? 'ctor' : 'dtor', m.name, {
      node: fnNode, declNode: m, doc: docText !== undefined ? docText : this.docAt(m.attrs && m.attrs.length ? m.attrs[0].s : m.s), tparams: (m.typeParams || []).map((t) => t.v),
      defScope: scope, owner, isStatic, selfType, returns: [], attrs: m.attrs, visibleFrom: m.s, isMethod: true, builtin: this.isPrelude,
      abstract: !m.body,
    });
    sym.s = m.nameTok.s; sym.e = m.nameTok.e; sym.nameTok = m.nameTok;
    sym.uri = this.opts.uri; sym.analysis = this;
    if (!overload) this.decls.push({ s: sym.s, e: sym.e, sym });
    this.setupFunction(sym, fnNode, scope, isStatic ? null : selfType, owner);
    sym.fscope.memberCtx = { kind: m.member === 'method' ? 'method' : m.member, isStatic, owner };
    return sym;
  }

  setupFunction(sym, fn, scope, selfType, owner) {
    const fscope = this.newScope(scope, 'function', fn.s, fn.e);
    sym.fscope = fscope;
    fn.typeParams.forEach((tp) => this.declare(fscope, new Sym('tparam', tp.v, { type: T.param(tp.v), visibleFrom: 0 }), tp));
    if (selfType) {
      fscope.declare(new Sym('var', 'this', { type: selfType, isConst: true, visibleFrom: 0, isThis: true, owner }));
      sym.thisSym = fscope.syms.get('this');
      const parent = owner ? this.parentTypeOf(owner) : null;
      if (parent) fscope.declare(new Sym('var', 'super', { type: parent, isConst: true, visibleFrom: 0 }));
    }
    sym.params = fn.params.map((p) => {
      const type = this.resolveType(p.typeNode, fscope);
      const ps = new Sym('param', p.name, { type, def: p.default, variadic: p.variadic, visibleFrom: 0, paramNode: p });
      if (p.nameTok) this.declare(fscope, ps, p.nameTok);
      else fscope.declare(ps);
      if (p.default) this.inferExpr(p.default, fscope, type, this.ctx0);
      return { name: p.name, type, def: p.default, variadic: p.variadic, sym: ps };
    });
    sym.declRet = fn.ret ? this.resolveType(fn.ret, fscope) : null;
    if (!fn.body) sym.bodyDone = true;
    if (!fn.body && !sym.declRet) sym.ret = T.void;
    if (sym.kind === 'ctor' || sym.kind === 'dtor') sym.ret = T.void;
  }

  parentTypeOf(owner) {
    if (owner.extendsT && owner.extendsT[0]) return owner.extendsT[0];
    return null;
  }

  checkFunctionBody(sym) {
    if (sym.bodyDone || sym.bodyBusy) return;
    const fn = sym.node;
    if (!fn.body) { sym.bodyDone = true; return; }
    sym.bodyBusy = true;
    const ctx = { fn: sym, loops: 0 };
    sym.returns = [];
    const bscope = this.newScope(sym.fscope, 'block', fn.body.s, fn.body.e);
    this.checkStmts(fn.body.body, bscope, ctx, false);
    sym.bodyBusy = false;
    sym.bodyDone = true;
    if (!sym.declRet) {
      const rets = sym.returns.filter((t) => t && t.k !== 'void' && !isUnk(t));
      // every return gives the same function type
      const fnRets = rets.filter((t) => t.k === 'fn');
      if (fnRets.length > 1 && !this.isPrelude && !fnRets.every((t) => sameFn(t, fnRets[0]))) {
        const at = sym.nameTok || { s: fn.s, e: fn.s + 8 };
        this.diag(at.s, at.e, `${sym.name || 'the function'} returns functions of different types: ${[...new Set(fnRets.map(str))].join(' and ')}. Every return gives the same function type.`);
      }
      sym.ret = rets.length ? plain(rets[0]) : (sym.returns.length && sym.returns.every((t) => isUnk(t)) ? T.unk : T.void);
    }
    // a declared return type needs a value in every path: only the plain case is checked
    if (sym.declRet && sym.declRet.k !== 'void' && !this.isPrelude && !sym.returns.length && sym.kind !== 'ctor') {
      if (fn.body.body.length) this.diag(sym.nameTok ? sym.nameTok.s : fn.s, sym.nameTok ? sym.nameTok.e : fn.s + 1, `${sym.name} says it gives a ${str(sym.declRet)} but has no return`);
    }
  }

  // the return type, working it out from the body when it was not written
  retOf(sym) {
    if (sym.declRet) return sym.declRet;
    if (!sym.bodyDone) {
      if (sym.bodyBusy) return T.unk;
      this.checkFunctionBody(sym);
    }
    return sym.ret || T.void;
  }

  fnTypeOf(sym) {
    if (sym.kind === 'attribute') return T.fn(sym.params, T.void, []);
    const owner = sym.analysis || this;
    return T.fn(sym.params.map((p) => ({ name: p.name, type: p.type, def: p.def, variadic: p.variadic })), owner.retOf(sym), sym.tparams);
  }

  // the type of an accessor, and its two parts
  checkProperty(ps) {
    const m = ps.node;
    const body = ps.scopeFor;
    const mk = (blk, params, ptype) => {
      const sc = this.newScope(body, 'function', blk.s, blk.e);
      sc.memberCtx = { kind: 'accessor', isStatic: !!ps.isStatic, owner: ps.owner };
      const fnSym = { returns: [], declRet: null, kind: 'prop' };
      if (!ps.isStatic) sc.declare(new Sym('var', 'this', { type: ps.selfType, isConst: true, visibleFrom: 0, isThis: true }));
      const parent = ps.owner ? this.parentTypeOf(ps.owner) : null;
      if (parent && !ps.isStatic) sc.declare(new Sym('var', 'super', { type: parent, isConst: true, visibleFrom: 0 }));
      params.forEach((p) => this.declare(sc, new Sym('param', p.v, { type: ptype || T.unk, visibleFrom: 0 }), p));
      const bs = this.newScope(sc, 'block', blk.s, blk.e);
      this.checkStmts(blk.body, bs, { fn: fnSym, loops: 0 }, false);
      return fnSym;
    };
    let t = m.typeNode ? this.resolveType(m.typeNode, body) : null;
    ps.type = t || T.unk;
    if (m.getter) {
      const f = mk(m.getter.body, [], t);
      if (!t) {
        const r = f.returns.filter((x) => x && !isUnk(x));
        t = r.length ? plain(r[0]) : T.unk;
        ps.type = t;
      }
    }
    if (m.setter) mk(m.setter.body, m.setter.params, ps.type);
  }

  // ------------------------------------------------------------ members

  // Everything that can follow a dot on a value of this type: [{ name, kind, sym, type, owner, doc }]
  membersOfType(t) {
    const out = new Map();
    if (!t) return out;
    if (t.k === 'ptr') {
      out.set('at', { name: 'at', kind: 'method', type: T.fn([{ name: 'index', type: T.prim('usize') }], t), doc: 'The pointer to element i, without any check of the position.' });
      // a field is reached through a pointer to a struct without .*
      if (t.to && t.to.k === 'named') for (const [n, e] of this.membersOfType(t.to)) if (!out.has(n)) out.set(n, e);
      return out;
    }
    if (t.k === 'module') {
      for (const [n, s] of t.info.exports) out.set(n, { name: n, kind: s.kind === 'type' ? 'type' : s.kind, sym: s, type: this.typeOfSym(s), doc: s.doc });
      return out;
    }
    if (t.k !== 'named') return out;
    this.collectMembers(t, out, new Set(), false);
    return out;
  }

  collectMembers(t, out, seen, inherited) {
    const sym = t.sym;
    if (seen.has(sym)) return;
    seen.add(sym);
    const map = new Map();
    sym.tparams.forEach((n, i) => map.set(n, t.args[i] || T.param(n)));
    const add = (name, e) => { if (!out.has(name)) out.set(name, e); };
    for (const f of sym.fields) {
      if (f.isStatic) continue;
      add(f.name, { name: f.name, kind: 'field', sym: f, type: subst(this.fieldType(f), map), doc: f.doc, owner: sym });
    }
    for (const p of sym.props.values()) {
      if (p.isStatic) continue;
      add(p.name, { name: p.name, kind: 'property', sym: p, type: subst(p.type || T.unk, map), doc: p.doc, owner: sym });
    }
    for (const m of sym.methods.values()) {
      if (m.isStatic) continue;
      add(m.name, { name: m.name, kind: 'method', sym: m, type: this.methodType(m, map), doc: m.doc, owner: sym });
    }
    // parents: extends, then traits, then interfaces
    for (const list of [sym.extendsT || [], sym.usesT || [], sym.implementsT || []]) {
      for (const pt of list) {
        if (pt && pt.k === 'named') this.collectMembers(T.named(pt.sym, pt.args.map((a) => subst(a, map))), out, seen, true);
      }
    }
    if (!inherited) {
      if (sym.tkind === 'struct' && !sym.builtin && sym.kind !== 'variant' && sym.fields.length) {
        // a copy with some fields changed: clone(x = 5.0), every field may be named, the others are copied
        const params = sym.fields.filter((f) => !f.isStatic).map((f) => ({ name: f.name, type: subst(this.fieldType(f), map), def: true }));
        add('clone', { name: 'clone', kind: 'method', type: T.fn(params, t), doc: 'A separate copy. Name fields to change them in the copy: clone(x = 5.0).' });
      } else if (sym.tkind !== 'prim') add('clone', { name: 'clone', kind: 'method', type: T.fn([], t), doc: 'A separate copy.' });
      if ((sym.tkind === 'struct' || sym.tkind === 'union' || sym.kind === 'variant') && !sym.builtin) {
        add('raw', { name: 'raw', kind: 'method', type: T.fn([], T.ptr(T.prim('u8'))), doc: 'Where the fields are, in C layout.' });
      }
      if (sym.tkind === 'class' || sym.tkind === 'trait' || sym.tkind === 'interface') {
        const anyT = this.prelude('Any');
        if (!out.has('is')) add('is', { name: 'is', kind: 'method', type: T.fn([], T.prim('bool'), ['U']), doc: 'True when the value is of the class U: value.is<U>().' });
        if (!out.has('as')) add('as', { name: 'as', kind: 'method', type: T.fn([], T.named(this.prelude('Optional'), [T.param('U')]), ['U']), doc: 'Some when the value is of the class U: value.as<U>().' });
        void anyT;
      }
    }
  }

  // the type of a method; a method with overloads carries the type of each form
  methodType(m, map) {
    const ft = map ? subst(this.fnTypeOf(m), map) : this.fnTypeOf(m);
    if (m.overloads && m.overloads.length > 1) ft.overloads = m.overloads.map((o) => ({ sym: o, type: map ? subst(this.fnTypeOf(o), map) : this.fnTypeOf(o) }));
    return ft;
  }

  fieldType(f) {
    if (f.type) return f.type;
    f.type = T.unk;
    f.type = f.analysis ? f.analysis.resolveType(f.typeNode, f.scopeFor) : this.resolveType(f.typeNode, f.scopeFor);
    return f.type;
  }

  // what follows a dot on the name of a type: enum members, variants, static methods
  staticMembers(sym) {
    const out = new Map();
    if (sym.tkind === 'enum') {
      for (const m of sym.enumMembers.values()) out.set(m.name, { name: m.name, kind: 'enumMember', sym: m, type: T.named(sym), doc: m.doc });
    }
    if (sym.tkind === 'union') {
      for (const v of sym.variants.values()) out.set(v.name, { name: v.name, kind: 'variant', sym: v, type: T.typeref(v), doc: v.doc });
    }
    // static members of a class, also the ones it gets from the classes it extends and the traits it uses
    const seen = new Set();
    const addStatics = (s) => {
      if (!s || seen.has(s)) return;
      seen.add(s);
      for (const m of s.methods.values()) if (m.isStatic && !out.has(m.name)) out.set(m.name, { name: m.name, kind: 'method', sym: m, type: (s.analysis || this).methodType(m), doc: m.doc });
      for (const f of s.fields) if (f.isStatic && !out.has(f.name)) out.set(f.name, { name: f.name, kind: 'field', sym: f, type: (s.analysis || this).fieldType(f), doc: f.doc });
      for (const p of s.props.values()) if (p.isStatic && !out.has(p.name)) out.set(p.name, { name: p.name, kind: 'property', sym: p, type: p.type || T.unk, doc: p.doc });
      for (const list of [s.extendsT || [], s.usesT || []]) for (const pt of list) if (pt && pt.k === 'named') addStatics(pt.sym);
    };
    addStatics(sym);
    if ((sym.tkind === 'struct' || sym.tkind === 'union') && !sym.builtin) {
      out.set('fromRaw', { name: 'fromRaw', kind: 'method', type: T.fn([{ name: 'pointer', type: T.ptr(T.prim('u8')) }], T.named(sym, sym.tparams.map((n) => T.param(n)))), doc: 'A new value copied from an address in C layout.' });
    }
    return out;
  }

  typeOfSym(sym) {
    if (!sym) return T.unk;
    const a = sym.analysis || this;
    switch (sym.kind) {
      case 'var': case 'param': return sym.type || T.unk;
      case 'func': case 'method': return a.fnTypeOf(sym);
      case 'attribute': return a.fnTypeOf(sym);
      case 'type': return sym.tkind === 'alias' ? (sym.target && sym.target.k === 'named' ? T.typeref(sym.target.sym) : T.unk) : T.typeref(sym);
      case 'variant': return T.typeref(sym);
      case 'tparam': return T.unk;
      case 'field': return a.fieldType(sym);
      case 'property': return sym.type || T.unk;
      case 'enumMember': return T.named(sym.owner);
      default: return T.unk;
    }
  }

  // ------------------------------------------------------------ expressions

  numType(v, expected) {
    const isFloat = !/^0[xXbBoO]/.test(v) && /[.eE]/.test(v);
    if (isFloat) {
      if (expected && expected.k === 'prim' && FLOATS.includes(expected.n)) return T.prim(expected.n);
      return T.prim('f64', true);
    }
    // a whole number never becomes a float: it keeps being an integer literal, and the mismatch is reported
    if (expected && expected.k === 'prim' && INTS.includes(expected.n)) return T.prim(expected.n, true);
    return T.prim('i32', true);
  }

  stringType() { const s = this.prelude('String'); return s ? T.named(s) : T.unk; }

  inferExpr(node, scope, expected, ctx, asCallee) {
    const ty = this.infer0(node, scope, expected, ctx || this.ctx0, asCallee);
    node.ty = ty;
    node.scope = scope;
    this.exprs.push(node);
    return ty;
  }

  infer0(node, scope, expected, ctx, asCallee) {
    switch (node.k) {
      case 'Num': return this.numType(node.v, expected);
      case 'Str': return this.stringType();
      case 'Char': return T.prim('char');
      case 'Bool': return T.prim('bool');
      case 'Null': return T.nul;
      case 'Paren': return this.inferExpr(node.expr, scope, expected, ctx);
      case 'Tuple': {
        const sym = this.prelude('Tuple');
        const exp = expected && expected.k === 'named' && expected.sym === sym ? expected.args : [];
        const types = node.items.map((it, i) => plain(this.inferExpr(it, scope, exp[i], ctx)));
        return sym ? T.named(sym, types) : T.unk;
      }
      case 'StructBlock': return this.inferStructBlock(node, scope, expected, ctx);
      case 'ListLit': case 'ArrayLit': return this.inferCollection(node, scope, expected, ctx);
      case 'Ident': return this.inferIdent(node, scope, expected, ctx, asCallee);
      case 'Unary': {
        const t = this.inferExpr(node.expr, scope, node.op === '&' ? null : expected, ctx);
        if (node.op === '!') return T.prim('bool');
        if (node.op === '&') return T.ptr(plain(t));
        return t;
      }
      case 'Deref': {
        const t = this.inferExpr(node.obj, scope, null, ctx);
        return t && t.k === 'ptr' ? t.to : T.unk;
      }
      case 'Binary': return this.inferBinary(node, scope, expected, ctx);
      case 'Call': return this.inferCall(node, scope, expected, ctx);
      case 'Member': return this.inferMember(node, scope, expected, ctx, asCallee);
      case 'Func':
        if (node.isMethod) this.diag(node.s, node.s + 6, 'a method is written inside a class, interface or trait');
        return this.inferAnonymousFunc(node, scope, ctx);
      case 'TypeHead': case 'AttrHead': return T.unk;
      default: return T.unk;
    }
  }

  inferAnonymousFunc(node, scope, ctx) {
    const sym = new Sym('func', '', { node, tparams: node.typeParams.map((t) => t.v), defScope: scope, returns: [], analysis: this });
    this.setupFunction(sym, node, scope, null, null);
    this.checkFunctionBody(sym);
    return this.fnTypeOf(sym);
  }

  inferCollection(node, scope, expected, ctx) {
    const isList = node.k === 'ListLit';
    const sym = this.prelude(isList ? 'List' : 'Array');
    const expSym = expected && expected.k === 'named' && expected.sym === sym ? expected : null;
    const expElem = expSym ? expSym.args[0] : null;
    let elem = null;
    for (const it of node.items) {
      const t = this.inferExpr(it, scope, expElem || (elem && elem.k !== 'unk' ? elem : null), ctx);
      // each element must fit the element type that is asked for: Array<i32> takes numbers, not 'f'
      if (expElem && !hasParam(expElem)) this.checkCompatible(expElem, t, it);
      if (!elem || (elem.k === 'prim' && elem.lit && !(t && t.k === 'prim' && t.lit))) elem = t;
    }
    const result = elem && !isUnk(elem) ? plain(elem) : (expElem || T.unk);
    // an element given a literal takes the declared element type when there is one
    if (expElem && elem && elem.k === 'prim' && elem.lit && expElem.k === 'prim') return T.named(sym, [expElem]);
    return sym ? T.named(sym, [result]) : T.unk;
  }

  inferIdent(node, scope, expected, ctx, asCallee) {
    const name = node.name;
    if (name === 'throw') return T.unk;
    let sym = scope.lookup(name);
    if (!sym && (name === 'this' || name === 'super')) {
      const mc = this.memberCtxOf(scope);
      if (mc && mc.isStatic) this.diag(node.s, node.e, `a static ${mc.kind} belongs to the class and has no ${name}`);
      return T.unk;
    }
    if (sym) {
      this.ref(node, sym);
      this.markCaptured(sym, scope);
      if (sym.kind === 'var' && sym.module) return T.module(sym.module);
      let t = this.typeOfSym(sym);
      if (node.typeArgs) {
        const args = node.typeArgs.map((a) => this.resolveType(a, scope));
        if (t.k === 'typeref') return { k: 'typeref', sym: t.sym, args };
        if (t.k === 'fn') return this.bindExplicit(t, args);
      }
      // a generic function used as a value needs its type filled in: identity<i32>, or taken from the type that the target expects
      if (t && t.k === 'fn' && t.tparams && t.tparams.length && !asCallee && !node.typeArgs && sym.kind === 'func' && !sym.builtin && !this.isPrelude) {
        if (expected && expected.k === 'fn' && !hasParam(expected)) {
          const b = new Map();
          unify(t, expected, b, t.tparams);
          return this.bindExplicit(t, t.tparams.map((n) => b.get(n) || T.unk));
        }
        this.diag(node.s, node.e, `${name} is generic and has no single type: write ${name}<${t.tparams.join(', ')}> with the types filled in`);
        return T.unk;
      }
      return t;
    }
    if (PRIMS.has(name) || name === 'ptr') {
      const args = (node.typeArgs || []).map((a) => this.resolveType(a, scope));
      return { k: 'typeref', sym: this.primSyms[name], args };
    }
    if (!KEYWORDS.has(name) && !this.isPrelude) {
      this.diag(node.s, node.e, `${name} is not declared. Declare it before use with const, let or a type.`);
    }
    return T.unk;
  }

  // a variable, parameter or loop name that a nested function (or a block given to a call) uses is captured:
  // the closure shares it, so it lives on the heap for as long as a closure uses it
  markCaptured(sym, scope) {
    if ((sym.kind !== 'var' && sym.kind !== 'param') || sym.isThis || this.isPrelude) return;
    let declScope = null;
    for (let sc = scope; sc; sc = sc.parent) {
      if (sc.syms.get(sym.name) === sym) { declScope = sc; break; }
    }
    if (!declScope) return;
    const fnOf = (sc) => { for (; sc; sc = sc.parent) { if (sc.kind === 'function') return sc; if (sc.kind === 'file' || sc.kind === 'builtin' || sc.kind === 'type') return null; } return null; };
    const owner = fnOf(declScope);
    const user = fnOf(scope);
    if (owner && user && owner !== user) sym.captured = true;
  }

  // the method or accessor whose body the scope is in
  memberCtxOf(scope) {
    for (let sc = scope; sc; sc = sc.parent) {
      if (sc.memberCtx) return sc.memberCtx;
      if (sc.kind === 'type' || sc.kind === 'file' || sc.kind === 'builtin') break;
    }
    return null;
  }

  bindExplicit(fnType, args) {
    const map = new Map();
    fnType.tparams.forEach((n, i) => { if (args[i]) map.set(n, args[i]); });
    const r = subst(fnType, map);
    return T.fn(r.params, r.ret, fnType.tparams.filter((n) => !map.has(n)));
  }

  inferBinary(node, scope, expected, ctx) {
    const op = node.op;
    const cmp = ['==', '!=', '<', '<=', '>', '>=', '&&', '||'].includes(op);
    const l = this.inferExpr(node.left, scope, cmp ? null : expected, ctx);
    const rExpected = l && l.k === 'prim' && !l.lit ? l : null;
    const r = this.inferExpr(node.right, scope, rExpected, ctx);
    if (cmp) {
      this.checkOperands(node, l, r);
      return T.prim('bool');
    }
    this.checkOperands(node, l, r);
    if (l && l.k === 'prim' && l.lit && r && r.k === 'prim' && !r.lit) return r;
    if (l && l.k === 'named' && r && r.k !== 'prim') return l;
    return isUnk(l) ? r : l;
  }

  // both sides of an operator must have the same type: report only what is certain
  checkOperands(node, l, r) {
    // a value of a type parameter has only what every type has: it can be passed around, stored and compared with == and !=
    const tp = (l && l.k === 'param') ? l : (r && r.k === 'param') ? r : null;
    if (tp && !this.isPrelude && node.op !== '==' && node.op !== '!=') {
      this.diag(node.s, node.e, `${tp.name} is a type parameter and may not have ${node.op}: a generic type has no constraints, take a function as a parameter instead`);
      return;
    }
    if ((l && l.k === 'fn') || (r && r.k === 'fn')) {
      if (isUnk(l) || isUnk(r) || this.isPrelude) return;
      if (node.op === '==' || node.op === '!=') {
        if (!(l.k === 'fn' && r.k === 'fn')) this.diag(node.s, node.e, `${str(l)} and ${str(r)} cannot be compared: a function is only compared with a function`);
        else if (!sameFn(l, r)) this.diag(node.s, node.e, `${str(l)} and ${str(r)} are different function types, so they cannot be compared`);
      } else {
        this.diag(node.s, node.e, `${node.op} does not work on functions, only == and != do`);
      }
      return;
    }
    if (!l || !r || l.k !== 'prim' || r.k !== 'prim') return;
    if (l.lit && r.lit) {
      if (FLOATS.includes(l.n) !== FLOATS.includes(r.n)) this.diag(node.s, node.e, 'a whole number is never a float, write the whole number as a decimal like 2.0');
      return;
    }
    if (l.lit && !r.lit) { this.checkLiteralFits(l, r, node.left); return; }
    if (r.lit && !l.lit) { this.checkLiteralFits(r, l, node.right); return; }
    if (l.n !== r.n) this.diag(node.s, node.e, `${l.n} and ${r.n} cannot be mixed, convert one first`);
  }

  checkLiteralFits(lit, target, node) {
    const litFloat = FLOATS.includes(lit.n);
    const tFloat = FLOATS.includes(target.n);
    if (litFloat && !tFloat && target.n !== 'bool' && target.n !== 'char') this.diag(node.s, node.e, `a decimal literal is never ${target.n}, write a whole number`);
    else if (!litFloat && tFloat) this.diag(node.s, node.e, `a whole number is never a float, write ${node.k === 'Num' ? node.v + '.0' : 'a decimal'}`);
    else if (!litFloat && INTS.includes(target.n)) this.checkIntRange(node, target.n);
  }

  checkIntRange(node, type) {
    let n = node;
    let neg = false;
    if (n.k === 'Unary' && n.op === '-' && n.expr.k === 'Num') { neg = true; n = n.expr; }
    if (n.k !== 'Num' || /[.]/.test(n.v) || (!/^0[xX]/.test(n.v) && /[eE]/.test(n.v))) return;
    let v;
    try { v = BigInt(n.v.replace(/_/g, '').replace(/^0[oO]/, '0o')); } catch (e) { return; }
    if (neg) v = -v;
    const bits = type === 'isize' || type === 'usize' ? 64 : parseInt(type.slice(1), 10);
    const signed = type[0] === 'i';
    const max = signed ? (1n << BigInt(bits - 1)) - 1n : (1n << BigInt(bits)) - 1n;
    const min = signed ? -(1n << BigInt(bits - 1)) : 0n;
    if (v > max || v < min) this.diag(node.s, node.e, `${neg ? '-' : ''}${n.v} does not fit in ${type}`);
  }

  // ------------------------------------------------------------ member access

  inferMember(node, scope, expected, ctx, asCallee) {
    const objT = this.inferExpr(node.obj, scope, null, ctx, false);
    if (node.incomplete || !node.nameTok) return T.unk;
    const name = node.name;
    const tok = node.nameTok;
    const refMember = (sym) => {
      if (!sym) return;
      node.sym = sym;
      this.refs.push({ s: tok.s, e: tok.e, sym, node });
      // an accessor with no get cannot be read, only assigned with =
      if (sym.kind === 'property' && sym.node && sym.node.setter && !sym.node.getter && node !== this.writeTarget && !this.isPrelude) {
        this.diag(tok.s, tok.e, `${name} has no get, it is write-only`);
      }
    };
    if (objT && objT.k === 'param' && !this.isPrelude && node.nameTok) {
      this.diag(node.nameTok.s, node.nameTok.e, `${objT.name} is a type parameter and has no member ${name}: a generic type has no constraints, take a function as a parameter instead`);
      return T.unk;
    }
    if (!objT || objT.k === 'unk' || objT.k === 'param' || objT.k === 'void' || objT.k === 'null') return T.unk;
    if (objT.k === 'typeref') {
      const sym = objT.sym;
      const st = this.staticMembers(sym);
      const e = st.get(name);
      if (!e) {
        const kinded = ['class', 'interface', 'trait'].includes(sym.tkind);
        const inst = kinded && !this.isPrelude ? this.membersOfType(T.named(sym, sym.tparams.map((n) => T.param(n)))).get(name) : null;
        if (inst) {
          const mc = this.memberCtxOf(scope);
          if (mc && mc.isStatic) this.diag(tok.s, tok.e, `a static ${mc.kind} cannot use the instance member ${name}`);
          else this.diag(tok.s, tok.e, `${name} is not static, use it on a value of ${sym.name}`);
          return T.unk;
        }
        if (sym.tkind !== 'prim' && (sym.tkind !== 'class' || sym.builtin) && !this.isPrelude) this.diag(tok.s, tok.e, `${sym.name} has no member ${name}`);
        return T.unk;
      }
      refMember(e.sym);
      if (e.kind === 'field' || e.kind === 'property') {
        // an accessor that works with a static field must be static itself
        const mc = this.memberCtxOf(scope);
        if (mc && mc.kind === 'accessor' && !mc.isStatic && e.kind === 'field' && mc.owner && e.sym.owner === mc.owner) this.diag(tok.s, tok.e, `${name} is static, so the accessor that reads or assigns it must be static too: [accessor(static)]`);
      }
      if (e.kind === 'variant') {
        const v = e.sym;
        const targs = objT.args || [];
        if (asCallee) return { k: 'typeref', sym: v, args: targs };
        // a variant with no fields is a value
        if (!v.fields.length) {
          const ownerArgs = this.ownerArgs(v.owner, targs, expected);
          return T.named(v.owner, ownerArgs);
        }
        return { k: 'typeref', sym: v, args: targs };
      }
      if (e.kind === 'enumMember') return T.named(sym);
      return e.type;
    }
    if (objT.k === 'module') {
      const s = objT.info.exports.get(name);
      if (!s) { this.diag(tok.s, tok.e, `${name} is not exported by that module`); return T.unk; }
      refMember(s);
      const a = s.analysis || this;
      if (s.kind === 'var' && s.module) return T.module(s.module);
      return a.typeOfSym(s);
    }
    const members = this.membersOfType(objT);
    const e = members.get(name);
    if (!e) {
      if (objT.k === 'named' && !this.isPrelude && this.staticMembers(objT.sym).has(name) && ['class', 'interface', 'trait'].includes(objT.sym.tkind)) {
        this.diag(tok.s, tok.e, `${name} is static, use it on the class: ${objT.sym.name}.${name}`);
        return T.unk;
      }
      if (objT.k === 'named' && !this.isPrelude && this.isKnownShape(objT.sym) && !(objT.sym.name === 'Tuple' && objT.sym.builtin && false)) {
        this.diag(tok.s, tok.e, `${str(objT)} has no field or method ${name}`);
      }
      return T.unk;
    }
    refMember(e.sym);
    node.member = e;
    return e.type;
  }

  isKnownShape(sym) {
    // a type whose members are all known: not a parameter, and not a class that extends something unresolved
    if (sym.tkind === 'prim') return false;
    const parents = [...(sym.extendsT || []), ...(sym.usesT || []), ...(sym.implementsT || [])];
    return parents.every((p) => p && p.k === 'named');
  }

  ownerArgs(owner, explicit, expected) {
    if (explicit && explicit.length) return explicit;
    if (expected && expected.k === 'named' && expected.sym === owner) return expected.args;
    return owner.tparams.map(() => T.unk);
  }

  // ------------------------------------------------------------ calls

  // the key of a Map is a primitive value or a String: a struct, a class, a collection, an enum or a union is not
  checkMapKey(t, s, e) {
    if (this.isPrelude || !t || isUnk(t)) return;
    if (t.k === 'prim' || t.k === 'ptr' || t.k === 'param') return;
    if (t.k === 'named' && t.sym.builtin && t.sym.name === 'String') return;
    this.diag(s, e, `a Map key is a primitive value or a String, not ${str(t)}: key by a String or a number built from the fields`);
  }

  // String.format("...%d...", values): the specifiers are checked against the values when the format is a literal, as printf
  checkFormat(node, scope, ctx) {
    const first = node.args[0] && node.args[0].value;
    if (!first || first.k !== 'Str') return;
    const text = first.v.replace(/^"/, "").replace(/"$/, "");
    const re = /%([-+ #0]*)(\d+|\*)?(?:\.(\d+|\*))?(hh|h|ll|l|z|j|t|L)?(.)?/g;
    const need = [];
    let m;
    while ((m = re.exec(text))) {
      const conv = m[5];
      if (!conv) { this.diag(first.s, first.e, 'the format ends after a %'); return; }
      if (conv === '%') continue;
      if (!'diuoxXfFeEgGcsp'.includes(conv)) { this.diag(first.s, first.e, `%${conv} is not a format: use d u x X o c f e g s p or %%`); return; }
      if (m[2] === '*') need.push({ conv: '*', what: 'a width' });
      if (m[3] === '*') need.push({ conv: '*', what: 'a precision' });
      need.push({ conv });
    }
    const args = node.args.slice(1);
    if (args.length !== need.length) {
      this.diag(node.s, node.e, `the format has ${need.length} value${need.length === 1 ? '' : 's'} but ${args.length} ${args.length === 1 ? 'was' : 'were'} given`);
      return;
    }
    const INTS_ = ['i8', 'i16', 'i32', 'i64', 'i128', 'isize', 'u8', 'u16', 'u32', 'u64', 'u128', 'usize'];
    need.forEach((n, i) => {
      const a = args[i].value;
      const t = a.ty;
      if (!t || isUnk(t)) return;
      const isStr = t.k === 'named' && t.sym.builtin && t.sym.name === 'String';
      let ok = true; let want = '';
      if (n.conv === '*' || 'diuoxX'.includes(n.conv)) { ok = t.k === 'prim' && INTS_.includes(t.n); want = 'an integer'; }
      else if ('fFeEgG'.includes(n.conv)) { ok = t.k === 'prim' && FLOATS.includes(t.n); want = 'a float'; }
      else if (n.conv === 'c') { ok = t.k === 'prim' && t.n === 'char'; want = 'a char'; }
      else if (n.conv === 's') { ok = isStr; want = 'a String'; }
      else if (n.conv === 'p') { ok = t.k === 'ptr'; want = 'a pointer'; }
      if (!ok) this.diag(a.s, a.e, `${n.conv === '*' ? `the * for ${n.what}` : '%' + n.conv} needs ${want}, but this is ${str(t)}`);
    });
  }

  // the built-in Error, or a class that implements it (also through the classes it extends)
  isErrorType(t) {
    if (!t || t.k !== 'named') return false;
    const seen = new Set();
    const walk = (sym) => {
      if (!sym || seen.has(sym)) return false;
      seen.add(sym);
      if (sym.builtin && (sym.name === 'Error' || sym.name === 'IError')) return true;
      for (const list of [sym.implementsT || [], sym.extendsT || [], sym.usesT || []]) for (const x of list) if (x && x.k === 'named' && walk(x.sym)) return true;
      return false;
    };
    return walk(t.sym);
  }

  inferCall(node, scope, expected, ctx) {
    this.calls.push(node);
    const callee = node.callee;
    if (callee.k === 'Ident' && callee.name === 'throw') {
      node.args.forEach((a) => {
        const at = this.inferExpr(a.value, scope, null, ctx);
        if (at && !isUnk(at) && !this.isPrelude && !this.isErrorType(at)) this.diag(a.value.s, a.value.e, 'only an Error, or an object of a class that implements IError, can be thrown: Error(message = ..., code = ...)');
      });
      return T.void;
    }
    if (callee.k === 'Ident' && callee.name === 'super') {
      const sup = scope.lookup('super');
      node.args.forEach((a) => this.inferExpr(a.value, scope, null, ctx));
      if (sup && sup.type && sup.type.k === 'named') { callee.ty = T.typeref(sup.type.sym); }
      return T.void;
    }
    if (callee.k === 'Ident' && callee.name === 'typeof' && scope.lookup('typeof') && scope.lookup('typeof').builtin) {
      const at = node.args[0] ? this.inferExpr(node.args[0].value, scope, null, ctx) : T.unk;
      const sym0 = scope.lookup('typeof');
      this.ref(callee, sym0);
      const p = plain(at);
      if (p && p.k === 'prim') return { k: 'typeref', sym: this.primSyms[p.n], args: [] };
      return p && p.k === 'named' ? { k: 'typeref', sym: p.sym, args: p.args } : T.unk;
    }
    // import("./path")
    if (callee.k === 'Ident' && callee.name === 'import' && scope.lookup('import') && scope.lookup('import').builtin) return this.inferImport(node, scope, ctx);
    let ct = this.inferExpr(callee, scope, null, ctx, true);
    if (ct && ct.k === 'fn' && ct.overloads) {
      const chosen = this.chooseOverload(ct, node, scope, ctx);
      if (!chosen) return T.unk;
      ct = chosen;
      callee.ty = chosen;
    }
    if (node.parenless && ct && !isUnk(ct) && !['fn', 'typeref', 'param', 'void'].includes(ct.k) && !this.isPrelude) {
      this.diag(callee.s, callee.e, `${callee.name || 'this'} is not a function, it cannot take ${node.args.length ? 'an argument' : 'a block'}`);
    }
    const explicit = node.typeArgs ? node.typeArgs.map((a) => this.resolveType(a, scope)) : (ct && ct.args) || [];
    if (ct && ct.k === 'typeref') return this.construct(ct, explicit, node, scope, expected, ctx);
    if (ct && ct.k === 'fn') return this.callFn(ct, explicit, node, scope, expected, ctx);
    node.args.forEach((a) => this.inferExpr(a.value, scope, null, ctx));
    if (node.block) this.checkTrailingBlock(node.block, null, scope, ctx);
    return T.unk;
  }

  // a method written with overloads: the form whose parameters fit the arguments
  chooseOverload(ct, node, scope, ctx) {
    const i = this.pickOverload(ct.overloads.map((o) => o.type.params), node, scope);
    if (i < 0) {
      const name = node.callee.name || 'the method';
      this.diag(node.s, node.e, `no form of ${name} takes these arguments. It has ${ct.overloads.map((o) => `(${o.type.params.map((p) => str(p.type)).join(', ')})`).join(', ')}`);
      node.args.forEach((a) => this.inferExpr(a.value, scope, null, ctx));
      return null;
    }
    const o = ct.overloads[i];
    if (o.sym) node.callee.sym = o.sym;
    return { ...o.type, overloads: undefined };
  }

  // the index of the parameter list that fits the call best, or -1
  pickOverload(paramLists, node, scope) {
    let best = -1;
    let bestScore = -1;
    paramLists.forEach((params, i) => {
      const { pairs, used } = this.mapArgs(params, node);
      if (pairs.some((p) => !p.param)) return;
      if (node.block) { if (!params.length) return; used.add(params.length - 1); }
      if (params.some((p, j) => !used.has(j) && !p.def && !p.variadic)) return;
      let score = 1;
      for (const { arg, param } of pairs) {
        const v = this.fits(param.type, arg.value, scope);
        if (v === false) return;
        if (v === true) score += 2;
      }
      score -= params.length * 0.01;
      if (score > bestScore) { best = i; bestScore = score; }
    });
    return best;
  }

  // does the argument fit the parameter type: true, false, or null when it is not known without typing it
  fits(type, arg, scope) {
    const t = this.peekType(arg, scope);
    if (!t || isUnk(t) || !type || isUnk(type) || hasParam(type)) return null;
    if (type.k === 'named' && type.sym.name === 'Any' && type.sym.builtin) return true;
    if (type.k === 'prim' && t.k === 'prim') {
      if (t.lit) return FLOATS.includes(t.n) ? FLOATS.includes(type.n) : INTS.includes(type.n);
      return t.n === type.n;
    }
    if (type.k === 'named' && t.k === 'named') return type.sym === t.sym || this.assignable(type, t);
    if ((type.k === 'prim' && t.k === 'named') || (type.k === 'named' && t.k === 'prim')) return false;
    return null;
  }

  // the type of an argument without recording anything: only what is plain to see
  peekType(node, scope) {
    switch (node.k) {
      case 'Num': return this.numType(node.v, null);
      case 'Str': return this.stringType();
      case 'Char': return T.prim('char');
      case 'Bool': return T.prim('bool');
      case 'Paren': return this.peekType(node.expr, scope);
      case 'Unary': return node.op === '-' ? this.peekType(node.expr, scope) : null;
      case 'Ident': {
        const s = scope.lookup(node.name);
        return s && (s.kind === 'var' || s.kind === 'param') ? s.type : null;
      }
      case 'Call': {
        if (node.callee.k !== 'Ident') return null;
        const s = scope.lookup(node.callee.name);
        return s && s.kind === 'type' && s.tkind !== 'alias' && s.tkind !== 'prim' && !s.tparams.length ? T.named(s) : null;
      }
      default: return null;
    }
  }

  inferImport(node, scope, ctx) {
    const arg = node.args[0];
    if (arg) this.inferExpr(arg.value, scope, null, ctx);
    const sym = scope.lookup('import');
    if (sym) this.ref(node.callee, sym);
    const mod = T.unk;
    if (arg && arg.value.k !== 'Str') this.diag(arg.value.s, arg.value.e, 'import takes a path or a library name written in the code, as a String literal: a file is found while the program is built');
    if (!arg || arg.value.k !== 'Str') return mod;
    const path = arg.value.v.slice(1, -1);
    const loader = this.opts.loadModule;
    if (!loader) return mod;
    const loaded = loader(path, this.opts.uri);
    if (!loaded) {
      const isPath = /^\.{0,2}\//.test(path);
      this.diag(arg.value.s, arg.value.e, isPath ? `there is no file ${path}.raga` : `there is no library ${path}: looked in raga.project, the libraries folder and the standard location`);
      return mod;
    }
    if (loaded.cycle || (loaded.analysis && loaded.analysis.diags.some((d) => /import each other/.test(d.message)))) {
      this.diag(arg.value.s, arg.value.e, 'modules cannot import each other, directly or through a third file');
      return mod;
    }
    const info = { path, exports: loaded.exports, uri: loaded.uri, analysis: loaded.analysis };
    arg.value.importTarget = loaded.uri;
    return T.module(info);
  }

  stringTypeModule() { const m = this.prelude('Module'); return m ? T.named(m) : T.unk; }

  // arguments in the order of the parameters
  mapArgs(params, node) {
    const pairs = [];
    const used = new Set();
    let pos = 0;
    for (const a of node.args) {
      let idx = -1;
      if (a.name) idx = params.findIndex((p) => p.name === a.name);
      else {
        while (pos < params.length && used.has(pos) && !params[pos].variadic) pos++;
        idx = pos < params.length ? pos : (params.length && params[params.length - 1].variadic ? params.length - 1 : -1);
        if (idx >= 0 && !params[idx].variadic) pos = idx + 1;
      }
      if (idx >= 0) used.add(idx);
      pairs.push({ arg: a, param: idx >= 0 ? params[idx] : null, idx });
    }
    return { pairs, used };
  }

  callFn(fn, explicit, node, scope, expected, ctx) {
    const names = fn.tparams;
    const bindings = new Map();
    explicit.forEach((t, i) => { if (names[i]) bindings.set(names[i], t); });
    let params = fn.params;
    const blockParam = node.block && params.length ? params[params.length - 1] : null;
    // a block is the last argument written after the parentheses: a function, an Array or a struct
    if (blockParam && !this.isPrelude && this.lastIsGiven(params, node)) {
      const lastName = blockParam.name ? ` ${blockParam.name}` : '';
      this.diag(node.block.s, node.block.s + 1, `the last parameter${lastName} is already given inside the parentheses, so this block would be one argument too many`);
      node = Object.assign(Object.create(Object.getPrototypeOf(node)), node, { blockArg: true, blockSkipped: true });
    } else if (blockParam && blockParam.type.k !== 'fn') node = this.dataBlockCall(node, blockParam, scope);
    const { pairs, used } = this.mapArgs(params, node);
    if (node.blockSkipped) used.add(params.length - 1);
    const calleeSym = node.callee.sym;
    // arguments in the order written
    for (const { arg, param } of pairs) {
      const exp = param ? subst(param.type, bindings) : null;
      const at = this.inferExpr(arg.value, scope, exp && !hasParam(exp, names) ? exp : null, ctx);
      // two arguments of one type parameter must have one type: Math.max(1, 2.5) mixes a whole number and a float
      if (param && param.type.k === 'param' && names.includes(param.type.name) && bindings.has(param.type.name) && !this.isPrelude) {
        const prev = bindings.get(param.type.name);
        if (prev && at && prev.k === 'prim' && at.k === 'prim') {
          const kindOf = (t) => (FLOATS.includes(t.n) ? 'float' : 'whole');
          if (prev.lit && at.lit && kindOf(prev) !== kindOf(at)) this.diag(arg.value.s, arg.value.e, `${param.type.name} is ${prev.n} here, but this is ${at.n}: both arguments must have the same type, write ${prev.n === 'i32' ? 'a whole number' : 'a decimal'} or convert`);
          else if (!prev.lit && !at.lit && prev.n !== at.n) this.diag(arg.value.s, arg.value.e, `${param.type.name} is ${prev.n} here, but this is ${at.n}: both arguments must have the same type`);
        }
      }
      if (param && names.length) unify(param.type, at, bindings, names);
      const checked = calleeSym ? true : (node.callee.k === 'Call' || (node.callee.k === 'Member' && node.callee.member && node.callee.member.name === 'clone' && !!node.callee.member.type.params.length));
      if (param && !hasParam(param.type) && checked) this.checkCompatible(param.type, at, arg.value);
      if (!arg.name && !calleeSym && node.callee.k === 'Member' && node.callee.member && node.callee.member.name === 'clone' && node.callee.member.type.params.length) {
        this.diag(arg.value.s, arg.value.e, 'clone takes the names of the fields to change: write p.clone(x = 5.0)');
      }
      if (arg.name && !param && checked && !(calleeSym && calleeSym.kind === 'tparam')) this.diag(arg.nameTok.s, arg.nameTok.e, `there is no parameter ${arg.name}`);
    }
    if (calleeSym && calleeSym.builtin && !this.isPrelude && ((calleeSym.name === 'format' && calleeSym.owner && calleeSym.owner.name === 'String') || calleeSym.name === '$')) this.checkFormat(node, scope, ctx);
    if (node.block && blockParam && blockParam.type.k === 'fn') {
      const bt = subst(blockParam.type, bindings);
      const ret = this.checkTrailingBlock(node.block, bt, scope, ctx);
      if (names.length && blockParam.type.ret) unify(blockParam.type.ret, ret, bindings, names);
      used.add(params.length - 1);
    } else if (node.block && !node.blockArg) {
      this.checkTrailingBlock(node.block, null, scope, ctx);
    }
    this.checkArgCount(fn, node, params, used, calleeSym || (node.callee.k === 'Call' ? { name: 'the returned function', kind: 'func' } : null));
    let ret = fn.ret || T.void;
    if (hasParam(ret, names) && expected) unify(ret, expected, bindings, names);
    ret = subst(ret, bindings);
    ret = this.dropFree(ret, names);
    const callee = node.callee;
    // Tuple.get(slot)
    if (callee.k === 'Member' && callee.obj.ty && callee.obj.ty.k === 'named' && callee.obj.ty.sym.name === 'Tuple' && callee.obj.ty.sym.builtin) {
      if (callee.name === 'get') {
        const a = node.args[0] && node.args[0].value;
        if (a && a.k === 'Num') ret = callee.obj.ty.args[Number(a.v)] || T.unk;
        else if (a && a.k === 'Ident') {
          const s = scope.lookup(a.name);
          const d = s && s.declNode;
          if (d && d.kind === 'const' && d.init && d.init.k === 'Num') ret = callee.obj.ty.args[Number(d.init.v)] || T.unk;
          else if (a && !this.isPrelude) { this.diag(a.s, a.e, 'the slot of a Tuple is a literal, so the type of the result is known'); ret = T.unk; }
        } else ret = T.unk;
      }
    }
    if (callee.k === 'Member' && callee.name === 'get' && callee.obj.ty && callee.obj.ty.k === 'named' && callee.obj.ty.sym.builtin && callee.obj.ty.sym.name === 'Map' && false) ret = T.unk;
    if (node.clauses) ret = this.checkClauses(node, ret, scope, ctx);
    return ret;
  }

  // the arguments inside the parentheses already fill the last parameter (or more than the parameters there are)
  lastIsGiven(params, node) {
    if (!params.length || params[params.length - 1].variadic) return false;
    const { pairs, used } = this.mapArgs(params, node);
    return used.has(params.length - 1) || pairs.some((p) => !p.param && !p.arg.name);
  }

  // The block after a call is its last argument written in place. A function type takes a function body (checkTrailingBlock).
  // An Array takes a list of values, {1, 2, 3}, and a struct takes name = value lines. Both are turned into an ordinary
  // argument for the last parameter, so that they are checked like any other argument.
  dataBlockCall(node, param, scope) {
    if (this.isPrelude) return node;
    const block = node.block;
    const t = param.type;
    const skipped = (s, e, message) => {
      this.diag(s, e, message);
      return Object.assign(Object.create(Object.getPrototypeOf(node)), node, { blockArg: true, blockSkipped: true });
    };
    if (!t || isUnk(t) || t.k === 'param' || t.k === 'void') return node;
    if (param.variadic) return skipped(block.s, block.s + 1, `${param.name || 'the last parameter'} is variadic and cannot take a block: write its values inside the parentheses`);
    if (node.args.some((a) => a.name && a.name === param.name)) return skipped(block.s, block.s + 1, `${param.name} is already given inside the parentheses, the block fills the last parameter`);
    const named = t.k === 'named' ? t.sym : null;
    const isArray = named && named.builtin && named.name === 'Array';
    const isStruct = named && named.tkind === 'struct' && !named.builtin;
    if (!isArray && !isStruct) {
      return skipped(block.s, block.s + 1, `the block fills the last parameter${param.name ? ` ${param.name}` : ''}, which is ${str(t)}: only a function, an Array or a struct can be written as a block, pass this one inside the parentheses`);
    }
    if (block.params.length) this.diag(block.params[0].s, block.params[0].e, `a block for ${str(t)} gives no values, it cannot name any`);
    let value;
    if (isArray) {
      if (!block.items) return skipped(block.s, block.s + 1, 'an Array block is a list of values: { 1, 2, 3 }');
      value = block.items;
    } else {
      value = { k: 'StructBlock', stmts: block.body.body, s: block.s, e: block.e };
    }
    return Object.assign(Object.create(Object.getPrototypeOf(node)), node, { args: [...node.args, { name: param.name || null, nameTok: null, value, fromBlock: true }], blockArg: true });
  }

  // { x = 1.0 } for a struct: every field is given by name, in any order
  inferStructBlock(node, scope, expected, ctx) {
    const sym = expected && expected.k === 'named' ? expected.sym : null;
    if (!sym) return T.unk;
    const fields = this.creationFields(sym);
    const given = new Set();
    for (const st of node.stmts) {
      if (st.k !== 'Assign' || st.op !== '=' || st.target.k !== 'Ident') {
        this.diag(st.s, st.e, `a block for ${sym.name} is made of lines like name = value`);
        continue;
      }
      const f = fields.find((x) => x.name === st.target.name);
      if (!f) {
        this.diag(st.target.s, st.target.e, `${sym.name} has no field ${st.target.name}`);
        this.inferExpr(st.value, scope, null, ctx);
        continue;
      }
      this.refs.push({ s: st.target.s, e: st.target.e, sym: f, node: { sym: f } });
      if (given.has(f.name)) this.diag(st.target.s, st.target.e, `${f.name} is given twice`);
      given.add(f.name);
      const ft = f.kind === 'property' ? (f.type || T.unk) : this.fieldType(f);
      const vt = this.inferExpr(st.value, scope, ft, ctx);
      this.checkCompatible(ft, vt, st.value);
    }
    const missing = fields.filter((f) => !given.has(f.name) && !f.defNode);
    if (missing.length) this.diag(node.s, node.e, `${sym.name} needs ${missing.map((m) => m.name).join(', ')}`);
    return expected;
  }

  dropFree(t, names) {
    if (!t) return t;
    if (names.length && hasParam(t, names)) {
      const map = new Map();
      names.forEach((n) => map.set(n, T.unk));
      return subst(t, map);
    }
    return t;
  }

  checkArgCount(fn, node, params, used, calleeSym) {
    if (this.isPrelude || !calleeSym) return;
    if (!['func', 'method', 'ctor', 'var', 'param'].includes(calleeSym.kind)) return;
    if (params.some((p) => p.variadic)) return;
    const given = node.args.filter((a) => !a.name).length;
    const named = node.args.filter((a) => a.name).length;
    const total = given + named;
    const block = node.block && !node.blockArg ? 1 : 0;
    const max = params.length;
    if (total + block > max) {
      this.diag(node.s, node.e, `${calleeSym.name} takes ${max} argument${max === 1 ? '' : 's'}, but ${total + block} given`);
      return;
    }
    const missing = params.filter((p, i) => !used.has(i) && !p.def);
    if (missing.length) this.diag(node.s, node.e, `${calleeSym.name} needs ${missing.map((m) => m.name || 'an argument').join(', ')}`);
  }

  checkTrailingBlock(block, fnType, scope, ctx) {
    const ptypes = fnType && fnType.k === 'fn' ? fnType.params : [];
    // a block names the values that its callback gives it, and cannot name more than the callback has
    if (fnType && fnType.k === 'fn' && !this.isPrelude && block.params.length > ptypes.length) {
      const extra = block.params[ptypes.length];
      this.diag(extra.s, extra.e, `the block names ${block.params.length} value${block.params.length === 1 ? '' : 's'}, but its callback gives ${ptypes.length}`);
    }
    const sym = { returns: [], declRet: fnType && fnType.k === 'fn' && fnType.ret && fnType.ret.k !== 'void' && !hasParam(fnType.ret) ? fnType.ret : null, kind: 'block' };
    this.checkBlock(block.body, scope, { fn: sym, loops: 0 }, (sc) => {
      block.params.forEach((p, i) => {
        const type = ptypes[i] ? ptypes[i].type : T.unk;
        const ps = this.declare(sc, new Sym('param', p.v, { type, visibleFrom: p.s }), p);
        this.hints.push({ offset: p.e, label: `: ${str(type)}`, sym: ps });
      });
    });
    const rets = sym.returns.filter((t) => t && t.k !== 'void' && !isUnk(t));
    return rets.length ? plain(rets[0]) : T.void;
  }

  // when(a) { } or_when(b) { } otherwise { }: each clause is a method of what the call before gave
  checkClauses(call, ret, scope, ctx) {
    let cur = ret;
    for (const cl of call.clauses) {
      const members = cur && cur.k === 'named' ? this.membersOfType(cur) : new Map();
      const e = members.get(cl.name);
      cl.ty = T.unk;
      if (e) {
        cl.sym = e.sym;
        this.refs.push({ s: cl.nameTok.s, e: cl.nameTok.e, sym: e.sym, node: cl });
        const fake = { callee: { k: 'Ident', name: cl.name, sym: e.sym }, args: cl.args, block: cl.body ? { params: cl.params, body: cl.body, items: cl.items, s: cl.body.s, e: cl.body.e } : null, s: cl.s, e: cl.e };
        // a clause takes its block as the last parameter
        const fnT = e.type;
        const r = fnT && fnT.k === 'fn' ? this.callFn(fnT, [], fake, scope, null, ctx) : T.unk;
        cur = r;
        cl.ty = r;
      } else {
        if (cur && cur.k === 'named' && this.isKnownShape(cur.sym) && !this.isPrelude) this.diag(cl.nameTok.s, cl.nameTok.e, `${str(cur)} has no method ${cl.name}`);
        cl.args.forEach((a) => this.inferExpr(a.value, scope, null, ctx));
        if (cl.body) this.checkTrailingBlock({ params: cl.params, body: cl.body }, null, scope, ctx);
        cur = T.unk;
      }
    }
    return cur;
  }

  // ---- creating values: Point(x = 1.0), Box(1), List<i32>(), Shape.Circle(2.0), i32(x)

  construct(ct, explicit, node, scope, expected, ctx) {
    const sym = ct.sym;
    const argTypes = () => node.args.map((a) => this.inferExpr(a.value, scope, null, ctx));
    if (sym.tkind === 'prim') {
      const pts = argTypes();
      if (sym.name === 'ptr') return T.ptr(explicit[0] || T.unk);
      return T.prim(sym.name);
    }
    if (sym.builtin && !sym.owner) {
      const name = sym.name;
      if (name === 'String') { argTypes(); return T.named(sym); }
      if (name === 'List' || name === 'Array' || name === 'Set') {
        const ts = argTypes();
        let elem = explicit[0] || null;
        if (!elem && ts.length) elem = plain(ts.reduce((a, b) => (a && a.k === 'prim' && a.lit && b && !(b.k === 'prim' && b.lit) ? b : a)));
        if (!elem && expected && expected.k === 'named' && expected.sym === sym) elem = expected.args[0];
        return T.named(sym, [elem || T.unk]);
      }
      if (name === 'Tuple') return T.named(sym, argTypes().map(plain));
      if (name === 'Map') {
        const ts = argTypes();
        if (explicit.length === 1) {
          this.diag(node.s, node.e, 'a Map has two type arguments: Map<K, V>');
          return T.named(sym, [T.unk, explicit[0]]);
        }
        if (explicit[0] && node.typeArgs && node.typeArgs[0] && node.typeArgs[0].s !== undefined) this.checkMapKey(explicit[0], node.typeArgs[0].s, node.typeArgs[0].e);
        // the arguments are key, value, key, value
        if (ts.length % 2) this.diag(node.s, node.e, 'Map takes pairs: a key and then its value');
        let key = explicit[0] || null;
        let val = explicit[1] || null;
        const widen = (cur, t) => (!cur || (cur.k === 'prim' && cur.lit && !(t.k === 'prim' && t.lit)) ? t : cur);
        node.args.forEach((a, i) => {
          const t = ts[i];
          if (!t || isUnk(t)) return;
          if (i % 2 === 0) { if (!explicit[0]) { this.checkMapKey(t, a.value.s, a.value.e); key = widen(key, t); } } else if (!explicit[1]) val = widen(val, t);
        });
        if (expected && expected.k === 'named' && expected.sym === sym) {
          if (!key) key = expected.args[0];
          if (!val) val = expected.args[1];
        }
        return T.named(sym, [key ? plain(key) : T.unk, val ? plain(val) : T.unk]);
      }
      if (name === 'Weak') { const ts = argTypes(); return T.named(sym, [ts[0] ? plain(ts[0]) : T.unk]); }
      if (name === 'Any') { argTypes(); return T.named(sym); }
    }
    if (sym.tkind === 'enum') { argTypes(); return T.named(sym); }
    if (['struct', 'union', 'class'].includes(sym.tkind) || sym.kind === 'variant') return this.constructFields(ct, explicit, node, scope, expected, ctx);
    if (sym.tkind === 'interface' || sym.tkind === 'trait') {
      argTypes();
      return T.named(sym);
    }
    argTypes();
    return T.named(sym, explicit);
  }

  constructFields(ct, explicit, node, scope, expected, ctx) {
    const sym = ct.sym;
    const owner = sym.owner || sym;
    const tparams = sym.tparams;
    const bindings = new Map();
    explicit.forEach((t, i) => { if (tparams[i]) bindings.set(tparams[i], t); });
    const fields = sym.fields;
    let ctor = sym.tkind === 'class' && sym.ctors && sym.ctors[0];
    let noMatch = false;
    if (ctor && sym.ctors.length > 1) {
      const idx = this.pickOverload(sym.ctors.map((c) => c.params), node, scope);
      noMatch = idx < 0;
      if (noMatch) this.diag(node.s, node.e, `no constructor of ${sym.name} takes these arguments`);
      else ctor = sym.ctors[idx];
    }
    const params = ctor ? ctor.params.map((p) => ({ name: p.name, type: p.type, def: p.def, variadic: p.variadic })) : this.creationFields(sym).map((f) => ({ name: f.name, type: f.kind === 'property' ? (f.type || T.unk) : this.fieldType(f), def: f.defNode || null, variadic: false }));
    void fields;
    const { pairs } = this.mapArgs(params, node);
    for (const { arg, param, idx } of pairs) {
      const exp = param ? subst(param.type, bindings) : null;
      const at = this.inferExpr(arg.value, scope, exp && !hasParam(exp, tparams) ? exp : null, ctx);
      if (param) unify(param.type, at, bindings, tparams);
      if (param && !noMatch && !hasParam(param.type) && !sym.builtin) this.checkCompatible(param.type, at, arg.value);
      if (!param && arg.name && !this.isPrelude && !noMatch) {
        if (sym.tkind === 'class' && ctor) this.diag(arg.nameTok.s, arg.nameTok.e, `the constructor has no parameter ${arg.name}`);
        else this.diag(arg.nameTok.s, arg.nameTok.e, `${sym.name} has no field ${arg.name}`);
      } else if (!param && !arg.name && !this.isPrelude && !noMatch && !(sym.tkind === 'union')) {
        this.diag(arg.value.s, arg.value.e, `${sym.name} takes ${params.length} value${params.length === 1 ? '' : 's'}`);
      }
      void idx;
    }
    if (node.block) {
      if (!this.isPrelude) this.diag(node.block.s, node.block.s + 1, `creating ${sym.name} takes its values inside the parentheses, a block cannot follow`);
      this.checkTrailingBlock(node.block, null, scope, ctx);
    }
    let result = T.named(owner, owner.tparams.map((n) => bindings.get(n) || T.unk));
    if (expected && expected.k === 'named' && expected.sym === owner) {
      const exp = new Map();
      unify(T.named(owner, owner.tparams.map((n) => T.param(n))), expected, exp, owner.tparams);
      result = T.named(owner, owner.tparams.map((n) => (bindings.get(n) && bindings.get(n).k !== 'unk' ? plain(bindings.get(n)) : exp.get(n) || T.unk)));
    } else {
      result = T.named(owner, owner.tparams.map((n) => (bindings.get(n) ? plain(bindings.get(n)) : T.unk)));
    }
    if (node.clauses) return this.checkClauses(node, result, scope, ctx);
    this.checkCreation(sym, noMatch ? null : ctor, params, pairs, node);
    return result;
  }

  // the fields a value is created with: its own, and for a class the ones it gets from the classes it extends
  creationFields(sym) {
    const out = [...sym.fields, ...(sym.props ? sym.props.values() : [])].filter((f) => !f.isStatic);
    if (sym.tkind === 'class' || sym.tkind === 'trait' || sym.tkind === 'interface') {
      for (const pt of [...(sym.extendsT || []), ...(sym.usesT || []), ...(sym.implementsT || [])]) {
        if (pt && pt.k === 'named') for (const f of this.creationFields(pt.sym)) if (!out.some((o) => o.name === f.name)) out.push(f);
      }
    }
    return out;
  }

  // the rules for creating a struct, a union or a class
  checkCreation(sym, ctor, params, pairs, node) {
    if (this.isPrelude || sym.builtin) return;
    const given = new Set(pairs.filter((p) => p.param).map((p) => p.param.name));
    const named = node.args.filter((a) => a.name).length;
    if (sym.tkind === 'struct' || sym.kind === 'variant') {
      if (params.length >= 2 && node.args.some((a) => !a.name) && sym.kind !== 'variant') {
        this.diag(node.s, node.e, `${sym.name} has two or more fields, so it is created with names: ${params.map((p) => `${p.name} = ...`).join(', ')}`);
        return;
      }
      const missing = params.filter((p) => !given.has(p.name) && !p.def);
      if (missing.length && !(sym.kind === 'variant' && node.args.length === 0 && params.length === 0)) {
        this.diag(node.s, node.e, `${sym.name} needs ${missing.map((m) => m.name).join(', ')}`);
      }
    } else if (sym.tkind === 'union') {
      const total = named + node.args.filter((a) => !a.name).length;
      const first = sym.fields[0];
      if (total === 0 && !(first && first.defNode)) this.diag(node.s, node.e, `say which field to start with: ${sym.name}(${(first || { name: 'field' }).name} = ...). With no argument the first field needs a default`);
      else if (total > 1) this.diag(node.s, node.e, `a union holds one view at a time: name one field to start with, like ${sym.name}(${(first || { name: 'field' }).name} = ...)`);
    } else if (ctor) {
      const missing = params.filter((p) => !given.has(p.name) && !p.def);
      if (missing.length) this.diag(node.s, node.e, `the constructor needs ${missing.map((m) => m.name).join(', ')}`);
    }
    void ctor;
  }

  // ------------------------------------------------------------ assignment and compatibility

  checkAssign(st, scope, ctx) {
    const target = st.target;
    this.writeTarget = st.op === '=' ? target : null;
    let tt = this.inferExpr(target, scope, null, ctx);
    this.writeTarget = null;
    if (target.k === 'Ident' && target.sym && target.sym.kind === 'var' && target.sym.isConst && !target.sym.isThis) {
      this.diag(target.s, target.e, `${target.name} is const and cannot be assigned. Declare it with let to change it.`);
    }
    if (target.k === 'Ident' && target.sym && target.sym.kind === 'param') {
      tt = target.sym.type;
      this.diag(target.s, target.e, `${target.name} is a parameter or a loop name and is fixed. Copy it into a let to change it: let local = ${target.name}`);
    }
    if (target.k === 'Member' && target.sym && target.sym.kind === 'property' && !target.sym.node.setter) {
      this.diag(target.nameTok.s, target.nameTok.e, `${target.name} has no set, it is read-only`);
    }
    const vt = this.inferExpr(st.value, scope, tt && tt.k === 'prim' ? tt : tt, ctx);
    if (st.op === '=') this.checkCompatible(tt, vt, st.value);
    else if (tt && vt) this.checkOperands({ s: st.s, e: st.e, left: target, right: st.value }, tt, vt);
  }

  // report only what is certain: a literal of the wrong kind, a different primitive, null for a non-pointer
  checkCompatible(declared, actual, node) {
    if (!declared || !actual || isUnk(declared) || isUnk(actual) || this.isPrelude) return;
    if (actual.k === 'null') {
      if (declared.k !== 'ptr') this.diag(node.s, node.e, `null can only be given to a ptr<T>, not to ${str(declared)}. Use Optional<T> for a value that may be absent.`);
      return;
    }
    if (declared.k === 'fn' || actual.k === 'fn') {
      if (declared.k === 'fn' && actual.k === 'fn') {
        if (!sameFn(declared, actual)) this.diag(node.s, node.e, `${str(actual)} is not ${str(declared)}`);
      } else if (!hasParam(declared) && !(declared.k === 'named' && declared.sym.name === 'Any' && declared.sym.builtin)) {
        if (declared.k === 'fn') this.diag(node.s, node.e, `${str(actual)} is not ${str(declared)}`);
        else this.diag(node.s, node.e, `${str(actual)} is not ${str(declared)}. A function name is the function itself, call it with () to get its result.`);
      }
      return;
    }
    if (declared.k === 'prim' && actual.k === 'prim') {
      if (actual.lit) { this.checkLiteralFits(actual, declared, node); return; }
      if (declared.n !== actual.n) this.diag(node.s, node.e, `${actual.n} is not ${declared.n}, convert first: ${declared.n}(...)`);
      return;
    }
    if (declared.k === 'prim' && actual.k === 'named') { this.diag(node.s, node.e, `${str(actual)} is not ${declared.n}`); return; }
    if (declared.k === 'named' && declared.sym.name === 'Any' && declared.sym.builtin) return;
    if (declared.k === 'named' && actual.k === 'prim') {
      if (declared.sym.tkind === 'enum' || ['struct', 'class', 'union'].includes(declared.sym.tkind) || declared.sym.builtin) this.diag(node.s, node.e, `${actual.n} is not ${str(declared)}`);
      return;
    }
    if (declared.k === 'named' && actual.k === 'named' && !this.assignable(declared, actual)) {
      this.diag(node.s, node.e, `${str(actual)} is not ${str(declared)}`);
    }
  }

  assignable(declared, actual) {
    const ds = declared.sym;
    const as = actual.sym;
    if (ds === as) return true;
    if (ds.name === 'Any' && ds.builtin) return true;
    if (as.kind === 'variant' && as.owner === ds) return true;
    if (as.builtin && ds.builtin && as.name !== ds.name) return ds.name === 'Any';
    // a class is assignable to what it extends, implements or uses
    const seen = new Set();
    const up = (s) => {
      if (!s || seen.has(s)) return false;
      seen.add(s);
      if (s === ds) return true;
      const ps = [...(s.extendsT || []), ...(s.implementsT || []), ...(s.usesT || [])];
      return ps.some((p) => p && p.k === 'named' && up(p.sym));
    };
    if (up(as)) return true;
    // be quiet when something is not fully known
    const complete = (s) => this.isKnownShape(s) && ['struct', 'union', 'enum', 'class', 'interface', 'trait'].includes(s.tkind);
    return !(complete(ds) && complete(as));
  }
}

module.exports = { Analysis, Scope, Sym, getPrelude, MODS };
