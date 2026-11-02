// Small, dependency-free HTML -> Markdown converter.
//
// It is lenient on purpose: it is used both on live HTML fetched from
// markojs.com / opensource.ebay.com and on Marko templates from the evo-web
// repository (which are HTML-like but contain `${expr}` placeholders,
// unquoted JS attribute values and custom tags).

const VOID = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "param", "source", "track", "wbr",
]);
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);
const SKIP = new Set([
  "script", "style", "svg", "noscript", "template", "iframe", "video", "audio",
  "canvas", "select", "option", "input", "textarea", "button", "form-control",
  "head", "title", "meta", "link", "img", "picture", "source", "object",
  "icon-symbol", "component-banner-img", "master-icons", "site-header",
  "site-footer", "navrail", "dialog",
]);
const BLOCK = new Set([
  "address", "article", "aside", "blockquote", "body", "caption", "dd", "details",
  "div", "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1",
  "h2", "h3", "h4", "h5", "h6", "header", "hr", "html", "legend", "li", "main",
  "ol", "p", "pre", "section", "summary", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul",
]);

const ENTITIES = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", mdash: "—",
  ndash: "–", hellip: "…", copy: "©", reg: "®", trade: "™", rsquo: "’",
  lsquo: "‘", rdquo: "”", ldquo: "“", bull: "•", middot: "·", times: "×",
  rarr: "→", larr: "←", uarr: "↑", darr: "↓", laquo: "«", raquo: "»",
};

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    const v = ENTITIES[e.toLowerCase()];
    return v === undefined ? m : v;
  });
}

