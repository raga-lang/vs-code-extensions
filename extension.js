'use strict';

// The Raga extension: diagnostics, hover, completion, signature help, go to definition, references,
// rename, outline and inlay hints. The language work is in src/ and does not use vscode.

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { Workspace } = require('./src/workspace');
const Q = require('./src/queries');

const KINDS = {
  variable: 'Variable', constant: 'Constant', function: 'Function', method: 'Method', field: 'Field', property: 'Property',
  class: 'Class', struct: 'Struct', enum: 'Enum', interface: 'Interface', enumMember: 'EnumMember', module: 'Module',
  keyword: 'Keyword', typeParameter: 'TypeParameter', file: 'File',
};
const SYMBOL_KINDS = {
  variable: 'Variable', constant: 'Constant', function: 'Function', method: 'Method', field: 'Field', property: 'Property',
  class: 'Class', struct: 'Struct', enum: 'Enum', interface: 'Interface', enumMember: 'EnumMember', typeParameter: 'TypeParameter',
};

function activate(context) {
  const output = vscode.window.createOutputChannel('Raga');
  context.subscriptions.push(output);

  const host = {
    read(file) {
      try { return fs.readFileSync(file, 'utf8'); } catch (e) { return null; }
    },
    readOpen(file) {
      const doc = vscode.workspace.textDocuments.find((d) => d.uri.scheme === 'file' && d.uri.fsPath === file);
      return doc ? doc.getText() : undefined;
    },
    list(dir) {
      try { return fs.readdirSync(dir, { withFileTypes: true }).map((e) => ({ name: e.name, dir: e.isDirectory() })); } catch (e) { return []; }
    },
  };
  const workspace = new Workspace(host);

  function analysisFor(document) {
    try {
      return workspace.analyze(document.uri.fsPath, document.getText());
    } catch (e) {
      output.appendLine(`analysis failed for ${document.uri.fsPath}: ${e && e.stack}`);
      return null;
    }
  }
  const range = (document, s, e) => new vscode.Range(document.positionAt(s), document.positionAt(e));
  const config = () => vscode.workspace.getConfiguration('raga');
  const selector = { language: 'raga' };

  // ---------------------------------------------------------------- diagnostics
  const collection = vscode.languages.createDiagnosticCollection('raga');
  context.subscriptions.push(collection);
  const check = (document) => {
    if (document.languageId !== 'raga') return;
    if (!config().get('diagnostics.enabled', true)) { collection.delete(document.uri); return; }
    const a = analysisFor(document);
    if (!a) return;
    const list = Q.diagnostics(a).map((d) => {
      const severity = d.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error;
      const diagnostic = new vscode.Diagnostic(range(document, d.s, d.e), d.message, severity);
      diagnostic.source = 'raga';
      return diagnostic;
    });
    collection.set(document.uri, list);
  };
  let timer;
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(check),
    vscode.workspace.onDidChangeTextDocument((e) => {
      workspace.bump();
      clearTimeout(timer);
      timer = setTimeout(() => {
        check(e.document);
        // a file that imports this one may see new names
        vscode.workspace.textDocuments.forEach((d) => { if (d !== e.document) check(d); });
      }, 250);
    }),
    vscode.workspace.onDidCloseTextDocument((document) => collection.delete(document.uri)),
    vscode.workspace.onDidChangeConfiguration(() => vscode.workspace.textDocuments.forEach(check)),
  );
  vscode.workspace.textDocuments.forEach(check);

  // raga.project and the files of a project can change on disk, outside the editor: what an import finds changes with them
  const diskWatcher = vscode.workspace.createFileSystemWatcher('**/{raga.project,*.raga}');
  const diskChanged = () => { workspace.bump(); vscode.workspace.textDocuments.forEach(check); };
  context.subscriptions.push(diskWatcher, diskWatcher.onDidChange(diskChanged), diskWatcher.onDidCreate(diskChanged), diskWatcher.onDidDelete(diskChanged));

  // ---------------------------------------------------------------- hover
  context.subscriptions.push(vscode.languages.registerHoverProvider(selector, {
    provideHover(document, position) {
      const a = analysisFor(document);
      if (!a) return undefined;
      const h = Q.hover(a, document.offsetAt(position));
      if (!h) return undefined;
      return new vscode.Hover(new vscode.MarkdownString(h.markdown), range(document, h.start, h.end));
    },
  }));

  // ---------------------------------------------------------------- completion
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider(selector, {
    provideCompletionItems(document, position, token, completionContext) {
      const a = analysisFor(document);
      if (!a) return undefined;
      const result = Q.completion(a, document.offsetAt(position), { listPaths: (p, from) => workspace.listPaths(p, from) });
      // a space opens the list only where a block can follow: after the ) of a call, or after the } of a block
      if (completionContext && completionContext.triggerCharacter === ' ' && !result.blockOnly) return undefined;
      const items = result.items.map((it) => {
        const item = new vscode.CompletionItem(it.label, vscode.CompletionItemKind[KINDS[it.kind] || 'Text']);
        item.detail = it.detail;
        if (it.doc) item.documentation = new vscode.MarkdownString(it.doc);
        item.sortText = it.sort || it.label;
        item.filterText = it.label.replace(/ =$/, '');
        if (it.insert && it.insert !== it.label) item.insertText = it.snippet ? new vscode.SnippetString(it.insert) : it.insert;
        else if (it.snippet) item.insertText = new vscode.SnippetString(it.insert || it.label);
        if (it.snippet && /\(\)$|\$0\)$/.test(it.insert || '') && it.kind !== 'keyword') {
          item.command = { command: 'editor.action.triggerParameterHints', title: 'Parameter hints' };
        }
        return item;
      });
      return new vscode.CompletionList(items, false);
    },
  }, '.', '"', '/', '(', ' '));

  // ---------------------------------------------------------------- signature help
  context.subscriptions.push(vscode.languages.registerSignatureHelpProvider(selector, {
    provideSignatureHelp(document, position) {
      const a = analysisFor(document);
      if (!a) return undefined;
      const s = Q.signatureAt(a, document.offsetAt(position));
      if (!s) return undefined;
      const info = new vscode.SignatureInformation(s.label, s.doc ? new vscode.MarkdownString(s.doc) : undefined);
      let from = s.label.indexOf('(') + 1;
      info.parameters = s.parameters.map((p) => {
        const at = s.label.indexOf(p, from);
        const label = at >= 0 ? [at, at + p.length] : p;
        if (at >= 0) from = at + p.length;
        return new vscode.ParameterInformation(label);
      });
      const help = new vscode.SignatureHelp();
      help.signatures = [info];
      help.activeSignature = 0;
      help.activeParameter = s.active;
      return help;
    },
  }, '(', ','));

  // ---------------------------------------------------------------- definition
  context.subscriptions.push(vscode.languages.registerDefinitionProvider(selector, {
    async provideDefinition(document, position) {
      const a = analysisFor(document);
      if (!a) return undefined;
      const d = Q.definition(a, document.offsetAt(position));
      if (!d || d.builtin) return undefined;
      // a LocationLink says which text is the link, so the underline covers all of it (a whole import path)
      const origin = d.from ? range(document, d.from.s, d.from.e) : undefined;
      if (!d.uri || d.uri === document.uri.fsPath) {
        const target = range(document, d.s, d.e);
        return [{ originSelectionRange: origin, targetUri: document.uri, targetRange: target, targetSelectionRange: target }];
      }
      const other = await vscode.workspace.openTextDocument(vscode.Uri.file(d.uri));
      const target = range(other, d.s, d.e);
      return [{ originSelectionRange: origin, targetUri: other.uri, targetRange: target, targetSelectionRange: target }];
    },
  }));

  // ---------------------------------------------------------------- references and rename
  context.subscriptions.push(vscode.languages.registerReferenceProvider(selector, {
    provideReferences(document, position) {
      const a = analysisFor(document);
      if (!a) return [];
      const r = Q.referencesTo(a, document.offsetAt(position));
      if (!r || !r.ranges) return [];
      return r.ranges.map((x) => new vscode.Location(document.uri, range(document, x.s, x.e)));
    },
  }));
  context.subscriptions.push(vscode.languages.registerRenameProvider(selector, {
    prepareRename(document, position) {
      const a = analysisFor(document);
      const hit = a && Q.findAt(a, document.offsetAt(position));
      if (!hit || !hit.sym || hit.sym.builtin || hit.sym.analysis !== a) throw new Error('This name cannot be renamed');
      return range(document, hit.s, hit.e);
    },
    provideRenameEdits(document, position, newName) {
      const a = analysisFor(document);
      if (!a) return undefined;
      if (!/^[A-Za-z_]\w*$/.test(newName) || Q.KEYWORDS.has(newName)) throw new Error(`${newName} is not a valid name`);
      const r = Q.referencesTo(a, document.offsetAt(position));
      if (!r || !r.ranges || !r.ranges.length) return undefined;
      const edit = new vscode.WorkspaceEdit();
      for (const x of r.ranges) edit.replace(document.uri, range(document, x.s, x.e), newName);
      return edit;
    },
  }));

  // ---------------------------------------------------------------- outline
  context.subscriptions.push(vscode.languages.registerDocumentSymbolProvider(selector, {
    provideDocumentSymbols(document) {
      const a = analysisFor(document);
      if (!a) return [];
      const conv = (n) => {
        const sym = new vscode.DocumentSymbol(n.name, n.detail || '', vscode.SymbolKind[SYMBOL_KINDS[n.kind] || 'Variable'], range(document, n.range.s, n.range.e), range(document, n.selection.s, n.selection.e));
        sym.children = (n.children || []).map(conv);
        return sym;
      };
      return Q.documentSymbols(a).map(conv);
    },
  }));

  // ---------------------------------------------------------------- inlay hints: the inferred types
  if (vscode.languages.registerInlayHintsProvider) {
    const changed = new vscode.EventEmitter();
    context.subscriptions.push(changed, vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('raga.inlayHints')) changed.fire(); }));
    context.subscriptions.push(vscode.languages.registerInlayHintsProvider(selector, {
      onDidChangeInlayHints: changed.event,
      provideInlayHints(document, rng) {
        if (!config().get('inlayHints.enabled', true)) return [];
        const a = analysisFor(document);
        if (!a) return [];
        const hints = [];
        for (const h of Q.inlayHints(a)) {
          const pos = document.positionAt(h.offset);
          if (!rng.contains(pos)) continue;
          const hint = new vscode.InlayHint(pos, h.label, vscode.InlayHintKind.Type);
          hint.paddingLeft = false;
          hints.push(hint);
        }
        return hints;
      },
    }));
  }
}

function deactivate() {}

module.exports = { activate, deactivate };
