// Loads data/index.json and answers queries about components and docs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SearchIndex, tokenize } from "./search.js";

const DEFAULT_INDEX = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "index.json");

export const COMPONENT_SECTIONS = [
  "overview",
  "usage",
  "attributes",
  "attrTags",
  "examples",
  "types",
  "accessibility",
  "css",
  "sitePage",
  "changelog",
];
export const DEFAULT_SECTIONS = ["overview", "usage", "attributes", "attrTags", "examples"];

/** Split markdown into sections at ## / ### headings. */
export function splitSections(md) {
  const lines = md.split("\n");
  const sections = [];
  let cur = { heading: "", level: 1, lines: [] };
  let inFence = false;
  for (const line of lines) {
    if (/^\s*```/.test(line)) inFence = !inFence;
    const h = !inFence && /^(#{2,3})\s+(.+)$/.exec(line);
    if (h) {
      if (cur.lines.join("").trim() || cur.heading) sections.push(cur);
      cur = { heading: h[2].replace(/`/g, "").trim(), level: h[1].length, lines: [line] };
    } else cur.lines.push(line);
  }
  if (cur.lines.join("").trim()) sections.push(cur);
  return sections.map((s) => ({ heading: s.heading, level: s.level, text: s.lines.join("\n").trim() }));
}