/** Find the end (index of the closing `>`) of a tag starting at `start` ("<"). */
function findTagEnd(src, start) {
  let depth = 0;
  let quote = null;
  for (let i = start + 1; i < src.length; i++) {
    const c = src[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth = Math.max(0, depth - 1);
    else if (c === ">" && depth === 0 && src[i - 1] !== "=") return i;
  }
  return -1;
}

function parseAttrs(str) {
  const attrs = {};
  const re = /([^\s=\/>]+)(?:\s*=\s*("[^"]*"|'[^']*'|`[^`]*`|[^\s>]+))?/g;
  let m;
  while ((m = re.exec(str))) {
    let v = m[2];
    if (v === undefined) v = "";
    else if (/^["'`]/.test(v)) v = v.slice(1, -1);
    else v = { expr: v };
    attrs[m[1].toLowerCase()] = v;
  }
  return attrs;
}

/**
 * Parse HTML into a minimal tree: { type: "el", name, attrs, children, raw? } | { type: "text", text }.
 * `rawTags` keeps the inner source of those tags verbatim (used for code samples).
 */
export function parseHtml(src, { rawTags = [] } = {}) {
  const raw = new Set([...RAW_TEXT, ...rawTags]);
  const root = { type: "el", name: "#root", attrs: {}, children: [] };
  const stack = [root];
  let i = 0;
  const top = () => stack[stack.length - 1];
  while (i < src.length) {
    const lt = src.indexOf("<", i);
    if (lt === -1) {
      top().children.push({ type: "text", text: src.slice(i) });
      break;
    }
    if (lt > i) top().children.push({ type: "text", text: src.slice(i, lt) });
    if (src.startsWith("<!--", lt)) {
      const end = src.indexOf("-->", lt + 4);
      i = end === -1 ? src.length : end + 3;
      continue;
    }
    if (src[lt + 1] === "!" || src[lt + 1] === "?") {
      const end = src.indexOf(">", lt);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    const close = src[lt + 1] === "/";
    const nameMatch = /^[a-zA-Z@$][\w:.@$-]*/.exec(src.slice(lt + (close ? 2 : 1), lt + 80));
    if (!nameMatch) {
      top().children.push({ type: "text", text: "<" });
      i = lt + 1;
      continue;
    }
    const end = findTagEnd(src, lt);
    if (end === -1) {
      top().children.push({ type: "text", text: src.slice(lt) });
      break;
    }
    const name = nameMatch[0].toLowerCase();
    if (close) {
      for (let s = stack.length - 1; s > 0; s--) {
        if (stack[s].name === name) {
          stack.length = s;
          break;
        }
      }
      i = end + 1;
      continue;
    }
    const inner = src.slice(lt + 1 + nameMatch[0].length, end);
    const selfClose = /\/\s*$/.test(inner);
    // Marko tag params/args such as <for|item| of=list> are stripped before attribute parsing.
    const attrStr = inner.replace(/^\s*\|[^|]*\|/, "").replace(/\/\s*$/, "");
    const el = { type: "el", name, attrs: parseAttrs(attrStr), children: [] };
    top().children.push(el);
    i = end + 1;
    if (selfClose || VOID.has(name)) continue;
    if (raw.has(name)) {
      // Find matching close tag, accounting for nesting of the same tag.
      const openRe = new RegExp(`<${name}[\\s/>]|</${name}\\s*>`, "gi");
      openRe.lastIndex = i;
      let depth = 1;
      let m;
      let closeAt = src.length;
      let after = src.length;
      while ((m = openRe.exec(src))) {
        if (m[0][1] === "/") {
          depth--;
          if (depth === 0) {
            closeAt = m.index;
            after = m.index + m[0].length;
            break;
          }
        } else depth++;
      }
      el.raw = src.slice(i, closeAt);
      i = after;
      continue;
    }
    stack.push(el);
  }
  return root;
}

function hasClass(el, cls) {
  const c = el.attrs.class;
  return typeof c === "string" && c.split(/\s+/).includes(cls);
}

function dedent(text) {
  const lines = text.replace(/^\s*\n/, "").replace(/\s+$/, "").split("\n");
  const indents = lines.filter((l) => l.trim()).map((l) => /^\s*/.exec(l)[0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return lines.map((l) => l.slice(min)).join("\n");
}

function textContent(node) {
  if (node.type === "text") return node.text;
  if (node.raw !== undefined) return node.raw;
  return node.children.map(textContent).join("");
}

function resolveHref(href, baseUrl) {
  if (!href || typeof href !== "string") return null;
  if (/^(javascript:|#$)/i.test(href)) return null;
  if (!baseUrl) return href;
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

function codeLang(el) {
  const fromAttr = (e) => {
    if (!e) return "";
    if (typeof e.attrs.type === "string") return e.attrs.type;
    if (typeof e.attrs["data-lang"] === "string") return e.attrs["data-lang"];
    const c = typeof e.attrs.class === "string" ? e.attrs.class : "";
    const m = /(?:language|lang)-([\w-]+)/.exec(c);
    return m ? m[1] : "";
  };
  const code = el.children.find((c) => c.type === "el" && c.name === "code");
  return fromAttr(el) || fromAttr(code);
}

/**
 * Convert a parsed tree (or HTML string) into Markdown.
 * Options:
 *  - baseUrl: resolve relative links against this URL
 *  - rawTags: tag names whose inner source is a code sample (e.g. "highlight-code")
 *  - skipClasses: elements carrying any of these classes are dropped
 *  - skipTags: extra tag names to drop
 */
export function htmlToMarkdown(input, opts = {}) {
  const { baseUrl, rawTags = [], skipClasses = [], skipTags = [] } = opts;
  const tree = typeof input === "string" ? parseHtml(input, { rawTags }) : input;
  const rawSet = new Set(rawTags);
  const skip = new Set([...SKIP, ...skipTags]);

  function inline(nodes, ctx) {
    let out = "";
    for (const n of nodes) out += renderInline(n, ctx);
    return out;
  }

  function renderInline(n, ctx) {
    if (n.type === "text") {
      const t = decodeEntities(n.text);
      return ctx.pre ? t : t.replace(/\s+/g, " ");
    }
    if (shouldSkip(n)) return "";
    if (BLOCK.has(n.name) || rawSet.has(n.name)) return "\n\n" + renderBlock(n, ctx) + "\n\n";
    const body = () => inline(n.children, ctx);
    switch (n.name) {
      case "br":
        return "\n";
      case "strong":
      case "b": {
        const b = body().trim();
        return b ? ` **${b}** ` : "";
      }
      case "em":
      case "i": {
        const b = body().trim();
        return b ? ` *${b}* ` : "";
      }
      case "s":
      case "del":
        return `~~${body().trim()}~~`;
      case "code":
      case "kbd":
      case "samp": {
        const t = decodeEntities(textContent(n)).replace(/\s+/g, " ").trim();
        if (!t) return "";
        const tick = t.includes("`") ? "``" : "`";
        return `${tick}${t}${tick}`;
      }
      case "a": {
        const b = body().replace(/\s+/g, " ").trim();
        const href = resolveHref(n.attrs.href, baseUrl);
        if (!b) return "";
        if (!href || href.startsWith("#")) return b;
        return `[${b}](${href})`;
      }
      case "sup":
        return `^${body().trim()}`;
      default:
        return body();
    }
  }

  function shouldSkip(n) {
    if (n.type !== "el") return false;
    if (skip.has(n.name)) return true;
    if (n.attrs.hidden !== undefined && n.attrs.hidden !== false) return true;
    if (n.attrs["aria-hidden"] === "true") return true;
    for (const c of skipClasses) if (hasClass(n, c)) return true;
    return false;
  }

  function blocks(nodes, ctx) {
    const parts = [];
    let buf = "";
    const flush = () => {
      const t = buf.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
      if (t) parts.push(t);
      buf = "";
    };
    for (const n of nodes) {
      if (n.type === "el" && !shouldSkip(n) && (BLOCK.has(n.name) || rawSet.has(n.name))) {
        flush();
        const b = renderBlock(n, ctx);
        if (b.trim()) parts.push(b);
      } else {
        buf += renderInline(n, ctx);
      }
    }
    flush();
    return parts.join("\n\n");
  }

  function renderList(n, ctx, ordered) {
    // Nested lists are rendered relative to their item and indented by the parent.
    let idx = 1;
    const items = [];
    for (const c of n.children) {
      if (c.type !== "el" || c.name !== "li" || shouldSkip(c)) continue;
      const marker = ordered ? `${idx++}.` : "-";
      const pad = " ".repeat(marker.length + 1);
      const content = blocks(c.children, ctx)
        .replace(/\n\n(?=(?:-|\d+\.) )/g, "\n")
        .split("\n")
        .map((l, i) => (i === 0 || !l.trim() ? l : pad + l))
        .join("\n");
      items.push(`${marker} ${content}`);
    }
    return items.join("\n");
  }

  function renderTable(n, ctx) {
    const rows = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (c.type !== "el" || shouldSkip(c)) continue;
        if (c.name === "tr") {
          rows.push(
            c.children
              .filter((x) => x.type === "el" && (x.name === "td" || x.name === "th"))
              .map((x) => inline(x.children, ctx).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim()),
          );
        } else if (c.name !== "caption") walk(c);
      }
    };
    walk(n);
    if (!rows.length) return "";
    const width = Math.max(...rows.map((r) => r.length));
    const pad = (r) => [...r, ...Array(width - r.length).fill("")];
    const lines = [`| ${pad(rows[0]).join(" | ")} |`, `| ${Array(width).fill("---").join(" | ")} |`];
    for (const r of rows.slice(1)) lines.push(`| ${pad(r).join(" | ")} |`);
    const caption = n.children.find((c) => c.type === "el" && c.name === "caption");
    const cap = caption ? `*${inline(caption.children, ctx).trim()}*\n\n` : "";
    return cap + lines.join("\n");
  }

  function renderBlock(n, ctx) {
    if (rawSet.has(n.name)) {
      const lang = typeof n.attrs.type === "string" ? n.attrs.type : typeof n.attrs.lang === "string" ? n.attrs.lang : "";
      return "```" + lang + "\n" + dedent(n.raw ?? textContent(n)) + "\n```";
    }
    switch (n.name) {
      case "h1":
      case "h2":
      case "h3":
      case "h4":
      case "h5":
      case "h6": {
        const t = inline(n.children, ctx).replace(/\s+/g, " ").trim();
        return t ? `${"#".repeat(Number(n.name[1]))} ${t}` : "";
      }
      case "pre": {
        const lang = codeLang(n);
        return "```" + lang + "\n" + dedent(decodeEntities(textContent(n))) + "\n```";
      }
      case "ul":
        return renderList(n, ctx, false);
      case "ol":
        return renderList(n, ctx, true);
      case "table":
        return renderTable(n, ctx);
      case "blockquote":
        return blocks(n.children, ctx)
          .split("\n")
          .map((l) => `> ${l}`)
          .join("\n");
      case "hr":
        return "---";
      case "dt":
        return `**${inline(n.children, ctx).replace(/\s+/g, " ").trim()}**`;
      case "dd":
        return `: ${blocks(n.children, ctx)}`;
      case "summary":
        return `**${inline(n.children, ctx).replace(/\s+/g, " ").trim()}**`;
      default:
        return blocks(n.children, ctx);
    }
  }

  return tidy(blocks(tree.children, {}));
}

/** Collapse stray spacing outside fenced code blocks. */
function tidy(md) {
  let inFence = false;
  return md
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const indent = /^\s*/.exec(line)[0];
      return (
        indent +
        line
          .slice(indent.length)
          .replace(/ {2,}/g, " ")
          .replace(/ +([.,;:!?)])/g, "$1")
          .replace(/\( +/g, "(")
          .replace(/[ \t]+$/, "")
      );
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Pick the main content element of a full HTML page. */
export function extractMain(tree) {
  let best = null;
  const visit = (n) => {
    if (n.type !== "el") return;
    if (!best && (n.name === "main" || n.name === "article" || n.attrs.role === "main" || n.attrs.id === "main-content" || n.attrs.id === "main")) {
      best = n;
      return;
    }
    n.children.forEach(visit);
  };
  visit(tree);
  if (best) return best;
  let body = null;
  const findBody = (n) => {
    if (n.type !== "el") return;
    if (n.name === "body") body = n;
    else n.children.forEach(findBody);
  };
  findBody(tree);
  return body || tree;
}

export function findTitle(tree) {
  let title = null;
  let h1 = null;
  const visit = (n) => {
    if (n.type !== "el") return;
    if (n.name === "title" && title === null) title = decodeEntities(n.raw ?? textContent(n)).trim();
    if (n.name === "h1" && h1 === null) h1 = decodeEntities(textContent(n)).replace(/\s+/g, " ").trim();
    n.children.forEach(visit);
  };
  visit(tree);
  return h1 || title || "";
}

export function findLinks(tree, baseUrl) {
  const out = new Set();
  const visit = (n) => {
    if (n.type !== "el") return;
    if (n.name === "a" && typeof n.attrs.href === "string") {
      const h = resolveHref(n.attrs.href, baseUrl);
      if (h) out.add(h.split("#")[0]);
    }
    n.children.forEach(visit);
  };
  visit(tree);
  return [...out];
}
