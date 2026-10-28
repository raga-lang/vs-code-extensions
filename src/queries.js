'use strict';

// What the editor asks of an Analysis: hover, completion, signature help, definition, references,
// outline and inlay hints. Pure functions, no dependency on vscode.

const { PRIMS, KEYWORDS } = require('./parser');
const { T, str, plain } = require('./types');
const { getPrelude } = require('./analyzer');

const KEYWORD_DOC = {
  const: 'Declares a name that cannot be rebound. The value can still change if it is a non-primitive value.',
  let: 'Declares a name that can be rebound.',
  function: 'A function: const name = function(Type parameter, ...) ReturnType { ... }',
  method: 'A method of a class, interface or trait: const name = method(Type parameter, ...) ReturnType { ... }. Overloads follow the closing brace: } method(String other) { ... }',
  struct: 'A type with named fields, and methods: const Name = struct { Type field }',
  union: 'A tagged union when it holds variants, an untagged one when it holds fields.',
  enum: 'A fixed set of names: const Name = enum { A, B }',
  class: 'A type with inheritance, interfaces and traits: const Name = class { ... } extends(Base)',
  interface: 'A list of abstract methods that a class promises to have.',
  trait: 'Code that a class uses with use(...).',
  attribute: 'Declares an attribute. Metadata only: const note = attribute(String text). A build hook runs once per use while building: ... |target, text| { }. A call hook runs on every call of the decorated function: ... call |target, args, next| { }.',
  if: 'if (condition) { } elif (condition) { } else { }',
  for: 'for (collection) |item, index| { }',
  while: 'while (condition) { }',
  loop: 'loop { } runs until break.',
  match: 'match (value) { case (Variant) |data| { } default { } }',
  switch: 'switch (integer or char) { case (1, 2) { } default { } }',
  return: 'Leaves the function and gives a value back.',
  break: 'Leaves the innermost loop. break 1 leaves it and the loop around it, break 2 three loops: the number is how many loops around the innermost one are left too, a whole number written in the code, 0 when it is left out.',
  continue: 'Goes to the next pass of the innermost loop. continue 1 ends the inner loop and goes to the next pass of the loop around it, continue 2 the one around that.',
  try: 'try { } catch |e| { } finally { }',
  catch: 'Handles an error thrown inside try: catch |e| { } gives e as an IError (e.message, e.code, e.as<T>()).',
  finally: 'Runs after try and catch, whatever happened.',
  throw: 'throw(Error(message = "...", code = 1)) raises an error. Only an Error, or an object of a class that implements IError, can be thrown.',
  extends: 'A class extends at most one class: class { } extends(Base)',
  implements: 'A class implements interfaces: class { } implements(IFace)',
  use: 'A class uses traits: class { } use(Trait)',
  export: 'export(a, b) as the last statement of a file shares those names with files that import it. It is a function whose arguments are names of this file.',
  this: 'The value a method was called on.',
  super: 'The class that this class extends.',
  null: 'The empty ptr<T>. null is not a value of any other type.',
  true: 'A bool.',
  false: 'A bool.',
  constructor: 'Runs once when an object is created.',
  destructor: 'Runs when an object is freed.',
};

const ATTRIBUTES = {
  class: 'Modifiers of a class: Inheritance.Final, Inheritance.Abstract',
  method: 'Modifiers of a method: Visibility.*, Inheritance.*, Ownership.*',
  field: 'Modifiers of a field: Visibility.*, Ownership.*',
  accessor: 'Modifiers of an accessor (get and set together): Visibility.*, Ownership.*, Inheritance.Virtual, Inheritance.Override, Inheritance.Final',
  get: 'The visibility of the get part of an accessor: Visibility.Public, Visibility.Protected, Visibility.Private',
  set: 'The visibility of the set part of an accessor: Visibility.Public, Visibility.Protected, Visibility.Private',
  deprecated: 'Using the declaration is a compile-time warning that shows the reason: [deprecated("reason")]',
  on: 'Runs a function on an event: [on(...)]',
  operator: 'An operator on your own type: [operator(Op.Add)]',
};
// the modifiers are members of three enums; each special attribute accepts some members of each
const MODIFIER_DOC = {
  Visibility: {
    Public: 'Everyone may use it. This is the default.',
    Protected: 'The class and the classes that extend it may use it.',
    Private: 'Only the class itself may use it.',
  },
  Inheritance: {
    Final: 'A class: it cannot be extended. A method or accessor: it cannot be replaced (it must be virtual or an override).',
    Abstract: 'A class: it cannot be created, it exists to be extended. A method: no body, every class that extends must write it.',
    Virtual: 'The method is chosen by the class of the value, and a class that extends may replace it.',
    Override: 'Replaces a virtual method or accessor of the base class. The compiler checks that there is something to replace.',
  },
  Ownership: {
    Instance: 'Belongs to each object. This is the default.',
    Static: 'Belongs to the class, it is reached through the class name and has no this.',
  },
};
const ATTR_MODIFIERS = {
  class: { Inheritance: ['Final', 'Abstract'] },
  method: { Visibility: ['Public', 'Protected', 'Private'], Inheritance: ['Final', 'Abstract', 'Virtual', 'Override'], Ownership: ['Instance', 'Static'] },
  field: { Visibility: ['Public', 'Protected', 'Private'], Ownership: ['Instance', 'Static'] },
  accessor: { Visibility: ['Public', 'Protected', 'Private'], Inheritance: ['Final', 'Virtual', 'Override'], Ownership: ['Instance', 'Static'] },
  get: { Visibility: ['Public', 'Protected', 'Private'] },
  set: { Visibility: ['Public', 'Protected', 'Private'] },
};

