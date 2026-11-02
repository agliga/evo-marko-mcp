#!/usr/bin/env node
// Builds data/index.json from the source repositories that power
//   https://opensource.ebay.com/evo-web/  (github.com/eBay/evo-web)
//   https://markojs.com/                  (github.com/marko-js/website, github.com/marko-js/marko)
//
// Usage:
//   node scripts/build-index.mjs                 # shallow-clones sources into .cache/sources
//   node scripts/build-index.mjs --sources DIR   # use existing clones in DIR/{evo-web,website,marko}
//   node scripts/build-index.mjs --no-fetch      # never run git; fail if sources are missing
//
// If data/crawl.json exists (produced by `npm run crawl`), live-site pages are
// merged in as additional searchable docs.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { htmlToMarkdown } from "./lib/html-to-markdown.mjs";
import {
  extractDeclarations,
  parseInterface,
  extractArgTypes,
  extractStoryTitle,
  storybookId,
} from "./lib/extract-ts.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const argVal = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1];
};
const SOURCES = path.resolve(argVal("--sources") || path.join(ROOT, ".cache", "sources"));
const OUT = path.resolve(argVal("--out") || path.join(ROOT, "data", "index.json"));
const NO_FETCH = args.includes("--no-fetch");

const REPOS = {
  "evo-web": "https://github.com/eBay/evo-web.git",
  website: "https://github.com/marko-js/website.git",
  marko: "https://github.com/marko-js/marko.git",
};

const EVO_SITE = "https://opensource.ebay.com/evo-web/";
const MARKO_SITE = "https://markojs.com/";

// evo-marko tag (without "evo-") -> evo-web site component page, when the names differ.
const SITE_PAGE_ALIASES = {
  input: "textbox",
  textarea: "textbox",
  "character-count": "textbox",
  "date-input": "date-textbox",
  "date-range-input": "date-textbox",
  "fake-menu": "menu",
  "fake-menu-button": "menu-button",
  "fake-tabs": "navigation-tabs",
  "tri-state-checkbox": "checkbox",
};

// evo-marko tag -> ebayui-core (Marko 5) tag it replaces, when the names differ.
const LEGACY_ALIASES = {
  "evo-input": ["ebay-textbox"],
  "evo-textarea": ["ebay-textbox"],
  "evo-date-input": ["ebay-date-textbox"],
  "evo-date-range-input": ["ebay-date-textbox"],
  "evo-dialog": ["ebay-lightbox-dialog"],
};

function log(...m) {
  console.error("[build-index]", ...m);
}

function ensureRepo(name) {
  const dir = path.join(SOURCES, name);
  if (fs.existsSync(path.join(dir, ".git")) || fs.existsSync(path.join(dir, "package.json"))) return dir;
  if (NO_FETCH) throw new Error(`Missing source ${dir} (and --no-fetch given)`);
  fs.mkdirSync(SOURCES, { recursive: true });
  log(`cloning ${REPOS[name]} -> ${dir}`);
  execFileSync("git", ["clone", "--depth", "1", REPOS[name], dir], { stdio: "inherit" });
  return dir;
}

function gitInfo(dir, repoUrl) {
  try {
    const out = execFileSync("git", ["-C", dir, "log", "-1", "--format=%H %cI"], { encoding: "utf8" }).trim();
    const [commit, date] = out.split(" ");
    return { repo: repoUrl.replace(/\.git$/, ""), commit, date };
  } catch {
    return { repo: repoUrl.replace(/\.git$/, ""), commit: null, date: null };
  }
}

const read = (p) => fs.readFileSync(p, "utf8");
const exists = (p) => fs.existsSync(p);

function walk(dir, filter) {
  const out = [];
  if (!exists(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "node_modules" || e.name.startsWith(".")) continue;
      out.push(...walk(p, filter));
    } else if (filter(p)) out.push(p);
  }
  return out.sort();
}

