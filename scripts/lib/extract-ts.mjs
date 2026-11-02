// Helpers to pull TypeScript declarations out of Marko 6 tag files and
// Storybook argTypes out of *.stories.ts files, without a TS compiler.

import vm from "node:vm";

/**
 * Walk `src` from `start`, skipping strings/comments, and return the index just
 * after the bracket that closes the one at `start`.
 */
export function matchBracket(src, start) {
  const open = src[start];
  const close = { "{": "}", "(": ")", "[": "]" }[open];
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(src, i);
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      i = src.indexOf("\n", i);
      if (i === -1) return src.length;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      i = src.indexOf("*/", i + 2) + 1;
      if (i === 0) return src.length;
      continue;
    }
    if (c === open) depth++;
    else if (c === close) {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return src.length;
}

function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1; j < src.length; j++) {
    if (src[j] === "\\") {
      j++;
      continue;
    }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") {
      j = matchBracket(src, j + 1) - 1;
      continue;
    }
    if (src[j] === q) return j;
  }
  return src.length;
}

const DECL_START = /^(?:export\s+)?(?:static\s+)?(?:export\s+)?(?:declare\s+)?(interface|type|const|enum|function)\s+([A-Za-z_$][\w$]*)/;

/**
 * Extract top-level TS declarations (interfaces, type aliases, static consts)
 * from a .marko or .ts file. Returns [{ kind, name, exported, text, doc }].
 */
export function extractDeclarations(src) {
  const out = [];
  const lines = src.split("\n");
  let offset = 0;
  const lineStarts = lines.map((l) => {
    const s = offset;
    offset += l.length + 1;
    return s;
  });
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    const m = DECL_START.exec(line);
    if (!m) continue;
    const start = lineStarts[li];
    // Walk forward until brackets are balanced and the declaration ends.
    let i = start;
    let depth = 0;
    let end = src.length;
    let sawBody = false;
    for (; i < src.length; i++) {
      const c = src[i];
      if (c === '"' || c === "'" || c === "`") {
        i = skipString(src, i);
        continue;
      }
      if (c === "/" && src[i + 1] === "/") {
        const nl = src.indexOf("\n", i);
        i = (nl === -1 ? src.length : nl) - 1;
        continue;
      }
      if (c === "{" || c === "(" || c === "[") {
        depth++;
        if (c === "{") sawBody = true;
      } else if (c === "}" || c === ")" || c === "]") {
        depth--;
        if (depth === 0 && c === "}" && (m[1] === "interface" || m[1] === "enum" || m[1] === "function")) {
          end = i + 1;
          break;
        }
      } else if (c === ";" && depth === 0) {
        end = i + 1;
        break;
      } else if (c === "\n" && depth === 0 && i > start && m[1] !== "interface") {
        // A statement without a trailing semicolon ends at a newline when the
        // next line does not continue it.
        const next = src.slice(i + 1).match(/^\s*(\S)/);
        if (!next || !/[|&=.?:,+\-*/<>]/.test(next[1])) {
          if (sawBody || !/[=|&,(]\s*$/.test(src.slice(start, i))) {
            end = i;
            break;
          }
        }
      }
    }
    const text = src.slice(start, end).trim();
    out.push({
      kind: m[1],
      name: m[2],
      exported: /\bexport\b/.test(line.split(m[1])[0]),
      text,
      doc: leadingDoc(lines, li),
    });
    // Skip lines consumed by this declaration.
    while (li + 1 < lines.length && lineStarts[li + 1] < end) li++;
  }
  return out;
}

function leadingDoc(lines, li) {
  let j = li - 1;
  if (j < 0 || !/\*\/\s*$/.test(lines[j])) return "";
  const buf = [];
  for (; j >= 0; j--) {
    buf.unshift(lines[j]);
    if (/^\s*\/\*\*/.test(lines[j])) break;
  }
  return cleanJsDoc(buf.join("\n"));
}

export function cleanJsDoc(text) {
  return text
    .replace(/^\s*\/\*\*?/, "")
    .replace(/\*\/\s*$/, "")
    .split("\n")
    .map((l) => l.replace(/^\s*\* ?/, ""))
    .join("\n")
    .trim();
}

/**
 * Parse the members of an `interface X extends Y { ... }` declaration.
 * Returns { name, extends: string[], members: [{ name, optional, type, doc }] }.
 */