// ------------------------------------------------------------------ names and signatures

function typeOfSymbol(sym) {
  const a = sym.analysis;
  return a ? a.typeOfSym(sym) : T.unk;
}

function paramText(p) {
  const t = str(p.type);
  return `${t}${p.variadic ? ' ...' : ''} ${p.name}${p.def ? ' = ' + (p.defText || (p.def.v !== undefined ? p.def.v : '...')) : ''}`.trim();
}

function fnLabel(name, fnType, ownerPrefix) {
  const ps = fnType.params.map(paramText).join(', ');
  const tp = fnType.tparams && fnType.tparams.length ? `<${fnType.tparams.join(', ')}>` : '';
  const ret = fnType.ret && fnType.ret.k !== 'void' ? ` ${str(fnType.ret)}` : '';
  return `${ownerPrefix || ''}${name}${tp}(${ps})${ret}`;
}

function ctorParams(sym, nargs) {
  const a = sym.analysis;
  if (sym.tkind === 'class' && sym.ctors && sym.ctors[0]) {
    // with overloads, the first form that has room for the arguments written so far
    const c = sym.ctors.find((x) => x.params.length >= (nargs || 0)) || sym.ctors[sym.ctors.length - 1];
    return c.params.map((p) => ({ name: p.name, type: p.type, def: p.def, variadic: p.variadic }));
  }
  if (!a) return [];
  return a.creationFields(sym).map((f) => ({ name: f.name, type: f.kind === 'property' ? (f.type || T.unk) : a.fieldType(f), def: f.defNode || null, defText: fieldDefaultText(a, f) }));
}

// the source text of the default value of a struct or union field, '' when it has none
function fieldDefaultText(a, f) {
  const an = f.analysis || a;
  return f.defNode && an && an.text ? an.text.slice(f.defNode.s, f.defNode.e) : '';
}

function symKindName(sym) {
  switch (sym.kind) {
    case 'var': return sym.isConst ? 'constant' : 'variable';
    case 'param': return 'variable';
    case 'func': return 'function';
    case 'method': case 'ctor': case 'dtor': return 'method';
    case 'field': return 'field';
    case 'property': return 'property';
    case 'enumMember': return 'enumMember';
    case 'variant': return 'struct';
    case 'tparam': return 'typeParameter';
    case 'attribute': return 'function';
    case 'type':
      return { struct: 'struct', union: 'struct', enum: 'enum', class: 'class', interface: 'interface', trait: 'interface', alias: 'class', prim: 'class' }[sym.tkind] || 'class';
    default: return 'variable';
  }
}

function detailOf(sym, typeOverride) {
  const a = sym.analysis;
  switch (sym.kind) {
    case 'var': case 'param': return str(typeOverride || sym.type);
    case 'func': case 'method': case 'ctor': case 'dtor': return a ? fnLabel('', a.fnTypeOf(sym)).replace(/^/, '') : '';
    case 'field': return a ? str(a.fieldType(sym)) : '';
    case 'property': return str(sym.type);
    case 'enumMember': return sym.owner.name;
    case 'variant': return `variant of ${sym.owner.name}`;
    case 'type': return sym.tkind === 'alias' ? `alias of ${str(sym.target)}` : `${sym.tkind}${sym.tparams.length ? `<${sym.tparams.join(', ')}>` : ''}`;
    case 'attribute': return 'attribute';
    default: return '';
  }
}