function titleCase(s) {
  return s
    .split(/[-\s]+/)
    .map((w) => (w === "3d" ? "3D" : w.charAt(0).toUpperCase() + w.slice(1)))
    .join(" ");
}

// ---------------------------------------------------------------------------
// evo-web site templates (Marko) -> Markdown
// ---------------------------------------------------------------------------

function loadSiteUrls(evoDir) {
  const urls = {};
  const common = path.join(evoDir, "src", "data", "common.ts");
  if (exists(common)) {
    const src = read(common);
    for (const m of src.matchAll(/(\w+):\s*`\$\{basePath\}([^`]*)`/g)) urls[m[1]] = EVO_SITE + m[2];
  }
  urls.skinStorybook = EVO_SITE + "skin-storybook/storybook";
  return urls;
}

function markoTemplateToMarkdown(src, pageUrl, siteUrls) {
  let html = src
    // drop top-level statements (imports, static code, scriptlets)
    .replace(/^(?:import|static|export|class|\$)\b.*$/gm, "")
    .replace(/<style[\s\S]*?<\/style>/g, "")
    // resolve the site's url helpers
    .replace(/\$\{urls\.(\w+)\}/g, (_, k) => siteUrls[k] || "")
    .replace(/\$\{basePath\}/g, EVO_SITE);
  // attribute values written as JS expressions, e.g. href=urls.components
  html = html.replace(/=\s*urls\.(\w+)/g, (_, k) => `="${siteUrls[k] || ""}"`);
  // remaining ${...} placeholders in text cannot be resolved statically
  html = html.replace(/\$\{[^}]*\}/g, "");
  return htmlToMarkdown(html, {
    baseUrl: pageUrl,
    rawTags: ["highlight-code"],
    skipClasses: ["demo", "demo__inner", "component-demo"],
    skipTags: ["component-demo", "demo", "a11y-docs-section-nav", "token-doc"],
  });
}

function readMeta(file) {
  try {
    return JSON.parse(read(file));
  } catch {
    return {};
  }
}

function sitePageUrl(routeRel) {
  // routes/_index/components/button/css+page.marko -> components/button/css/
  let p = routeRel.replace(/^_index\/?/, "").replace(/\+page\.marko$/, "");
  p = p.replace(/\/$/, "");
  return EVO_SITE + (p ? p + "/" : "");
}

// ---------------------------------------------------------------------------
// evo-marko components
// ---------------------------------------------------------------------------

function cleanReadme(md) {
  return md
    .replace(/<h1[\s\S]*?<\/h1>/i, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function firstParagraph(md) {
  for (const block of md.split(/\n\s*\n/)) {
    const t = block.trim();
    if (!t || t.startsWith("#") || t.startsWith("<") || t.startsWith("```") || t.startsWith("-") || t.startsWith("|")) continue;
    return t.replace(/\s+/g, " ");
  }
  return "";
}

function argTypeToAttr(name, at) {
  const out = { name };
  if (!at || typeof at !== "object") return out;
  if (at.description) out.description = String(at.description);
  const t = at.type;
  if (typeof t === "string") out.storybookType = t;
  else if (t && typeof t === "object" && t.name) out.storybookType = t.name;
  if (Array.isArray(at.options)) out.options = at.options.map(String);
  const def = at.table?.defaultValue?.summary;
  if (def !== undefined && def !== null && def !== "") out.default = String(def);
  if (at.table?.category) out.category = String(at.table.category);
  if (at.controllable) out.controllable = true;
  if (at.table?.type?.summary) out.typeSummary = String(at.table.type.summary);
  return out;
}

function isPassthroughKey(k) {
  return /^<[^>]+>\s*attributes$/i.test(k);
}

