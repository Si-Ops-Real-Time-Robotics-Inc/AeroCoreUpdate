#!/usr/bin/env node
/**
 * Find functions that are called but never defined.
 *
 * `node --check` parses; it does not resolve names, so a call to a function nobody wrote is
 * valid syntax and fails only when a user reaches that branch in a browser. That has now
 * happened twice in this project (`insertAudit`, `shippedConfigSection`), both times in code
 * no test executes, so the parse check alone is not enough.
 *
 * This is deliberately a lexical scan rather than a real resolver: it collects every name that
 * could be a binding anywhere in the file and every name used in call position, then reports
 * the difference. Over-collecting bindings is the safe direction — it can miss a genuine
 * problem, but it will not stop a build over a name that is actually fine.
 *
 *   node scripts/check-refs.mjs public/admin/app.js src/**\/*.js
 */
import { readFile } from 'node:fs/promises';
import { glob } from 'node:fs/promises';

// Keywords that are followed by '(' and are not calls.
const KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'typeof', 'new', 'delete', 'void',
  'do', 'else', 'in', 'of', 'await', 'yield', 'throw', 'case', 'function', 'class',
  'const', 'let', 'var', 'import', 'export', 'default', 'instanceof', 'super', 'this',
  // `async (req, res) => {}` puts `async` in call position without being one.
  'async', 'constructor',
]);

const GLOBALS = new Set([
  // Language
  'Array', 'Object', 'String', 'Number', 'Boolean', 'Symbol', 'BigInt', 'Math', 'JSON',
  'Date', 'RegExp', 'Error', 'TypeError', 'RangeError', 'SyntaxError', 'Promise', 'Map',
  'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect', 'parseInt', 'parseFloat', 'isNaN',
  'isFinite', 'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'structuredClone', 'queueMicrotask', 'globalThis', 'Intl',
  // Browser
  'document', 'window', 'fetch', 'alert', 'confirm', 'prompt', 'setTimeout', 'clearTimeout',
  'setInterval', 'clearInterval', 'requestAnimationFrame', 'FormData', 'URL', 'URLSearchParams',
  'Blob', 'File', 'FileReader', 'Headers', 'Request', 'Response', 'AbortController',
  'CustomEvent', 'Event', 'DataTransfer', 'localStorage', 'sessionStorage', 'atob', 'btoa',
  'Option', 'Image', 'Audio', 'Node', 'Element', 'HTMLElement', 'WebSocket', 'EventSource',
  'Worker', 'Notification', 'MutationObserver', 'IntersectionObserver', 'ResizeObserver',
  'TextEncoder', 'TextDecoder', 'Uint8Array', 'ArrayBuffer', 'DOMParser', 'XMLHttpRequest',
  // Node
  'process', 'Buffer', 'require', 'console', '__dirname', '__filename', 'setImmediate',
  'navigator', 'crypto',
]);

/** Every name that could plausibly be a binding in this file. */
function bindings(src) {
  const names = new Set();
  const add = (name) => { if (name) names.add(name); };

  const patterns = [
    // declarations
    /\b(?:function|class)\s*\*?\s*([A-Za-z_$][\w$]*)/g,
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    // import { a, b as c } / import d / import * as e
    /\bimport\s+(?:\*\s+as\s+)?([A-Za-z_$][\w$]*)/g,
    // object shorthand and destructuring members, e.g. `const { a, b: c }` and `{ a, b }` in
    // an import clause; also catches object literal keys, which is harmless over-collection.
    /([A-Za-z_$][\w$]*)\s*(?:,|\}|:|=)/g,
    // parameters: anything inside a parameter list. Over-collects, on purpose.
    /(?:function\s*\*?\s*[A-Za-z_$\w$]*\s*|=>\s*|\)\s*=>|\b)\(([^)]*)\)\s*(?:=>|\{)/g,
    // catch (err), for (const x of ...), labelled bindings
    /\bcatch\s*\(\s*([A-Za-z_$][\w$]*)/g,
    /\bfor\s*\(\s*(?:const|let|var)\s+([A-Za-z_$][\w$]*)/g,
    // Method shorthand, in a class body or an object literal: `close() { ... }`. Written this
    // way the name never appears in a `const`/`function` form, so without this every call to
    // one reads as undefined.
    /(?:^|[{;},])\s*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?\*?\s*([A-Za-z_$][\w$]*)\s*\([^()]*\)\s*\{/gm,
    // Parameter lists: everything between parens that a `=>` or a body follows.
    /\(([^()]*)\)\s*(?:=>|\{)/g,
  ];

  for (const re of patterns) {
    for (const match of src.matchAll(re)) {
      for (const part of match[1].split(/[^A-Za-z_$\w$]+/)) add(part);
    }
  }
  return names;
}

/**
 * Every name used in call position, excluding keywords and member calls. `#` is excluded
 * alongside `.` because `this.#pull()` is a private-field access, not a bare identifier.
 */
function calls(src) {
  const found = new Map();
  const re = /(^|[^.#\w$])([A-Za-z_$][\w$]*)\s*\(/g;

  for (const match of src.matchAll(re)) {
    const name = match[2];
    if (KEYWORDS.has(name)) continue;
    if (!found.has(name)) {
      found.set(name, src.slice(0, match.index).split('\n').length);
    }
  }
  return found;
}

/**
 * Blank out comments and string bodies, preserving every byte offset so reported line numbers
 * stay true.
 *
 * A character scanner rather than regexes: a template literal can nest `${ ... }` containing
 * further templates, and a regex written as /.../ can contain quotes and slashes. Both defeat
 * the obvious patterns, and getting it wrong reports text like `Warnings (${n})` as a call to
 * a function named Warnings.
 */
function strip(src) {
  const out = src.split('');
  const blank = (from, to) => {
    for (let k = from; k < to; k += 1) if (out[k] !== '\n') out[k] = ' ';
  };

  // Each template literal pushes a frame; `${` inside one pushes brace depth so the matching
  // `}` returns to template text rather than ending the expression early.
  const templates = [];
  let i = 0;
  let prev = '';

  while (i < src.length) {
    const c = src[i];
    const next = src[i + 1];

    if (c === '/' && next === '/') {
      const end = src.indexOf('\n', i);
      blank(i, end === -1 ? src.length : end);
      i = end === -1 ? src.length : end;
      continue;
    }
    if (c === '/' && next === '*') {
      const end = src.indexOf('*/', i + 2);
      blank(i, end === -1 ? src.length : end + 2);
      i = end === -1 ? src.length : end + 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < src.length && src[j] !== c) j += src[j] === '\\' ? 2 : 1;
      blank(i + 1, j);
      i = j + 1;
      prev = c;
      continue;
    }
    if (c === '`') {
      templates.push(0);
      i += 1;
      // Template text runs until ` or ${, whichever comes first.
      while (i < src.length && templates.length) {
        if (src[i] === '\\') { blank(i, i + 2); i += 2; continue; }
        if (src[i] === '`') { templates.pop(); i += 1; break; }
        if (src[i] === '$' && src[i + 1] === '{') { i += 2; break; }
        blank(i, i + 1);
        i += 1;
      }
      prev = '`';
      continue;
    }
    if (c === '}' && templates.length) {
      if (templates[templates.length - 1] === 0) {
        // Back into template text: resume blanking from here.
        i += 1;
        while (i < src.length) {
          if (src[i] === '\\') { blank(i, i + 2); i += 2; continue; }
          if (src[i] === '`') { templates.pop(); i += 1; break; }
          if (src[i] === '$' && src[i + 1] === '{') { i += 2; break; }
          blank(i, i + 1);
          i += 1;
        }
        prev = '}';
        continue;
      }
      templates[templates.length - 1] -= 1;
    }
    if (c === '{' && templates.length) templates[templates.length - 1] += 1;

    // A '/' is a regex only where a value cannot already have ended.
    if (c === '/' && !/[\w$)\]]/.test(prev)) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true;
        else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        else if (src[j] === '\n') break;
        j += 1;
      }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; prev = '/'; continue; }
    }

    if (!/\s/.test(c)) prev = c;
    i += 1;
  }
  return out.join('');
}