// the code shown for a symbol in hover
function declarationText(sym, typeOverride) {
  const a = sym.analysis;
  switch (sym.kind) {
    case 'var': {
      const kw = sym.explicit ? '' : (sym.isConst ? 'const ' : 'let ');
      const t = typeOverride || sym.type;
      if (sym.isThis) return `this: ${str(t)}`;
      if (sym.name === 'super') return `super: ${str(t)}`;
      if (sym.explicit) return `${str(t)} ${sym.name}`;
      return `${kw}${sym.name}: ${str(plain(t))}`;
    }
    case 'param': return `(parameter) ${sym.name}: ${str(sym.type)}`;
    case 'func': return a ? `const ${fnLabel(sym.name, a.fnTypeOf(sym)).replace(/^([^(<]*)/, `$1 = function`).replace(/^(\S+) = function<[^>]*>/, '$1 = function')}` : sym.name;
    case 'method': case 'ctor': case 'dtor': {
      const owner = sym.owner ? `${sym.owner.name}.` : '';
      const word = sym.isStatic ? 'static method' : sym.kind === 'ctor' ? 'constructor' : sym.kind === 'dtor' ? 'destructor' : 'method';
      // every form of a method with overloads
      const forms = sym.overloads && sym.overloads.length > 1 ? sym.overloads : [sym];
      const lines = forms.map((f, i) => {
        const ft = forms.length === 1 && typeOverride && typeOverride.k === 'fn' ? typeOverride : (a ? a.fnTypeOf(f) : null);
        return ft ? `(${word}) ${fnLabel(owner + sym.name, ft)}` : sym.name;
      });
      return lines.join('\n');
    }
    case 'field': return `(${sym.isStatic ? 'static field' : 'field'}) ${sym.owner ? sym.owner.name + '.' : ''}${sym.name}: ${typeOverride ? str(typeOverride) : (a ? str(a.fieldType(sym)) : '?')}${fieldDefaultText(a, sym) ? ' = ' + fieldDefaultText(a, sym) : ''}`;
    case 'property': {
      const n = sym.node || {};
      const access = n.getter && !n.setter ? ' (read-only)' : n.setter && !n.getter ? ' (write-only)' : '';
      return `(${sym.isStatic ? 'static accessor' : 'accessor'}) ${sym.owner ? sym.owner.name + '.' : ''}${sym.name}: ${str(typeOverride || sym.type)}${access}`;
    }
    case 'enumMember': return `${sym.owner.name}.${sym.name}${sym.value !== undefined ? ' = ' + sym.value : ''}`;
    case 'variant': return `variant ${sym.owner.name}.${sym.name}${sym.fields.length ? `(${sym.fields.map((f) => `${a ? str(a.fieldType(f)) : '?'} ${f.name}`).join(', ')})` : ''}`;
    case 'attribute': {
      const parts = sym.hooks && (sym.hooks.build || sym.hooks.call) ? [sym.hooks.build ? 'build hook' : '', sym.hooks.call ? 'call hook' : ''].filter(Boolean).join(' + ') : 'metadata only';
      return `const ${sym.name} = attribute(${(sym.params || []).map(paramText).join(', ')})  // ${parts}`;
    }
    case 'tparam': return `(type parameter) ${sym.name}`;
    case 'type': return typeSummary(sym);
    default: return sym.name;
  }
}

function typeSummary(sym) {
  const a = sym.analysis;
  if (sym.tkind === 'alias') return `const ${sym.name} = ${str(sym.target)}`;
  if (sym.tkind === 'prim') return `${sym.name} (primitive type)`;
  const tp = sym.tparams.length ? `<${sym.tparams.join(', ')}>` : '';
  const lines = [];
  for (const f of sym.fields) lines.push(`    ${a ? str(a.fieldType(f)) : '?'} ${f.name}${fieldDefaultText(a, f) ? ' = ' + fieldDefaultText(a, f) : ''}`);
  for (const p of (sym.props || new Map()).values()) lines.push(`    ${str(p.type)} ${p.name}`);
  if (sym.tkind === 'enum') for (const em of (sym.enumMembers || new Map()).values()) lines.push(`    const ${em.name} = ${em.value !== undefined ? em.value : '?'}`);
  if (sym.tkind === 'union') for (const v of (sym.variants || new Map()).values()) lines.push(`    ${v.name}${v.fields.length ? `(${v.fields.map((f) => `${a ? str(a.fieldType(f)) : '?'} ${f.name}`).join(', ')})` : ''}`);
  for (const m of (sym.methods || new Map()).values()) lines.push(`    ${a ? fnLabel(m.name, a.fnTypeOf(m)) : m.name}`);
  let clauses = '';
  const names = (ts) => (ts || []).map(str).join(', ');
  if (sym.extendsT && sym.extendsT.length) clauses += ` extends(${names(sym.extendsT)})`;
  if (sym.implementsT && sym.implementsT.length) clauses += ` implements(${names(sym.implementsT)})`;
  if (sym.usesT && sym.usesT.length) clauses += ` use(${names(sym.usesT)})`;
  const shown = lines.slice(0, 14);
  if (lines.length > shown.length) shown.push('    ...');
  return `const ${sym.name} = ${sym.tkind}${tp} {${shown.length ? '\n' + shown.join('\n') + '\n' : ' '}}${clauses}`;
}