export function parseInterface(text) {
  const nameMatch = /interface\s+([\w$]+)/.exec(text);
  if (!nameMatch) return null;
  // Find the body's opening brace: the first "{" outside strings and generics.
  let bodyStart = -1;
  let angle = 0;
  for (let k = nameMatch.index + nameMatch[0].length; k < text.length; k++) {
    const c = text[k];
    if (c === '"' || c === "'" || c === "`") {
      k = skipString(text, k);
      continue;
    }
    if (c === "<") angle++;
    else if (c === ">") angle--;
    else if (c === "{" && angle === 0) {
      bodyStart = k;
      break;
    }
  }
  if (bodyStart === -1) return null;
  const headText = text.slice(nameMatch.index + nameMatch[0].length, bodyStart);
  const ext = /^\s*(?:<[\s\S]*?>)?\s*extends\s+([\s\S]*)$/.exec(headText);
  const head = [null, nameMatch[1], ext ? ext[1].trim() : ""];
  const bodyEnd = matchBracket(text, bodyStart);
  const body = text.slice(bodyStart + 1, bodyEnd - 1);
  const members = [];
  let i = 0;
  let pendingDoc = "";
  while (i < body.length) {
    // skip whitespace
    while (i < body.length && /\s/.test(body[i])) i++;
    if (i >= body.length) break;
    if (body.startsWith("/**", i) || body.startsWith("/*", i)) {
      const e = body.indexOf("*/", i);
      pendingDoc = cleanJsDoc(body.slice(i, e + 2));
      i = e + 2;
      continue;
    }
    if (body.startsWith("//", i)) {
      const e = body.indexOf("\n", i);
      i = e === -1 ? body.length : e + 1;
      continue;
    }
    // read a member up to ; or newline at depth 0
    let j = i;
    let depth = 0;
    for (; j < body.length; j++) {
      const c = body[j];
      if (c === '"' || c === "'" || c === "`") {
        j = skipString(body, j);
        continue;
      }
      if (c === "{" || c === "(" || c === "[" || c === "<") depth++;
      else if (c === "}" || c === ")" || c === "]" || (c === ">" && body[j - 1] !== "=")) depth = Math.max(0, depth - 1);
      else if ((c === ";" || c === ",") && depth === 0) break;
      else if (c === "\n" && depth === 0) {
        const rest = body.slice(j + 1).match(/^\s*(\S)/);
        if (!rest || !/[|&]/.test(rest[1])) break;
      }
    }
    const raw = body.slice(i, j).trim();
    i = j + 1;
    if (!raw) continue;
    const prop = /^(?:readonly\s+)?(\[[^\]]+\]|"[^"]+"|'[^']+'|`[^`]+`|[\w$@-]+)(\?)?\s*:\s*([\s\S]+)$/.exec(raw);
    const method = /^([\w$]+)(\?)?\s*(\([\s\S]*)$/.exec(raw);
    if (prop) {
      members.push({
        name: prop[1].replace(/^["'`]|["'`]$/g, ""),
        optional: Boolean(prop[2]),
        type: prop[3].replace(/\s+/g, " ").trim(),
        doc: pendingDoc,
      });
    } else if (method) {
      members.push({ name: method[1], optional: Boolean(method[2]), type: method[3].replace(/\s+/g, " ").trim(), doc: pendingDoc });
    }
    pendingDoc = "";
  }
  return {
    name: head[1],
    extends: head[2] ? splitTopLevel(head[2], ",") : [],
    members,
  };
}

export function splitTopLevel(text, sep) {
  const out = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if ("<({[".includes(c)) depth++;
    else if (">)}]".includes(c)) depth--;
    if (c === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** Remove TypeScript-only syntax that would stop an object literal from evaluating. */
function stripTsFromLiteral(src) {
  let out = "";
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === '"' || c === "'" || c === "`") {
      const e = skipString(src, i);
      out += src.slice(i, e + 1);
      i = e;
      continue;
    }
    const rest = src.slice(i);
    const asMatch = /^\s+(?:as|satisfies)\s+(?:const\b|[A-Za-z_$][\w$.]*(?:<[^>]*>)?(?:\[\])?)/.exec(rest);
    if (asMatch && /[\w$\])"'`]/.test(src[i - 1] || "")) {
      i += asMatch[0].length - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Extract and evaluate the `argTypes: {...}` object from a Storybook stories file.
 * Evaluation happens in an isolated vm context where every free identifier
 * resolves to undefined, so references to imports or helpers do not break it.
 */
export function extractArgTypes(src) {
  const idx = src.search(/\bargTypes\s*:\s*\{/);
  if (idx === -1) return null;
  const start = src.indexOf("{", idx);
  const end = matchBracket(src, start);
  const literal = stripTsFromLiteral(src.slice(start, end));
  const code = `
    "use strict";
    (function () {
      const allowed = { Object, Array, JSON, String, Number, Boolean, Math, undefined, Infinity, NaN };
      const scope = new Proxy({}, {
        has: () => true,
        get: (_t, k) => (k === Symbol.unscopables ? undefined : allowed[k]),
      });
      const fn = new Function("scope", "with (scope) { return (" + SOURCE + "); }");
      return JSON.stringify(fn(scope), (k, v) => (typeof v === "function" ? undefined : v));
    })()`;
  const run = (source) => JSON.parse(vm.runInNewContext(code, { SOURCE: source }, { timeout: 1000 }));
  try {
    return run(literal);
  } catch {
    // Fall back to evaluating each top-level entry on its own so that one
    // entry referencing a local helper does not lose the whole table.
    const out = {};
    for (const entry of splitTopLevelEntries(literal.slice(1, -1))) {
      try {
        Object.assign(out, run(`{${entry}}`));
      } catch {
        const key = /^\s*(?:\[\s*)?["'`]?([^"'`:\]]+)/.exec(entry);
        const desc = /description\s*:\s*(["'`])([\s\S]*?)\1/.exec(entry);
        if (key) out[key[1].trim()] = { description: desc ? desc[2] : "" };
      }
    }
    return Object.keys(out).length ? out : null;
  }
}

function splitTopLevelEntries(body) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'" || c === "`") {
      i = skipString(body, i);
      continue;
    }
    if (c === "{" || c === "(" || c === "[") depth++;
    else if (c === "}" || c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      if (body.slice(start, i).trim()) out.push(body.slice(start, i));
      start = i + 1;
    }
  }
  if (body.slice(start).trim()) out.push(body.slice(start));
  return out;
}

/** Extract the Storybook `title` of the default export. */
export function extractStoryTitle(src) {
  const m = /\btitle\s*:\s*["'`]([^"'`]+)["'`]/.exec(src);
  return m ? m[1] : null;
}

/** Storybook id slug, matching storybook's `sanitize` (lowercase, non-alnum -> '-'). */
export function storybookId(title) {
  return title
    .toLowerCase()
    .replace(/[ ’–—―′¿'`~!@#$%^&*()_|+\-=?;:'",.<>{}[\]\\/]/gi, "-")
    .replace(/-+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "");
}