/** Build attribute docs by merging the TS interface with Storybook argTypes. */
function buildAttributes(iface, argTypes, declsByName, depth = 0) {
  const attrs = [];
  const attrTags = [];
  const passthrough = [];
  const seen = new Set();
  const members = iface ? iface.members : [];
  const at = argTypes || {};

  const attrTagTarget = (type) => {
    const m = /Marko\.AttrTag<\s*([\s\S]+)>\s*$/.exec(type.replace(/\s*\|\s*undefined$/, ""));
    return m ? m[1].trim() : null;
  };

  const resolveIface = (typeName) => {
    const base = typeName.replace(/<.*$/, "").replace(/\[\]$/, "").trim();
    const d = declsByName[base];
    if (!d) return null;
    if (d.kind === "interface") return parseInterface(d.text);
    return null;
  };

  // `(typeof validSizes)[number]` -> `"large" | "small"` when the const is a literal array.
  const resolveTypeof = (type) =>
    type.replace(/\(typeof\s+([\w$]+)\)\[number\]/g, (all, n) => {
      const d = declsByName[n];
      const arr = d && /=\s*\[([^\]]*)\]/.exec(d.text);
      if (!arr) return all;
      const items = arr[1].split(",").map((x) => x.trim()).filter(Boolean);
      return items.length ? items.join(" | ") : all;
    });

  for (const m of members) {
    seen.add(m.name);
    const a = argTypeToAttr(m.name, at[m.name]);
    a.type = resolveTypeof(m.type);
    a.required = !m.optional;
    if (m.doc && !a.description) a.description = m.doc;
    else if (m.doc && a.description && !a.description.includes(m.doc)) a.description += `\n\n${m.doc}`;
    const target = attrTagTarget(m.type);
    if (target && depth < 3) {
      const sub = resolveIface(target);
      const nested = buildAttributes(sub, at[m.name]?.["@"], declsByName, depth + 1);
      attrTags.push({
        name: `@${m.name}`,
        required: !m.optional,
        description: a.description || "",
        type: target,
        extends: sub?.extends || (/^Marko\./.test(target) ? [target] : []),
        attributes: nested.attributes,
        attrTags: nested.attrTags,
        passthrough: nested.passthrough,
      });
      continue;
    }
    attrs.push(a);
  }
  for (const [k, v] of Object.entries(at)) {
    if (seen.has(k)) continue;
    if (isPassthroughKey(k)) {
      passthrough.push(v?.description || k);
      continue;
    }
    if (v && v["@"] && depth < 3) {
      const nested = buildAttributes(null, v["@"], declsByName, depth + 1);
      attrTags.push({ name: `@${k}`, description: v.description || "", attributes: nested.attributes, attrTags: nested.attrTags, passthrough: nested.passthrough });
      continue;
    }
    attrs.push(argTypeToAttr(k, v));
  }
  return { attributes: attrs, attrTags, passthrough };
}