// ------------------------------------------------------------------ finding things

function findAt(a, off) {
  let best = null;
  for (const r of a.refs) {
    if (r.s <= off && off <= r.e && (!best || r.e - r.s < best.e - best.s)) best = r;
  }
  for (const d of a.decls) {
    if (d.s <= off && off <= d.e && (!best || d.e - d.s < best.e - best.s)) best = d;
  }
  return best;
}

function innermostExpr(a, off, pred) {
  let best = null;
  for (const n of a.exprs) {
    if (n.s <= off && off <= n.e && (!pred || pred(n)) && (!best || n.e - n.s < best.e - best.s)) best = n;
  }
  return best;
}

// ------------------------------------------------------------------ hover

function hover(a, off) {
  const hit = findAt(a, off);
  if (hit && hit.sym) {
    const sym = hit.sym;
    let override = null;
    if (['var', 'param', 'field', 'property', 'method', 'func'].includes(sym.kind) && hit.node && hit.node.ty && hit.node.ty.k !== 'unk' && hit.node.ty.k !== 'typeref') override = hit.node.ty;
    const code = declarationText(sym, override);
    const doc = sym.doc ? `\n\n${sym.doc}` : '';
    const captured = sym.captured ? '\n\ncaptured by a closure: lives on the heap while a closure uses it' : '';
    return { start: hit.s, end: hit.e, markdown: '```raga\n' + code + '\n```' + captured + doc };
  }
  const tok = a.parsed.tokens.find((t) => t.s <= off && off <= t.e && t.t !== 'eof');
  // Visibility.Private, Inheritance.Final, Ownership.Static inside an attribute
  if (tok && tok.t === 'id') {
    const toks = a.parsed.tokens;
    const i = toks.indexOf(tok);
    const dot = toks[i - 1];
    const owner = toks[i - 2];
    if (dot && dot.t === 'p' && dot.v === '.' && owner && owner.t === 'id' && MODIFIER_DOC[owner.v] && MODIFIER_DOC[owner.v][tok.v]) {
      return { start: tok.s, end: tok.e, markdown: '```raga\n' + owner.v + '.' + tok.v + '\n```\n' + MODIFIER_DOC[owner.v][tok.v] };
    }
  }
  if (tok && tok.t === 'id' && KEYWORD_DOC[tok.v]) return { start: tok.s, end: tok.e, markdown: `**${tok.v}**\n\n${KEYWORD_DOC[tok.v]}` };
  if (tok && tok.t === 'id' && PRIMS.has(tok.v)) return { start: tok.s, end: tok.e, markdown: '```raga\n' + tok.v + ' (primitive type)\n```' };
  // a literal or any other expression: show its type
  const e = innermostExpr(a, off, (n) => ['Num', 'Str', 'Char', 'Bool', 'ListLit', 'ArrayLit', 'Tuple', 'Call', 'Binary', 'Member'].includes(n.k));
  if (e && e.ty && e.ty.k !== 'unk' && e.ty.k !== 'typeref') {
    return { start: e.s, end: e.e, markdown: '```raga\n' + str(plain(e.ty)) + '\n```' };
  }
  return null;
}

// ------------------------------------------------------------------ definition, references, rename

function definition(a, off) {
  const hit = findAt(a, off);
  if (hit && hit.sym && hit.sym.nameTok) {
    const sym = hit.sym;
    return { s: sym.nameTok.s, e: sym.nameTok.e, uri: sym.uri || a.opts.uri, builtin: !!sym.builtin, from: { s: hit.s, e: hit.e } };
  }
  // import("./path") opens the file
  for (const n of a.exprs) {
    // the whole path is the link, not the word under the cursor
    if (n.k === 'Str' && n.importTarget && n.s <= off && off <= n.e) return { s: 0, e: 0, uri: n.importTarget, from: { s: n.s + 1, e: n.e - 1 } };
  }
  return null;
}

