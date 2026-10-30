'use strict';

// Types of the Raga analyzer.
//   prim    { k:'prim', n:'i32', lit? }          lit: the type only came from an untyped literal
//   ptr     { k:'ptr', to }
//   named   { k:'named', sym, args }            a struct, union, enum, class, interface, trait, built-in type or variant
//   param   { k:'param', name }                 a type parameter such as T
//   fn      { k:'fn', params, ret, tparams }    params: [{ name, type, def, variadic }]
//   typeref { k:'typeref', sym }                the name of a type used as a value: Color in Color.Red
//   module  { k:'module', info }                the value of import(path)
//   void, unk (not known), nul (null)

const T = {
  prim: (n, lit) => (lit ? { k: 'prim', n, lit: true } : { k: 'prim', n }),
  ptr: (to) => ({ k: 'ptr', to }),
  named: (sym, args = []) => ({ k: 'named', sym, args }),
  param: (name) => ({ k: 'param', name }),
  fn: (params, ret, tparams = []) => ({ k: 'fn', params, ret, tparams }),
  typeref: (sym) => ({ k: 'typeref', sym }),
  module: (info) => ({ k: 'module', info }),
  void: { k: 'void' },
  unk: { k: 'unk' },
  nul: { k: 'null' },
};

const isUnk = (t) => !t || t.k === 'unk';

function str(t) {
  if (!t) return '?';
  switch (t.k) {
    case 'prim': return t.n;
    case 'ptr': return `ptr<${str(t.to)}>`;
    case 'named': {
      let name = t.sym.name;
      if (t.sym.kind === 'variant' && t.sym.owner) name = `${t.sym.owner.name}.${t.sym.name}`;
      return t.args.length ? `${name}<${t.args.map(str).join(', ')}>` : name;
    }
    case 'param': return t.name;
    case 'fn': {
      const hasRet = t.ret && t.ret.k !== 'void';
      if (!t.params.length && !hasRet) return 'Function';
      const ps = t.params.length ? `[${t.params.map((p) => (p.variadic ? '...' : '') + str(p.type)).join(', ')}]` : 'void';
      return `Function<${ps}${hasRet ? `, ${str(t.ret)}` : ''}>`;
    }
    case 'typeref': return `type ${t.sym.name}`;
    case 'module': return 'Module';
    case 'void': return 'void';
    case 'null': return 'null';
    default: return '?';
  }
}

// replace type parameters using a Map name -> type
function subst(t, map) {
  if (!t || !map || map.size === 0) return t;
  switch (t.k) {
    case 'param': return map.has(t.name) ? map.get(t.name) : t;
    case 'ptr': return T.ptr(subst(t.to, map));
    case 'named': return t.args.length ? T.named(t.sym, t.args.map((a) => subst(a, map))) : t;
    case 'fn': return T.fn(t.params.map((p) => ({ ...p, type: subst(p.type, map) })), subst(t.ret, map), t.tparams);
    default: return t;
  }
}

function hasParam(t, names) {
  if (!t) return false;
  switch (t.k) {
    case 'param': return !names || names.includes(t.name);
    case 'ptr': return hasParam(t.to, names);
    case 'named': return t.args.some((a) => hasParam(a, names));
    case 'fn': return t.params.some((p) => hasParam(p.type, names)) || hasParam(t.ret, names);
    default: return false;
  }
}

// bind the type parameters in `pattern` by looking at `actual`
function unify(pattern, actual, bindings, names) {
  if (!pattern || !actual || actual.k === 'unk') return;
  if (pattern.k === 'param') {
    if (names && !names.includes(pattern.name)) return;
    const cur = bindings.get(pattern.name);
    if (!cur || cur.k === 'unk' || (cur.k === 'prim' && cur.lit && !(actual.k === 'prim' && actual.lit))) bindings.set(pattern.name, actual);
    return;
  }
  if (pattern.k === 'ptr' && actual.k === 'ptr') return unify(pattern.to, actual.to, bindings, names);
  if (pattern.k === 'named' && actual.k === 'named') {
    if (pattern.sym === actual.sym) pattern.args.forEach((p, i) => unify(p, actual.args[i], bindings, names));
    else if (pattern.sym.kind === 'type' && actual.sym.kind === 'variant' && actual.sym.owner === pattern.sym) pattern.args.forEach((p, i) => unify(p, actual.args[i], bindings, names));
    return;
  }
  if (pattern.k === 'fn' && actual.k === 'fn') {
    pattern.params.forEach((p, i) => actual.params[i] && unify(p.type, actual.params[i].type, bindings, names));
    unify(pattern.ret, actual.ret, bindings, names);
  }
}

// a literal type becomes a plain type: 1 is an i32, 2.5 an f64
function plain(t) {
  if (t && t.k === 'prim' && t.lit) return T.prim(t.n);
  if (t && t.k === 'named' && t.args.some((a) => a && a.k === 'prim' && a.lit)) return T.named(t.sym, t.args.map(plain));
  return t;
}

// two function types are the same when the parameter types and the return type are the same; the names do not matter
// and what is not known matches anything
function sameFn(a, b) {
  if (isUnk(a) || isUnk(b)) return true;
  if (a.k === 'fn' && b.k === 'fn') {
    if (a.params.length !== b.params.length) return false;
    if (!a.params.every((p, i) => !!p.variadic === !!b.params[i].variadic && sameFn(p.type, b.params[i].type))) return false;
    const ra = a.ret || T.void;
    const rb = b.ret || T.void;
    return sameFn(ra, rb);
  }
  if (hasParam(a) || hasParam(b)) return true;
  if (a.k === 'prim' && b.k === 'prim') return a.n === b.n || !!a.lit || !!b.lit;
  if (a.k === 'named' && b.k === 'named') return a.sym === b.sym && a.args.length === b.args.length && a.args.every((x, i) => sameFn(x, b.args[i]));
  if (a.k === 'ptr' && b.k === 'ptr') return sameFn(a.to, b.to);
  return a.k === b.k;
}

function same(a, b) {
  if (!a || !b) return false;
  if (a.k !== b.k) return false;
  switch (a.k) {
    case 'prim': return a.n === b.n;
    case 'ptr': return same(a.to, b.to);
    case 'named': return a.sym === b.sym && a.args.length === b.args.length && a.args.every((x, i) => same(x, b.args[i]));
    case 'param': return a.name === b.name;
    default: return true;
  }
}

module.exports = { T, str, subst, unify, plain, same, sameFn, hasParam, isUnk };