const targets = [];
for (const pattern of process.argv.slice(2)) {
  if (pattern.includes('*')) for await (const f of glob(pattern)) targets.push(f);
  else targets.push(pattern);
}

/**
 * Members used through a namespace import — `admin.uploadArtifact`, `catalogAdmin.createRelease`.
 *
 * The call scan above deliberately ignores anything after a dot, because it cannot tell a
 * member call from a property that happens to be callable. That blind spot is not theoretical:
 * deleting a block of functions left routes and services pointing at `undefined` twice in one
 * afternoon, and every other check in this file still passed both times.
 *
 * So namespaces get their own pass, resolving each member against what the module really
 * exports. Only `import * as ns` is followed — a named import is already a binding the lexical
 * scan sees.
 */
async function checkNamespaceMembers(files) {
  let missing = 0;

  for (const file of files) {
    // The import map comes from the RAW source: a module specifier is a string literal, and
    // strip() blanks string contents — scanning the stripped copy for it finds nothing, which
    // is how the first version of this check silently passed on a file it should have failed.
    const raw = await readFile(file, 'utf8');
    const imports = new Map(
      [...raw.matchAll(/import \* as (\w+) from '(\.[^']+)'/g)].map((m) => [m[1], m[2]]),
    );
    if (!imports.size) continue;

    // Member usage, however, must come from the stripped copy: `admin.foo` inside a comment
    // or a message string is not a reference.
    const src = strip(raw);

    const seen = new Set();
    for (const [, ns, name] of src.matchAll(/\b(\w+)\.(\w+)\b/g)) {
      if (!imports.has(ns) || seen.has(`${ns}.${name}`)) continue;
      seen.add(`${ns}.${name}`);

      const target = new URL(imports.get(ns), new URL(file, `file://${process.cwd()}/`));

      // An import that throws is reported, not skipped. Swallowing it turned this check into a
      // no-op exactly when it mattered most: a named import of an export that no longer exists
      // is a SyntaxError at load, and `catch(() => null)` made every module downstream of it
      // look clean.
      let mod;
      try {
        mod = await import(target.href);
      } catch (err) {
        console.error(`${file}  cannot load ${imports.get(ns)} — ${err.message.split('\n')[0]}`);
        missing += 1;
        continue;
      }

      if (!(name in mod)) {
        console.error(`${file}  ${ns}.${name} is used but not exported`);
        missing += 1;
      }
    }
  }
  return missing;
}

let bad = 0;
for (const file of targets.sort()) {
  const src = strip(await readFile(file, 'utf8'));
  const defined = bindings(src);

  for (const [name, line] of calls(src)) {
    if (defined.has(name) || GLOBALS.has(name)) continue;
    console.error(`${file}:${line}  ${name}() is called but never defined`);
    bad += 1;
  }
}

// Only worth running when the tree parses; a syntax error would surface here as a bogus
// "not exported" for every handler in the file.
if (bad === 0 && process.env.CHECK_REFS_SKIP_ROUTES !== '1') {
  bad += await checkNamespaceMembers(targets.filter((f) => f.startsWith('src/')));
}

console.log(bad === 0
  ? `check-refs: ${targets.length} file(s), no undefined calls, every import resolves`
  : `check-refs: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