function referencesTo(a, off) {
  const hit = findAt(a, off);
  if (!hit || !hit.sym) return [];
  const sym = hit.sym;
  const out = [];
  const seen = new Set();
  const add = (s, e) => { const k = `${s}:${e}`; if (!seen.has(k)) { seen.add(k); out.push({ s, e }); } };
  if (sym.nameTok && sym.analysis === a) add(sym.nameTok.s, sym.nameTok.e);
  for (const r of a.refs) if (r.sym === sym) add(r.s, r.e);
  return { sym, ranges: out };
}

// ------------------------------------------------------------------ outline

function documentSymbols(a) {
  const out = [];
  const range = (node, sym) => ({ s: node ? node.s : sym.s, e: node ? Math.max(node.e, sym.e) : sym.e });
  const members = (sym) => {
    const kids = [];
    const push = (child, kind, detail, node) => {
      if (!child.nameTok) return;
      const r = range(node, child);
      kids.push({ name: child.name, detail, kind, range: r, selection: { s: child.nameTok.s, e: child.nameTok.e }, children: [] });
    };
    for (const f of sym.fields || []) push(f, 'field', (a.fieldType(f) ? str(a.fieldType(f)) : '') + (fieldDefaultText(a, f) ? ' = ' + fieldDefaultText(a, f) : ''), null);
    for (const p of (sym.props || new Map()).values()) push(p, 'property', str(p.type), p.node);
    for (const m of (sym.enumMembers || new Map()).values()) push(m, 'enumMember', '', null);
    for (const v of (sym.variants || new Map()).values()) push(v, 'struct', 'variant', v.declNode);
    for (const m of (sym.methods || new Map()).values()) push(m, 'method', fnLabel('', a.fnTypeOf(m)), m.declNode);
    for (const c of (sym.ctors || []).slice(0, 1)) push(c, 'method', 'constructor', c.declNode);
    return kids;
  };
  for (const sym of a.fileScope.syms.values()) {
    if (!sym.nameTok || sym.analysis !== a) continue;
    const kind = symKindName(sym);
    const r = range(sym.declNode, sym);
    const item = { name: sym.name, detail: detailOf(sym), kind, range: r, selection: { s: sym.nameTok.s, e: sym.nameTok.e }, children: [] };
    if (sym.kind === 'type') item.children = members(sym);
    out.push(item);
  }
  return out.sort((x, y) => x.range.s - y.range.s);
}

// ------------------------------------------------------------------ signature help

// the snippet of a block for a callback of the function type ft: |names| { return ... } (names from the type, return when it gives a value)
function blockSnippet(ft, first, lead = ' ') {
  const names = ft.params.map((p, i) => `\${${first + i}:${p.name || 'value' + (i + 1)}}`);
  const pipes = names.length ? `${lead}|${names.join(', ')}|` : lead.replace(/^$/, '');
  const returns = ft.ret && ft.ret.k !== 'void' && !isUnkType(ft.ret) ? `\treturn \$${first + names.length}` : `\t\$${first + names.length}`;
  return `${names.length ? pipes : lead}${names.length ? '' : ''}${names.length ? ' ' : ''}{\n${returns}\n}`.replace(/^( ?)\|/, '$1|');
}
function isUnkType(t) { return !t || t.k === 'unk'; }

