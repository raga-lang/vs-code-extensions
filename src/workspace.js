'use strict';

// Finds and analyzes the files that import("./path") names. No dependency on vscode: the host gives
// read(file) -> text or null, and list(dir) -> [{ name, dir }].

const path = require('path');
const { Analysis } = require('./analyzer');

class Workspace {
  constructor(host) {
    this.host = host;
    this.cache = new Map();
    this.stack = [];
    this.version = 0;
  }

  // any edit can change what an importing file sees
  bump() { this.version++; }

  // the analysis of one file; `text` is given for a file that is open in the editor
  analyze(file, text) {
    const content = text !== undefined ? text : this.host.read(file);
    if (content === null || content === undefined) return null;
    const hit = this.cache.get(file);
    if (hit && hit.text === content && hit.version === this.version) return hit.analysis;
    this.stack.push(file);
    let analysis;
    try {
      analysis = new Analysis(content, { uri: file, loadModule: (p, from) => this.load(p, from), listPaths: undefined });
    } finally {
      this.stack.pop();
    }
    this.cache.set(file, { text: content, analysis, version: this.version });
    return analysis;
  }

  // The project root of a file: the nearest folder above it that has a raga.project file or a libraries folder.
  projectRoot(from) {
    let dir = from ? path.dirname(from) : process.cwd();
    for (;;) {
      if (this.host.read(path.join(dir, 'raga.project')) != null || (this.host.list(path.join(dir, 'libraries')) || []).length) return dir;
      const up = path.dirname(dir);
      if (up === dir) return null;
      dir = up;
    }
  }

  // raga.project: lines like  name = "./path/to/file"  (comments start with //), paths are from the folder of the project file
  readProject(root) {
    const text = root ? this.host.read(path.join(root, 'raga.project')) : null;
    const map = new Map();
    if (text == null) return map;
    for (const line of text.split('\n')) {
      const m = /^\s*([A-Za-z_]\w*)\s*=\s*"([^"]*)"/.exec(line.replace(/\/\/.*$/, ''));
      if (m) map.set(m[1], m[2]);
    }
    return map;
  }

  // import("json"): raga.project first, then the libraries folder, then the standard location
  resolveLibrary(name, from) {
    const root = this.projectRoot(from) || (from ? path.dirname(from) : process.cwd());
    const withExt = (f) => (f.endsWith('.raga') ? f : `${f}.raga`);
    const mapped = this.readProject(root).get(name);
    const candidates = [];
    if (mapped) candidates.push(path.resolve(root, withExt(mapped)));
    candidates.push(path.join(root, 'libraries', `${name}.raga`), path.join(root, 'libraries', name, `${name}.raga`));
    return candidates.find((c) => this.host.read(c) != null) || null;
  }

  load(request, from) {
    const base = from ? path.dirname(from) : process.cwd();
    const isPath = request.startsWith('./') || request.startsWith('../') || request.startsWith('/');
    const target = isPath ? path.resolve(base, request.endsWith('.raga') ? request : `${request}.raga`) : this.resolveLibrary(request, from);
    if (!target) return null;
    if (this.stack.includes(target)) return { cycle: true };
    const analysis = this.analyze(target, this.host.readOpen ? this.host.readOpen(target) : undefined);
    if (!analysis) return null;
    return { exports: analysis.exports, uri: target, analysis };
  }

  // names for completion inside import("...")
  listPaths(partial, from) {
    const base = from ? path.dirname(from) : process.cwd();
    const dirPart = partial.includes('/') ? partial.slice(0, partial.lastIndexOf('/') + 1) : '';
    const dir = path.resolve(base, dirPart || '.');
    const out = [];
    for (const e of this.host.list(dir) || []) {
      if (e.dir) out.push({ name: e.name + '/', dir: true });
      else if (e.name.endsWith('.raga')) out.push({ name: e.name.slice(0, -5) });
    }
    if (!dirPart && !partial.startsWith('.')) {
      out.unshift({ name: './', dir: true }, { name: '../', dir: true });
      // library names: the ones raga.project lists and the files of the libraries folder
      const root = this.projectRoot(from);
      const names = new Set(this.readProject(root).keys());
      if (root) for (const e of this.host.list(path.join(root, 'libraries')) || []) names.add(e.dir ? e.name : e.name.replace(/\.raga$/, ''));
      for (const n of names) out.push({ name: n });
    }
    return out;
  }
}

module.exports = { Workspace };