function changelogEntries(changelog, tagName) {
  if (!changelog) return [];
  const legacy = tagName.replace(/^evo-/, "ebay-");
  const out = [];
  let version = null;
  for (const line of changelog.split("\n")) {
    const v = /^## (\S+)/.exec(line);
    if (v) {
      version = v[1];
      continue;
    }
    if (!line.startsWith("- ")) continue;
    const re = new RegExp(`(\`|<|\\b)(${tagName}|${legacy})(\`|>|\\b)(?!-)`);
    if (!re.test(line)) continue;
    const text = line
      .replace(/^- \[#\d+\]\([^)]*\) \[`[0-9a-f]+`\]\([^)]*\) Thanks \[@[^\]]+\]\([^)]*\)! - /, "")
      .replace(/^- /, "")
      .trim();
    out.push({ version, text });
    if (out.length >= 8) break;
  }
  return out;
}

function buildComponents(evoDir, siteUrls, metadata) {
  const pkgDir = path.join(evoDir, "packages", "evo-marko");
  const tagsDir = path.join(pkgDir, "src", "tags");
  const pkg = JSON.parse(read(path.join(pkgDir, "package.json")));
  const changelog = exists(path.join(pkgDir, "CHANGELOG.md")) ? read(path.join(pkgDir, "CHANGELOG.md")) : "";
  const legacyDir = path.join(evoDir, "packages", "ebayui-core", "src", "components");
  const legacy = exists(legacyDir) ? fs.readdirSync(legacyDir).filter((n) => n.startsWith("ebay-")) : [];
  const siteComponents = path.join(evoDir, "src", "routes", "_index", "components");

  const components = [];
  for (const name of fs.readdirSync(tagsDir).sort()) {
    const dir = path.join(tagsDir, name);
    if (!name.startsWith("evo-") || !exists(path.join(dir, "index.marko"))) continue;
    const short = name.replace(/^evo-/, "");
    const indexSrc = read(path.join(dir, "index.marko"));
    const decls = extractDeclarations(indexSrc);
    const declsByName = Object.fromEntries(decls.map((d) => [d.name, d]));
    const inputDecl = declsByName.Input;
    const iface = inputDecl?.kind === "interface" ? parseInterface(inputDecl.text) : null;

    const storyFile = fs.readdirSync(dir).find((f) => /\.stories\.(ts|js)$/.test(f));
    const storySrc = storyFile ? read(path.join(dir, storyFile)) : "";
    const argTypes = storySrc ? extractArgTypes(storySrc) : null;
    const storyTitle = storySrc ? extractStoryTitle(storySrc) : null;

    // When Input is a type alias (e.g. a union), document members from every
    // interface it references so attributes are still listed.
    let effectiveIface = iface;
    if (!iface && inputDecl) {
      const referenced = decls.filter((d) => d.kind === "interface" && d.name !== "Input" && new RegExp(`\\b${d.name}\\b`).test(inputDecl.text));
      const all = referenced.map((d) => parseInterface(d.text)).filter(Boolean);
      if (all.length) {
        const byName = new Map();
        for (const i of all) for (const m of i.members) if (!byName.has(m.name)) byName.set(m.name, { ...m, optional: true });
        effectiveIface = { name: "Input", extends: [...new Set(all.flatMap((i) => i.extends))], members: [...byName.values()] };
      }
    }
    const { attributes, attrTags, passthrough } = buildAttributes(effectiveIface, argTypes, declsByName);

    const readme = exists(path.join(dir, "README.md")) ? cleanReadme(read(path.join(dir, "README.md"))) : "";
    const dsVersion = /DS v([\d.]+)/.exec(exists(path.join(dir, "README.md")) ? read(path.join(dir, "README.md")) : "")?.[1] || null;

    const exDir = path.join(dir, "examples");
    const examples = exists(exDir)
      ? fs
          .readdirSync(exDir)
          .filter((f) => f.endsWith(".marko"))
          .sort()
          .map((f) => ({ name: f.replace(/\.marko$/, ""), code: read(path.join(exDir, f)).trim() }))
      : [];

    // Internal tags shipped inside this component (e.g. evo-icon/tags/*)
    const nestedTagsDir = path.join(dir, "tags");
    const nestedTags = exists(nestedTagsDir)
      ? fs.readdirSync(nestedTagsDir).filter((f) => f.endsWith(".marko") || exists(path.join(nestedTagsDir, f, "index.marko"))).map((f) => f.replace(/\.marko$/, ""))
      : [];

    const siteKey = exists(path.join(siteComponents, short)) ? short : SITE_PAGE_ALIASES[short];
    const site = {};
    if (siteKey && exists(path.join(siteComponents, siteKey))) {
      const pages = { overview: "+page.marko", marko: "marko+page.marko", accessibility: "accessibility+page.marko", css: "css+page.marko" };
      for (const [k, f] of Object.entries(pages)) {
        const p = path.join(siteComponents, siteKey, f);
        if (!exists(p)) continue;
        const url = sitePageUrl(`components/${siteKey}/${f}`);
        const md = markoTemplateToMarkdown(read(p), url, siteUrls);
        if (md) site[k] = { url, markdown: md };
      }
      const meta = readMeta(path.join(siteComponents, siteKey, "+meta.json"));
      if (meta.pageDescription) site.pageDescription = meta.pageDescription;
    }

    const meta = metadata[siteKey] || metadata[short] || {};
    const legacyMatches = (LEGACY_ALIASES[name] || [`ebay-${short}`]).filter((l) => legacy.includes(l));
    const storyId = storyTitle ? storybookId(storyTitle) : null;
    const description =
      meta.description ||
      firstParagraph(readme) ||
      site.pageDescription ||
      "";

    components.push({
      name,
      shortName: short,
      title: titleCase(short),
      category: storyTitle ? storyTitle.split("/")[0] : "other",
      description,
      package: pkg.name,
      packageVersion: pkg.version,
      dsVersion,
      designSystem: meta["ds-component"]?.url ? { name: meta["ds-component"].name, url: meta["ds-component"].url, version: meta["ds-component"].version || null } : null,
      urls: {
        site: siteKey ? `${EVO_SITE}components/${siteKey}/` : null,
        storybook: storyId ? `${EVO_SITE}marko/?path=/docs/${storyId}--docs` : null,
        source: `https://github.com/eBay/evo-web/tree/main/packages/evo-marko/src/tags/${name}`,
      },
      readme,
      extends: effectiveIface?.extends || [],
      inputType: inputDecl ? inputDecl.text : null,
      types: decls.filter((d) => d.kind === "interface" || d.kind === "type").map((d) => ({ name: d.name, kind: d.kind, text: d.text })),
      attributes,
      attrTags,
      passthrough,
      examples,
      nestedTags: nestedTags.length > 40 ? { count: nestedTags.length, sample: nestedTags.slice(0, 20) } : nestedTags,
      replaces: legacyMatches,
      changelog: changelogEntries(changelog, name),
      site,
    });
  }
  return { components, pkg, legacy };
}

function buildIcons(evoDir) {
  const dir = path.join(evoDir, "packages", "evo-marko", "src", "tags", "evo-icon", "tags");
  if (!exists(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.startsWith("evo-icon-") && f.endsWith(".marko"))
    .map((f) => f.replace(/\.marko$/, ""))
    .sort();
}

// ---------------------------------------------------------------------------
// Docs: markojs.com, marko skills, evo-web guides & accessibility pages
// ---------------------------------------------------------------------------

function rewriteMarkoLinks(md, fileRel) {
  // ./language.md#x  ->  https://markojs.com/docs/reference/language#x
  const baseDir = path.posix.dirname(`/docs/${fileRel}`);
  return md.replace(/\]\((?!https?:|#|mailto:)([^)\s]+?)\.md(#[^)\s]*)?\)/g, (_, p, hash = "") => {
    const abs = path.posix.normalize(path.posix.join(baseDir, p));
    return `](${MARKO_SITE.replace(/\/$/, "")}${abs}${hash})`;
  });
}

function mdTitle(md, fallback) {
  const m = /^#\s+(.+)$/m.exec(md);
  return m ? m[1].replace(/`/g, "").trim() : fallback;
}

function buildMarkoDocs(websiteDir) {
  const docsDir = path.join(websiteDir, "docs");
  return walk(docsDir, (p) => p.endsWith(".md")).map((file) => {
    const rel = path.relative(docsDir, file).split(path.sep).join("/");
    const slug = rel.replace(/\.md$/, "");
    const md = rewriteMarkoLinks(read(file), rel);
    const category = slug.includes("/") ? slug.split("/")[0] : "general";
    return {
      id: `marko:${slug}`,
      source: "markojs.com",
      category,
      title: mdTitle(md, titleCase(path.basename(slug))),
      url: `${MARKO_SITE}docs/${slug}`,
      content: md.trim(),
    };
  });
}

function buildMarkoSkills(markoDir) {
  const skillsDir = path.join(markoDir, "skills");
  return walk(skillsDir, (p) => p.endsWith(".md") && !p.endsWith(path.join("skills", "README.md"))).map((file) => {
    const rel = path.relative(skillsDir, file).split(path.sep).join("/");
    let md = read(file);
    md = md.replace(/^---\n[\s\S]*?\n---\n/, "");
    const slug = rel.replace(/\.md$/, "").replace(/\/SKILL$/, "");
    return {
      id: `marko-skill:${slug}`,
      source: "marko-js/marko skills",
      category: "best-practices",
      title: mdTitle(md, titleCase(slug.replace(/\//g, " "))),
      url: `https://github.com/marko-js/marko/blob/main/skills/${rel}`,
      content: md.trim(),
    };
  });
}

function buildEvoDocs(evoDir, siteUrls) {
  const routes = path.join(evoDir, "src", "routes", "_index");
  const files = walk(routes, (p) => p.endsWith("+page.marko")).filter((p) => {
    const rel = path.relative(routes, p);
    return !rel.startsWith("components" + path.sep) && !/sitemap|evo-(css|react)-components/.test(rel);
  });
  const docs = [];
  for (const file of files) {
    const rel = path.relative(routes, file).split(path.sep).join("/");
    const url = sitePageUrl(rel);
    const md = markoTemplateToMarkdown(read(file), url, siteUrls);
    if (!md || md.length < 80) continue;
    const metaFile = file.replace(/\+page\.marko$/, "+meta.json");
    const meta = readMeta(metaFile);
    const slug = rel.replace(/\+page\.marko$/, "").replace(/\/$/, "") || "home";
    docs.push({
      id: `evo:${slug}`,
      source: "opensource.ebay.com/evo-web",
      category: slug.split("/")[0],
      title: meta.pageTitle || mdTitle(md, titleCase(path.basename(slug))),
      url,
      content: (meta.pageDescription ? `${meta.pageDescription}\n\n` : "") + md,
    });
  }
  return docs;
}

function buildGettingStarted(pkg, components) {
  const peer = pkg.peerDependencies || {};
  const content = `# Using evo-web components with Marko 6

\`${pkg.name}\` (v${pkg.version}) is the Marko 6 (Tags API) implementation of eBay's Evo design system. Every tag is prefixed with \`evo-\` (for example \`<evo-button>\`), replacing the Marko 5 \`<ebay-*>\` tags from \`@ebay/ebayui-core\`.

## Install

\`\`\`sh
npm install ${pkg.name} @ebay/skin
\`\`\`

Peer dependencies: ${Object.entries(peer).map(([k, v]) => `\`${k}@${v}\``).join(", ")}.