function trailingBlockCompletion(a, off, prefix, lineStart) {
  // the call that was just closed: name(args) | and the cursor is after the )
  const closeParen = /\)\s*$/.exec(prefix);
  if (closeParen) {
    const closeOff = lineStart + closeParen.index + 1;
    const call = a.calls.find((c) => c.closed && c.closeEnd === closeOff && !c.block && !c.parenless);
    const ct = call && call.callee && call.callee.ty;
    if (ct && ct.k === 'fn' && ct.params.length) {
      const last = ct.params[ct.params.length - 1];
      if (last.type && last.type.k === 'fn' && call.args.length < ct.params.length) {
        const label = last.type.params.length ? `|${last.type.params.map((p) => p.name || 'value').join(', ')}| { }` : '{ }';
        const lead = /\s$/.test(prefix) ? '' : ' ';
        return { blockOnly: true, items: [item(label, 'snippet', `trailing block for ${last.name || 'the callback'}: ${str(last.type)}`, 'Writes the block that fills the last callback.', { sort: '00', insert: blockSnippet(last.type, 1, lead), snippet: true })] };
      }
    }
  }
  // the block that was just closed: } and the cursor is after it on the same line
  const closeBrace = /\}\s+([A-Za-z_]\w*)?$/.exec(prefix);
  if (closeBrace) {
    const braceOff = lineStart + closeBrace.index + 1;
    const out = [];
    const given = [];
    for (const c of a.calls) {
      if (c.block && c.block.e === braceOff) given.push(c.ty);
      for (const cl of c.clauses || []) if (cl.body && cl.body.e === braceOff) given.push(cl.ty);
    }
    for (const ty of given) {
      if (!ty || ty.k !== 'named') continue;
      for (const [name, e] of a.membersOfType(ty)) {
        if (e.kind !== 'method' || !e.type || e.type.k !== 'fn' || !e.type.params.length) continue;
        const last = e.type.params[e.type.params.length - 1];
        if (!last.type || last.type.k !== 'fn') continue;
        const others = e.type.params.slice(0, -1);
        const args = others.length ? `(${others.map((p, i) => `\${${i + 1}:${p.name || 'value'}}`).join(', ')})` : '';
        const insert = `${name}${args}${blockSnippet(last.type, others.length + 1)}`;
        out.push(item(name, 'method', `next clause: ${str(e.type)}`, e.doc, { sort: '00' + name, insert, snippet: true }));
      }
    }
    if (out.length) return { blockOnly: true, items: out };
  }
  return null;
}

function enclosingCall(a, off) {
  let best = null;
  for (const c of a.calls) {
    if (c.parenless) continue;
    const end = c.closed ? c.closeEnd - 1 : Infinity;
    if (c.open.e <= off && off <= end && (!best || c.s > best.s || (c.s === best.s && c.e < best.e))) best = c;
  }
  return best;
}

function signatureAt(a, off) {
  const call = enclosingCall(a, off);
  if (!call) return null;
  const ct = call.callee.ty;
  let label = null;
  let params = null;
  let doc = '';
  if (ct && ct.k === 'fn') {
    const sym = call.callee.sym;
    const name = call.callee.k === 'Member' ? call.callee.name : (call.callee.name || (sym && sym.name) || '');
    label = fnLabel(name, ct);
    params = ct.params;
    doc = sym && sym.doc ? sym.doc : '';
  } else if (ct && ct.k === 'typeref' && ct.sym.tkind !== 'prim') {
    const sym = ct.sym;
    params = ctorParams(sym, call.args.length);
    label = `${sym.name}(${params.map(paramText).join(', ')})`;
    doc = sym.doc || '';
  } else return null;
  // which argument the cursor is in
  let depth = 0;
  let active = 0;
  let current = null;
  for (const t of a.parsed.tokens) {
    if (t.s < call.open.e) continue;
    if (t.s >= off) break;
    if (t.t === 'p' && '([{'.includes(t.v)) depth++;
    else if (t.t === 'p' && ')]}'.includes(t.v)) depth--;
    else if (t.t === 'p' && t.v === ',' && depth === 0) { active++; current = null; }
    else if (depth === 0 && t.t === 'id' && current === null) current = t;
  }
  // a named argument selects its parameter
  const named = call.args[active];
  if (named && named.name) { const i = params.findIndex((p) => p.name === named.name); if (i >= 0) active = i; }
  const parts = params.map(paramText);
  return { label, parameters: parts, active: Math.min(active, Math.max(parts.length - 1, 0)), doc };
}

// ------------------------------------------------------------------ completion

const KIND_ORDER = { local: '0', file: '1', builtin: '2', keyword: '3' };

function visibleSymbols(a, off) {
  let inner = a.fileScope;
  for (const sc of a.scopes) {
    if (sc.s <= off && off <= sc.e && (sc.e - sc.s) <= (inner.e - inner.s)) inner = sc;
  }
  const seen = new Map();
  for (let sc = inner; sc; sc = sc.parent) {
    for (const [name, sym] of sc.syms) {
      if (seen.has(name)) continue;
      if (sym.visibleFrom !== undefined && sym.visibleFrom > off && sc.kind !== 'builtin') continue;
      seen.set(name, { sym, scope: sc });
    }
  }
  return seen;
}

function item(label, kind, detail, doc, extra) {
  return { label, kind, detail: detail || '', doc: doc || '', ...extra };
}