function slugify(s) {
  return String(s)
    .toLowerCase()
    .replace(/[`<>]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Inline code span that survives backticks inside the value. */
export function code(s) {
  const str = String(s);
  const fence = str.includes("`") ? "``" : "`";
  const pad = str.startsWith("`") || str.endsWith("`") ? " " : "";
  return `${fence}${pad}${str}${pad}${fence}`;
}

/** Storybook examples spread the story args with `...input`; drop that for copy-paste use. */
export function stripStoryArgs(src) {
  return src.replace(/(<[\w-]+)\s+\.\.\.input(?=[\s/>])/g, "$1");
}

function cell(s) {
  return String(s ?? "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, "<br>")
    .trim();
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++)
    for (let j = 1; j <= b.length; j++)
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}

export class Store {
  constructor(indexPath = process.env.EVO_MARKO_MCP_INDEX || DEFAULT_INDEX) {
    this.indexPath = indexPath;
    this.data = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    this.components = this.data.components;
    this.docs = this.data.docs;
    this.icons = this.data.icons || [];
    this.byName = new Map(this.components.map((c) => [c.name, c]));
    this.docsById = new Map(this.docs.map((d) => [d.id, d]));
    this._search = null;
  }

  get summary() {
    const { sources, packages, generatedAt } = this.data;
    return { generatedAt, sources, packages, counts: { components: this.components.length, docs: this.docs.length, icons: this.icons.length } };
  }

  // -------------------------------------------------------------------------
  // Components
  // -------------------------------------------------------------------------

  /** Resolve "button", "evo-button", "<evo-button>", "ebay-button", "Button" ... */
  resolveComponent(name) {
    if (!name) return { component: null, suggestions: [] };
    let n = String(name).trim().toLowerCase().replace(/^<|\/?>$/g, "").replace(/\s+/g, "-");
    if (this.byName.has(n)) return { component: this.byName.get(n) };
    if (this.byName.has(`evo-${n}`)) return { component: this.byName.get(`evo-${n}`) };
    if (n.startsWith("ebay-")) {
      const legacy = (this.data.legacyComponents || []).find((l) => l.name === n);
      if (legacy?.evoEquivalent?.length) return { component: this.byName.get(legacy.evoEquivalent[0]), viaLegacy: n };
      n = n.replace(/^ebay-/, "");
      if (this.byName.has(`evo-${n}`)) return { component: this.byName.get(`evo-${n}`), viaLegacy: name };
    }
    const bare = n.replace(/^evo-/, "");
    const scored = this.components
      .map((c) => ({ c, d: levenshtein(bare, c.shortName) - (c.shortName.includes(bare) || bare.includes(c.shortName) ? 2 : 0) }))
      .sort((a, b) => a.d - b.d);
    if (scored[0] && scored[0].d <= 1 && (scored.length < 2 || scored[1].d > scored[0].d)) return { component: scored[0].c, fuzzy: true };
    return { component: null, suggestions: scored.slice(0, 5).map((s) => s.c.name) };
  }

  listComponents({ category, query } = {}) {
    let list = this.components;
    if (category) {
      const cat = category.toLowerCase();
      list = list.filter((c) => c.category.toLowerCase().includes(cat));
    }
    if (query) {
      const hits = this.search(query, { kinds: ["component"], limit: 100 });
      const order = new Map();
      hits.forEach((h, i) => {
        if (!order.has(h.componentName)) order.set(h.componentName, i);
      });
      list = list.filter((c) => order.has(c.name)).sort((a, b) => order.get(a.name) - order.get(b.name));
    }
    return list;
  }

  categories() {
    const m = new Map();
    for (const c of this.components) m.set(c.category, (m.get(c.category) || 0) + 1);
    return [...m.entries()].sort();
  }

  formatComponentList(list) {
    if (!list.length) return "No components matched.";
    const byCat = new Map();
    for (const c of list) {
      if (!byCat.has(c.category)) byCat.set(c.category, []);
      byCat.get(c.category).push(c);
    }
    const out = [`${list.length} evo-web Marko 6 component(s) from \`${this.data.packages.evoMarko.name}@${this.data.packages.evoMarko.version}\`:`, ""];
    for (const [cat, cs] of byCat) {
      out.push(`## ${cat}`);
      for (const c of cs) out.push(`- \`<${c.name}>\` — ${c.description || c.title}${c.replaces.length ? ` _(replaces ${c.replaces.map((r) => `<${r}>`).join(", ")})_` : ""}`);
      out.push("");
    }
    out.push("Use `get_component` with a name for attributes, attribute tags and Marko 6 examples.");
    return out.join("\n");
  }

  formatAttributes(attrs) {
    if (!attrs.length) return "_No component-specific attributes._";
    const rows = ["| Attribute | Type | Default | Description |", "| --- | --- | --- | --- |"];
    for (const a of attrs) {
      let type = a.type || a.typeSummary || a.storybookType || "";
      if (a.options && !a.type) type = a.options.map((o) => `"${o}"`).join(" \\| ");
      const flags = [a.required ? "**required**" : "", a.controllable ? "controllable (`:=`)" : "", a.category ? `_${a.category}_` : ""].filter(Boolean).join(", ");
      let desc = a.description;
      const changeOf = /^(\w+)Change$/.exec(a.name);
      if (!desc && changeOf && attrs.some((x) => x.name === changeOf[1]))
        desc = `Called with the new value when \`${changeOf[1]}\` changes; set automatically when using \`${changeOf[1]}:=\` binding.`;
      else if (!desc && /^on[A-Z]/.test(a.name)) desc = `Event handler (\`${a.name.slice(2).toLowerCase()}\`).`;
      rows.push(`| ${code(a.name)} | ${type ? code(cell(type)) : ""} | ${a.default ? code(cell(a.default)) : ""} | ${cell([flags, desc].filter(Boolean).join(" — "))} |`);
    }
    return rows.join("\n");
  }

  formatAttrTags(tags, depth = 3) {
    const out = [];
    for (const t of tags) {
      const h = "#".repeat(Math.min(depth, 6));
      out.push(`${h} \`<${t.name}>\`${t.required ? " (required)" : ""}`);
      if (t.description) out.push(t.description);
      if (t.extends?.length) out.push(`Extends: ${t.extends.map(code).join(", ")}`);
      if (t.passthrough?.length) out.push(t.passthrough.join("\n"));
      if (t.attributes?.length) out.push(this.formatAttributes(t.attributes));
      if (t.attrTags?.length) out.push(this.formatAttrTags(t.attrTags, depth + 1));
      out.push("");
    }
    return out.join("\n\n").replace(/\n{3,}/g, "\n\n");
  }

  usageSnippet(c) {
    // Prefer an example whose name suggests the default usage.
    const pref = ["default", "basic", c.shortName, "base"];
    const ex = c.examples.find((e) => pref.includes(e.name)) || c.examples[0];
    return ex ? stripStoryArgs(ex.code) : `<${c.name}/>`;
  }

  formatComponent(c, sections = DEFAULT_SECTIONS, { viaLegacy, fuzzyFrom } = {}) {
    const want = new Set(sections.includes("all") ? COMPONENT_SECTIONS : sections);
    const out = [];
    if (want.has("overview")) {
      out.push(`# \`<${c.name}>\` — ${c.title}`);
      if (fuzzyFrom) out.push(`> No exact match for "${fuzzyFrom}"; showing the closest component.`);
      if (viaLegacy) out.push(`> \`<${viaLegacy}>\` (Marko 5, @ebay/ebayui-core) maps to \`<${c.name}>\` in Marko 6.`);
      if (c.description) out.push(c.description);
      const facts = [
        `**Package:** \`${c.package}@${c.packageVersion}\` (Marko 6 tags API; peer deps ${Object.entries(this.data.packages.evoMarko.peerDependencies || {})
          .map(([k, v]) => `\`${k}@${v}\``)
          .join(", ")})`,
        `**Category:** ${c.category}`,
        c.dsVersion ? `**Design system version:** ${c.dsVersion}` : "",
        c.replaces.length ? `**Replaces (Marko 5):** ${c.replaces.map((r) => `\`<${r}>\``).join(", ")}` : "",
        c.extends.length ? `**Native passthrough:** extends ${c.extends.map(code).join(", ")} — native attributes and event handlers are forwarded to the root element` : "",
      ].filter(Boolean);
      out.push(facts.map((f) => `- ${f}`).join("\n"));
      const links = [
        c.urls.site && `[Docs site](${c.urls.site})`,
        c.urls.storybook && `[Storybook](${c.urls.storybook})`,
        c.urls.source && `[Source](${c.urls.source})`,
        c.designSystem?.url && `[Design system (${c.designSystem.name})](${c.designSystem.url})`,
      ].filter(Boolean);
      if (links.length) out.push(`Links: ${links.join(" · ")}`);
      if (c.site?.pageDescription) out.push(c.site.pageDescription);
    }
    if (want.has("usage")) {
      out.push("## Usage (Marko 6)");
      out.push("No import is needed — Marko auto-discovers tags from the installed `@evo-web/marko` package. The tag also imports its own `@ebay/skin` CSS.");
      out.push("```marko\n" + this.usageSnippet(c) + "\n```");
    }
    if (want.has("attributes")) {
      out.push("## Attributes");
      out.push(this.formatAttributes(c.attributes));
      if (c.attributes.some((a) => a.controllable))
        out.push(
          "Controllable attributes can be bound two-way with `:=` (e.g. `<let/value=0> <" +
            c.name +
            " " +
            c.attributes.find((a) => a.controllable).name +
            ":=value/>`), or left unbound to let the component manage the state internally.",
        );
      if (c.passthrough.length) out.push(c.passthrough.join("\n"));
    }
    if (want.has("attrTags") && c.attrTags.length) {
      out.push("## Attribute tags");
      out.push(this.formatAttrTags(c.attrTags));
    }
    if (want.has("examples") && c.examples.length) {
      out.push("## Examples");
      if (c.examples.some((e) => /\.\.\.input\b/.test(e.code)))
        out.push("_These are the Storybook examples. `...input` spreads the story's controls onto the tag — omit it in application code._");
      for (const e of c.examples) out.push(`### ${e.name}\n\n\`\`\`marko\n${e.code}\n\`\`\``);
    }
    if (want.has("types") && c.types.length) {
      out.push("## TypeScript input types");
      out.push("```ts\n" + c.types.map((t) => t.text).join("\n\n") + "\n```");
    }
    if (want.has("accessibility") && c.site?.accessibility) {
      out.push(`## Accessibility (from ${c.site.accessibility.url})`);
      out.push(demoteHeadings(c.site.accessibility.markdown));
    }
    if (want.has("sitePage")) {
      for (const k of ["overview", "marko"]) {
        if (!c.site?.[k]) continue;
        out.push(`## Docs site: ${k} (${c.site[k].url})`);
        out.push(demoteHeadings(c.site[k].markdown));
      }
    }
    if (want.has("css") && c.site?.css) {
      out.push(`## Skin CSS markup (from ${c.site.css.url})`);
      out.push("The Marko component renders this markup for you; use it to understand class names and modifiers.");
      out.push(demoteHeadings(c.site.css.markdown));
    }
    if (want.has("changelog") && c.changelog.length) {
      out.push("## Changelog highlights");
      out.push(c.changelog.map((e) => `- **${e.version}** — ${e.text}`).join("\n"));
    }
    const missing = [...want].filter((s) => (s === "accessibility" && !c.site?.accessibility) || (s === "css" && !c.site?.css) || (s === "changelog" && !c.changelog.length));
    if (missing.length) out.push(`_Not available for this component: ${missing.join(", ")}._`);
    const notShown = COMPONENT_SECTIONS.filter((s) => !want.has(s));
    if (notShown.length) out.push(`_More sections available via \`sections\`: ${notShown.join(", ")} (or "all")._`);
    return out.join("\n\n").replace(/\n{3,}/g, "\n\n");
  }

  // -------------------------------------------------------------------------
  // Docs
  // -------------------------------------------------------------------------

  resolveDoc(idOrUrl) {
    if (!idOrUrl) return null;
    const q = String(idOrUrl).trim();
    if (this.docsById.has(q)) return this.docsById.get(q);
    const noSlash = q.replace(/\/+$/, "").replace(/#.*$/, "");
    for (const d of this.docs) if (d.url.replace(/\/+$/, "") === noSlash) return d;
    // Bare slugs: "reference/core-tag", "core-tag", "accessibility/patterns/popover"
    const candidates = this.docs.filter((d) => d.id.endsWith(`:${q}`) || d.id.endsWith(`/${q}`) || d.url.replace(/\/+$/, "").endsWith(`/${q}`));
    if (candidates.length) return candidates[0];
    const lower = q.toLowerCase();
    return this.docs.find((d) => d.title.toLowerCase() === lower) || null;
  }

  listDocs({ source } = {}) {
    return this.docs.filter((d) => matchesSource(d, source));
  }

  formatDoc(d, { section } = {}) {
    let content = d.content;
    if (section) {
      const want = slugify(section);
      const secs = splitSections(d.content);
      const idx = secs.findIndex((s) => slugify(s.heading) === want || slugify(s.heading).includes(want));
      if (idx === -1) {
        return `Section "${section}" not found in ${d.title}. Available sections:\n${secs
          .filter((s) => s.heading)
          .map((s) => `${"  ".repeat(s.level - 2)}- ${s.heading}`)
          .join("\n")}`;
      }
      // include sub-sections (deeper levels) that follow
      const level = secs[idx].level;
      const parts = [secs[idx].text];
      for (let i = idx + 1; i < secs.length && secs[i].level > level; i++) parts.push(secs[i].text);
      content = parts.join("\n\n");
    }
    return `Source: ${d.url} (${d.source})\n\n${content}`;
  }

  // -------------------------------------------------------------------------
  // Search
  // -------------------------------------------------------------------------

  get searchIndex() {
    if (this._search) return this._search;
    const idx = new SearchIndex();
    for (const c of this.components) {
      const attrText = c.attributes.map((a) => `${a.name} ${a.description || ""} ${(a.options || []).join(" ")}`).join("\n");
      const tagText = JSON.stringify(c.attrTags.map((t) => [t.name, t.description, t.attributes.map((a) => [a.name, a.description])]));
      idx.add(
        { kind: "component", componentName: c.name, section: "overview", title: `<${c.name}>`, url: c.urls.site || c.urls.source, text: `${c.description}\n${attrText}` },
        [
          { text: `${c.name} ${c.shortName} ${c.title} ${c.replaces.join(" ")}`, weight: 5 },
          { text: `${c.description} ${c.category}`, weight: 2 },
          { text: attrText },
          { text: tagText },
          { text: c.readme },
        ],
      );
      if (c.examples.length) {
        const ex = c.examples.map((e) => `${e.name}\n${e.code}`).join("\n\n");
        idx.add({ kind: "component", componentName: c.name, section: "examples", title: `<${c.name}> examples`, url: c.urls.source, text: ex }, [
          { text: `${c.name} ${c.shortName} examples`, weight: 2 },
          { text: ex },
        ]);
      }
      for (const k of ["overview", "accessibility", "css", "marko"]) {
        const p = c.site?.[k];
        if (!p) continue;
        idx.add({ kind: "component", componentName: c.name, section: k === "overview" || k === "marko" ? "sitePage" : k, title: `<${c.name}> ${k}`, url: p.url, text: p.markdown }, [
          { text: `${c.shortName} ${k}`, weight: 2 },
          { text: p.markdown },
        ]);
      }
    }
    for (const d of this.docs) {
      for (const s of splitSections(d.content)) {
        if (!s.text.trim()) continue;
        idx.add(
          { kind: "doc", docId: d.id, source: d.source, section: s.heading, title: s.heading ? `${d.title} › ${s.heading}` : d.title, url: s.heading ? `${d.url}#${slugify(s.heading)}` : d.url, text: s.text },
          [
            { text: `${d.title} ${s.heading}`, weight: 3 },
            { text: s.text },
          ],
        );
      }
    }
    this._search = idx;
    return idx;
  }

  search(query, { source = "all", kinds, limit = 8 } = {}) {
    const filter = (ref) => {
      if (kinds && !kinds.includes(ref.kind)) return false;
      if (source === "all" || !source) return true;
      if (source === "components") return ref.kind === "component";
      if (ref.kind === "component") return source === "evo";
      return matchesSource(this.docsById.get(ref.docId), source);
    };
    return this.searchIndex
      .search(query, { limit: limit * 3, filter })
      .map(({ ref, score }) => ({ ...ref, score: score * refBoost(ref) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  formatSearch(query, hits) {
    if (!hits.length) return `No results for "${query}".`;
    const terms = tokenize(query);
    return hits
      .map((h, i) => {
        const where = h.kind === "component" ? `component \`${h.componentName}\` (section: ${h.section})` : `doc \`${h.docId}\``;
        return `${i + 1}. **${h.title}** — ${where}\n   ${h.url}\n   ${snippet(h.text, terms)}`;
      })
      .join("\n\n");
  }

  searchIcons(query, limit = 30) {
    const terms = tokenize(query).filter((t) => t !== "icon" && t !== "evo");
    const scored = this.icons
      .map((name) => {
        const parts = name.replace(/^evo-icon-/, "");
        let s = 0;
        for (const t of terms) {
          if (parts.split("-").includes(t)) s += 2;
          else if (parts.includes(t)) s += 1;
        }
        return { name, s };
      })
      .filter((x) => x.s > 0 || !terms.length)
      .sort((a, b) => b.s - a.s || a.name.length - b.name.length);
    return scored.slice(0, limit).map((x) => x.name);
  }
}

function demoteHeadings(md) {
  let inFence = false;
  return md
    .split("\n")
    .map((l) => {
      if (/^\s*```/.test(l)) inFence = !inFence;
      return !inFence && /^#{1,5}\s/.test(l) ? "##" + l : l;
    })
    .join("\n");
}

/** Reference material beats news posts; component definitions get a small lift. */
function refBoost(ref) {
  if (ref.kind === "component") return ref.section === "overview" ? 1.3 : 1;
  const id = ref.docId || "";
  if (id.startsWith("marko:newsletter")) return 0.35;
  if (id.startsWith("marko:reference") || id.startsWith("marko-skill:")) return 1.25;
  if (id.startsWith("crawl:")) return 0.8;
  return 1;
}

export function matchesSource(doc, source) {
  if (!doc) return false;
  if (!source || source === "all") return true;
  if (source === "marko") return doc.source === "markojs.com" || doc.source.startsWith("marko-js") || doc.source === "crawl:markojs.com";
  if (source === "evo") return doc.source.includes("evo-web") || doc.source === "evo-marko-mcp" || doc.source === "crawl:opensource.ebay.com";
  if (source === "components") return false;
  return doc.source.includes(source);
}

function snippet(text, terms, max = 240) {
  const flat = String(text).replace(/```[a-z]*\n?/g, "").replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let pos = -1;
  for (const t of terms) {
    pos = lower.indexOf(t);
    if (pos !== -1) break;
  }
  const start = Math.max(0, pos - 60);
  const s = flat.slice(start, start + max);
  return (start > 0 ? "…" : "") + s + (start + max < flat.length ? "…" : "");
}
