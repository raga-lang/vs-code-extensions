'use strict';

// Lexer for Raga. Pure function on text, no dependency on vscode.
// Token: { t, v, s, e, nl } where t is 'id' | 'num' | 'str' | 'chr' | 'p' | 'eof',
// v the text, s/e the offsets, nl true when a newline comes between the previous token and this one.
// Comments are returned separately: { s, e, text, line }.

const PUNCT3 = ['<<=', '...'];
const PUNCT2 = ['==', '!=', '<=', '>=', '&&', '||', '<<', '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^='];

function isIdStart(c) { return /[A-Za-z_]/.test(c); }
function isIdPart(c) { return /[A-Za-z0-9_]/.test(c); }

function lex(text) {
  const tokens = [];
  const comments = [];
  let i = 0;
  let nl = false;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { nl = true; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '/' && text[i + 1] === '/') {
      let j = i;
      while (j < n && text[j] !== '\n') j++;
      comments.push({ s: i, e: j, text: text.slice(i + 2, j) });
      i = j;
      continue;
    }
    const s = i;
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"' && text[j] !== '\n') { if (text[j] === '\\') j++; j++; }
      if (text[j] === '"') j++;
      tokens.push({ t: 'str', v: text.slice(i, j), s, e: j, nl });
      i = j; nl = false; continue;
    }
    if (c === "'") {
      const m = /^'(\\.|[^'\\\n])'/.exec(text.slice(i, i + 4));
      if (m) {
        tokens.push({ t: 'chr', v: m[0], s, e: i + m[0].length, nl });
        i += m[0].length; nl = false; continue;
      }
    }
    if (/[0-9]/.test(c)) {
      let j = i;
      if (c === '0' && /[xXbBoO]/.test(text[i + 1] || '')) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F_]/.test(text[j])) j++;
      } else {
        while (j < n && /[0-9_]/.test(text[j])) j++;
        if (text[j] === '.' && /[0-9]/.test(text[j + 1] || '')) {
          j++;
          while (j < n && /[0-9_]/.test(text[j])) j++;
        }
        if (/[eE]/.test(text[j] || '') && /[0-9+-]/.test(text[j + 1] || '')) {
          j += 2;
          while (j < n && /[0-9]/.test(text[j])) j++;
        }
      }
      tokens.push({ t: 'num', v: text.slice(i, j), s, e: j, nl });
      i = j; nl = false; continue;
    }
    // $ is the name of the built-in format function: $("%s costs %d", name, price)
    if (c === '$') {
      tokens.push({ t: 'id', v: '$', s, e: i + 1, nl });
      i++; nl = false; continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdPart(text[j])) j++;
      tokens.push({ t: 'id', v: text.slice(i, j), s, e: j, nl });
      i = j; nl = false; continue;
    }
    // punctuation: a '>' is always a token of its own, so generics like List<List<i32>> close cleanly.
    // The parser joins two glued '>' tokens into the shift operator.
    let p = c;
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (c === '>') p = text[i + 1] === '=' ? '>=' : '>';
    else if (PUNCT3.includes(three)) p = three;
    else if (PUNCT2.includes(two)) p = two;
    tokens.push({ t: 'p', v: p, s, e: i + p.length, nl });
    i += p.length; nl = false;
  }
  tokens.push({ t: 'eof', v: '', s: n, e: n, nl: true });
  return { tokens, comments };
}

module.exports = { lex };