function memberItems(a, ty, expectedKinds) {
  const items = [];
  let members;
  if (ty && ty.k === 'typeref') {
    members = a.staticMembers(ty.sym);
  } else {
    members = a.membersOfType(ty);
  }
  void expectedKinds;
  for (const [name, e] of members) {
    const kind = e.kind === 'method' ? 'method' : e.kind === 'field' ? 'field' : e.kind === 'property' ? 'property' : e.kind === 'enumMember' ? 'enumMember' : e.kind === 'variant' ? 'struct' : e.sym ? symKindName(e.sym) : 'field';
    let detail = e.type ? str(e.type) : '';
    let insert = name;
    let snippet = false;
    if (e.type && e.type.k === 'fn') {
      detail = fnLabel('', e.type);
      const tp = e.type.tparams && e.type.tparams.length ? `<${e.type.tparams.map((n, i) => `\${${i + 1}:${n}}`).join(', ')}>` : '';
      insert = `${name}${tp}(${e.type.params.length ? '$0' : ''})`;
      snippet = true;
      if (!e.type.params.length) insert = `${name}${tp}()`;
    } else if (e.kind === 'variant') {
      const v = e.sym;
      detail = v.fields.length ? `(${v.fields.map((f) => `${f.name}`).join(', ')})` : 'variant';
      if (v.fields.length) { insert = `${name}($0)`; snippet = true; }
    }
    items.push(item(name, kind, e.sym && e.sym.kind === 'type' ? detailOf(e.sym) : detail, e.doc, { insert, snippet, sort: '0' + name }));
  }
  return items;
}