## Use a component

Marko discovers tags from installed packages automatically (the package ships a \`marko.json\` taglib), so no import is needed. Each tag imports its own \`@ebay/skin\` stylesheet (for example \`evo-button\` imports \`@ebay/skin/button\`), so a bundler that handles CSS imports (Vite / @marko/run) is all that is needed.

\`\`\`marko
<let/count=0>
<evo-button priority="primary" onClick() { count++ }>
  Clicked \${count} times
</evo-button>
\`\`\`

## Marko 6 conventions used by evo-marko

- **Attribute tags** – repeated or named sections are passed with \`<@name>\` tags, e.g. \`<evo-tabs><@tab>Title<@panel>Body</@panel></@tab></evo-tabs>\`.
- **Controllable state** – attributes marked *controllable* accept two-way binding with \`:=\`, e.g. \`<let/open=false> <evo-dialog open:=open/>\`. Without binding the component manages the state itself; the matching \`xxxChange\` callback (e.g. \`openChange\`, \`indexChange\`) fires on change.
- **Native attribute passthrough** – most tags extend a native element type (e.g. \`Marko.HTML.Button\`), so any native attribute or event handler (\`id\`, \`class\`, \`aria-*\`, \`onClick\`, ...) is forwarded to the root element.
- **Event handlers** – pass functions as attributes, e.g. \`onClick(e) { ... }\` or \`onEscape=handler\`.
- **Accessibility text** – attributes named \`a11y*\` (e.g. \`a11yCloseText\`) must be localized by the app.

## Components (${components.length})

${components.map((c) => `- \`<${c.name}>\` – ${c.description || c.title}`).join("\n")}
`;
  return {
    id: "evo:getting-started-marko-6",
    source: "evo-marko-mcp",
    category: "guides",
    title: "Using evo-web components with Marko 6",
    url: `https://github.com/eBay/evo-web/tree/main/packages/evo-marko`,
    content,
  };
}