function completion(a, off, ctxOpts = {}) {
  const text = a.text;
  const lineStart = a.lineStarts[a.lineOf(off)];
  const prefix = text.slice(lineStart, off);

  // 1. an attribute line: [method(static)]
  const attr = /^\s*\[([^\]]*)$/.exec(prefix);
  if (attr) {
    const inner = attr[1];
    const open = /(\w+)\(([^)]*)$/.exec(inner);
    if (open && ATTR_MODIFIERS[open[1]]) {
      const allowed = ATTR_MODIFIERS[open[1]];
      const dotted = /(\w+)\.(\w*)$/.exec(open[2]);
      if (dotted && allowed[dotted[1]]) {
        return { items: allowed[dotted[1]].map((m) => item(m, 'enumMember', `${dotted[1]}.${m}`, MODIFIER_DOC[dotted[1]][m], { sort: '0' + m })) };
      }
      return { items: Object.keys(allowed).map((e) => item(e, 'enum', 'enum', `${allowed[e].join(', ')}`, { sort: '0' + e, insert: e + '.' })) };
    }
    const items = Object.keys(ATTRIBUTES).map((n) => item(n, 'function', 'attribute', ATTRIBUTES[n], { sort: '0' + n }));
    for (const [n, s] of visibleSymbols(a, off)) if (s.sym.kind === 'attribute') items.push(item(n, 'function', 'attribute', s.sym.doc, { sort: '0' + n }));
    return { items };
  }

  // 2. the path of import("...")
  const imp = /import\(\s*"([^"]*)$/.exec(prefix);
  if (imp) return { items: (ctxOpts.listPaths ? ctxOpts.listPaths(imp[1], a.opts.uri) : []).map((p) => item(p.name, p.dir ? 'module' : 'file', p.dir ? 'folder' : 'module', '', { sort: '0' + p.name, insert: p.name })) };

  // inside a comment or a text there is nothing to complete
  {
    let inStr = false;
    for (let i = 0; i < prefix.length; i++) {
      const c = prefix[i];
      if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
      if (c === '"') inStr = true;
      else if (c === '/' && prefix[i + 1] === '/') return { items: [] };
      else if (c === "'" && /^'(\\.|[^'\\])'/.test(prefix.slice(i, i + 4))) i += prefix.slice(i).match(/^'(\\.|[^'\\])'/)[0].length - 1;
    }
    if (inStr) return { items: [] };
  }

  // 2b. after the ) of a call: the trailing block that fills its last callback, with the names and the return that the callback has
  // 2c. after the } of a block: the next clause of a chain, a method of what the call gave back whose last parameter is a callback
  {
    const blockItems = trailingBlockCompletion(a, off, prefix, lineStart);
    if (blockItems) return blockItems;
  }

  // 3. after a dot: the members of the value
  const dot = /(\.)([A-Za-z_]\w*)?$/.exec(prefix);
  if (dot && !/\d\.$/.test(prefix) && !/\.\.\.$/.test(prefix)) {
    const dotOff = off - (dot[2] ? dot[2].length : 0) - 1;
    const memberNode = a.exprs.find((n) => n.k === 'Member' && ((n.incomplete && n.dot && n.dot.s === dotOff) || (n.nameTok && n.nameTok.s - 1 === dotOff)));
    let recv = memberNode ? memberNode.obj.ty : null;
    if (memberNode && !recv) recv = null;
    if (recv && recv.k !== 'unk') {
      const items = memberItems(a, recv);
      return { items, replaceFrom: off - (dot[2] ? dot[2].length : 0) };
    }
    // a dot after a deref: p.*.field
    return { items: [] };
  }

  // 4. a name being declared: nothing to complete
  if (/^\s*(const|let)\s+\w*$/.test(prefix)) return { items: [] };

  // 5. the variants of a match
  const cs = /\bcase\s*\(\s*[A-Za-z_]*$/.exec(prefix);
  const items = [];
  if (cs) {
    const m = a.matches.find((x) => x.node.s <= off && off <= x.node.e);
    if (m && m.type && m.type.k === 'named' && m.node.k === 'Match') {
      for (const v of a.variantsOf(m.type.sym).values()) {
        const kind = v.kind === 'enumMember' ? 'enumMember' : 'struct';
        items.push(item(v.name, kind, v.kind === 'variant' ? `variant of ${m.type.sym.name}` : m.type.sym.name, v.doc, { sort: '00' + v.name }));
      }
      if (items.length) return { items };
    }
  }

  // 6. the names of a call: Point(x = 1.0, y = 2.0)
  const call = enclosingCall(a, off);
  if (call && /(?:\(|,)\s*[A-Za-z_]*$/.test(prefix)) {
    const ct = call.callee.ty;
    let params = null;
    if (ct && ct.k === 'fn') params = ct.params;
    else if (ct && ct.k === 'typeref' && ct.sym.tkind !== 'prim' && ct.sym.tkind !== 'enum') params = ctorParams(ct.sym);
    if (params) {
      const used = new Set(call.args.filter((x) => x.name).map((x) => x.name));
      for (const p of params) {
        if (!p.name || used.has(p.name)) continue;
        items.push(item(`${p.name} =`, 'field', str(p.type) + (p.defText ? ' = ' + p.defText : ''), '', { sort: (p.def ? '01' : '00') + p.name, insert: `${p.name} = ` }));
      }
    }
  }

  // 7. every name that is visible here
  for (const [name, { sym, scope }] of visibleSymbols(a, off)) {
    if (name === 'this' || name === 'super') {
      items.push(item(name, 'keyword', name === 'this' ? str(sym.type) : str(sym.type), KEYWORD_DOC[name], { sort: '0' + name }));
      continue;
    }
    if (sym.kind === 'tparam') { items.push(item(name, 'typeParameter', 'type parameter', '', { sort: '0' + name })); continue; }
    const rank = scope.kind === 'builtin' ? KIND_ORDER.builtin : (scope === a.fileScope ? KIND_ORDER.file : KIND_ORDER.local);
    const kind = symKindName(sym);
    let insert = name;
    let snippet = false;
    if (sym.kind === 'func') {
      const ft = (sym.analysis || a).fnTypeOf(sym);
      insert = `${name}(${ft.params.length ? '$0' : ''})`;
      snippet = true;
    }
    items.push(item(name, kind, detailOf(sym), sym.doc, { sort: rank + name, insert, snippet }));
  }
  for (const p of PRIMS) items.push(item(p, 'class', 'primitive type', '', { sort: KIND_ORDER.builtin + p }));
  items.push(item('ptr', 'class', 'pointer type: ptr<T>', '', { sort: KIND_ORDER.builtin + 'ptr' }));
  for (const k of Object.keys(KEYWORD_DOC)) {
    if (k === 'this' || k === 'super' || k === 'export') continue;
    items.push(item(k, 'keyword', 'keyword', KEYWORD_DOC[k], { sort: KIND_ORDER.keyword + k }));
  }
  return { items };
}

// ------------------------------------------------------------------ inlay hints

function inlayHints(a) {
  const out = [];
  for (const h of a.hints) {
    if (h.label.includes('?') || h.label === ': void') continue;
    if (h.sym && h.sym.explicit) continue;
    out.push({ offset: h.offset, label: h.label });
  }
  return out;
}

function diagnostics(a) {
  return a.diags.slice();
}

module.exports = {
  hover, definition, referencesTo, documentSymbols, signatureAt, completion, inlayHints, diagnostics, findAt,
  fnLabel, detailOf, symKindName, declarationText, ATTRIBUTES, KEYWORD_DOC, KEYWORDS, getPrelude,
};