function loadCrawl() {
  const p = path.join(ROOT, "data", "crawl.json");
  if (!exists(p)) return [];
  try {
    const pages = JSON.parse(read(p)).pages || [];
    return pages.map((pg) => ({
      id: `crawl:${pg.url}`,
      source: `crawl:${new URL(pg.url).host}`,
      category: "crawled",
      title: pg.title || pg.url,
      url: pg.url,
      content: pg.markdown,
    }));
  } catch (e) {
    log("ignoring unreadable data/crawl.json:", e.message);
    return [];
  }
}

function main() {
  const evoDir = ensureRepo("evo-web");
  const websiteDir = ensureRepo("website");
  const markoDir = ensureRepo("marko");

  const siteUrls = loadSiteUrls(evoDir);
  const metaFile = path.join(evoDir, "src", "data", "component-metadata.json");
  const metadata = exists(metaFile) ? JSON.parse(read(metaFile)) : {};

  const { components, pkg, legacy } = buildComponents(evoDir, siteUrls, metadata);
  const icons = buildIcons(evoDir);
  const markoPkg = (() => {
    const p = path.join(markoDir, "packages", "runtime-tags", "package.json");
    return exists(p) ? JSON.parse(read(p)) : null;
  })();

  const evoNames = new Set(components.map((c) => c.name));
  const replacedBy = {};
  for (const c of components) for (const r of c.replaces) (replacedBy[r] ||= []).push(c.name);
  const legacyComponents = legacy.sort().map((l) => ({
    name: l,
    evoEquivalent: replacedBy[l] || (evoNames.has(l.replace(/^ebay-/, "evo-")) ? [l.replace(/^ebay-/, "evo-")] : []),
  }));

  const docs = [
    buildGettingStarted(pkg, components),
    ...buildMarkoDocs(websiteDir),
    ...buildMarkoSkills(markoDir),
    ...buildEvoDocs(evoDir, siteUrls),
  ];
  // Crawled pages fill gaps only: pages already built from source are skipped.
  const norm = (u) => u.replace(/[#?].*$/, "").replace(/\/+$/, "");
  const known = new Set(docs.map((d) => norm(d.url)));
  for (const c of components) for (const p of Object.values(c.site)) if (p?.url) known.add(norm(p.url));
  if (components.length) for (const c of components) if (c.urls.site) known.add(norm(c.urls.site));
  const crawled = loadCrawl().filter((d) => !known.has(norm(d.url)));
  if (crawled.length) log(`merged ${crawled.length} crawled page(s) not covered by sources`);
  docs.push(...crawled);

  const index = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    sources: {
      evoWeb: gitInfo(evoDir, REPOS["evo-web"]),
      markoWebsite: gitInfo(websiteDir, REPOS.website),
      marko: gitInfo(markoDir, REPOS.marko),
      sites: [EVO_SITE, MARKO_SITE],
    },
    packages: {
      evoMarko: { name: pkg.name, version: pkg.version, peerDependencies: pkg.peerDependencies || {} },
      marko: markoPkg ? { name: markoPkg.name, version: markoPkg.version } : null,
    },
    components,
    icons,
    legacyComponents,
    docs,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(index));
  const size = (fs.statSync(OUT).size / 1024).toFixed(0);
  log(`wrote ${OUT} (${size} KB): ${components.length} components, ${icons.length} icons, ${docs.length} docs`);
}

main();
