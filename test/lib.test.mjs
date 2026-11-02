import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { htmlToMarkdown, parseHtml, findLinks } from "../scripts/lib/html-to-markdown.mjs";
import { extractDeclarations, parseInterface, extractArgTypes, storybookId } from "../scripts/lib/extract-ts.mjs";
import { crawl } from "../scripts/lib/crawler.mjs";
import { tokenize, SearchIndex } from "../src/search.js";

test("htmlToMarkdown converts common structures", () => {
  const md = htmlToMarkdown(
    `<h2>Title</h2><p>Use <strong>bold</strong> and <code>&lt;evo-button&gt;</code>, see <a href="/docs/x">docs</a>.</p>
     <ul><li>one</li><li>two<ul><li>nested</li></ul></li></ul>
     <pre><code class="language-marko">&lt;let/x=1&gt;</code></pre>
     <table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2|3</td></tr></table>
     <div class="demo"><button>demo</button></div><script>alert(1)</script>`,
    { baseUrl: "https://markojs.com/docs/a", skipClasses: ["demo"] },
  );
  assert.match(md, /^## Title/);
  assert.match(md, /Use \*\*bold\*\* and `<evo-button>`, see \[docs\]\(https:\/\/markojs\.com\/docs\/x\)\./);
  assert.match(md, /- one\n- two\n {2}- nested/);
  assert.match(md, /```marko\n<let\/x=1>\n```/);
  assert.match(md, /\| A \| B \|\n\| --- \| --- \|\n\| 1 \| 2\\\|3 \|/);
  assert.doesNotMatch(md, /demo|alert/);
});

test("htmlToMarkdown keeps raw code tags verbatim (Marko site templates)", () => {
  const md = htmlToMarkdown(`<p>x</p>\n<highlight-code type="html">\n    <button class="btn">Hi</button>\n  </highlight-code>`, {
    rawTags: ["highlight-code"],
  });
  assert.match(md, /```html\n<button class="btn">Hi<\/button>\n```/);
});

test("parseHtml tolerates Marko attribute expressions", () => {
  const tree = parseHtml(`<a href=urls.components onClick() { if (a > b) go(); }>x</a><for|item| of=list><p>y</p></for>`);
  assert.equal(tree.children[0].name, "a");
  assert.equal(tree.children[1].name, "for");
  assert.deepEqual(findLinks(parseHtml(`<a href="/a#b">1</a><a href="https://x.com/c">2</a>`), "https://e.com/"), ["https://e.com/a", "https://x.com/c"]);
});

test("extractDeclarations + parseInterface read Marko 6 tag inputs", () => {
  const src = `static export const validSizes = ["large", "small"] as const;
export interface Tab extends Marko.HTML.Div {
  panel: Marko.AttrTag<Marko.HTML.Div>;
}
export interface Input
  extends Marko.HTML.Button, Omit<Marko.HTML.A, "type" | \`on\${string}\`> {
  /** The size */
  size?: (typeof validSizes)[number];
  tab?: Marko.AttrTag<Tab>;
  onEscape?: (event: KeyboardEvent) => void;
}

<const/{ size }=input>
<button/>`;
  const decls = extractDeclarations(src);
  assert.deepEqual(decls.map((d) => d.name), ["validSizes", "Tab", "Input"]);
  const iface = parseInterface(decls[2].text);
  assert.deepEqual(iface.extends, ["Marko.HTML.Button", 'Omit<Marko.HTML.A, "type" | `on${string}`>']);
  assert.deepEqual(iface.members.map((m) => m.name), ["size", "tab", "onEscape"]);
  assert.equal(iface.members[0].doc, "The size");
  assert.equal(iface.members[2].type, "(event: KeyboardEvent) => void");
});

test("extractArgTypes evaluates storybook argTypes safely, with per-entry fallback", () => {
  const src = `export default {
  title: "navigation & disclosure/evo-tabs",
  argTypes: {
    size: { options: ["medium", "large"], table: { defaultValue: { summary: "medium" } }, description: "Size" },
    cols: { description: "Cols " + sizes.join(", ") },
    ["<div> attributes" as any]: { description: "passthrough" },
  },
};`;
  const at = extractArgTypes(src);
  assert.deepEqual(at.size.options, ["medium", "large"]);
  assert.equal(at["<div> attributes"].description, "passthrough");
  assert.ok("cols" in at);
  assert.equal(extractArgTypes(`x = { argTypes: { a: { description: process.exit(1) } } }`).a.description, "");
  assert.equal(storybookId("navigation & disclosure/evo-tabs"), "navigation-disclosure-evo-tabs");
});

test("tokenize splits hyphenated and camelCase names", () => {
  const t = tokenize("evo-button a11yCloseText <@panel>");
  for (const w of ["evo-button", "evo", "button", "a11yclosetext", "close", "text", "@panel", "panel"]) assert.ok(t.includes(w), w);
  const idx = new SearchIndex();
  idx.add("a", [{ text: "dialog focus trap" }]);
  idx.add("b", [{ text: "button click" }]);
  assert.equal(idx.search("dialog")[0].ref, "a");
});

test("crawler follows in-scope links and converts pages", async () => {
  const pages = {
    "/docs/": `<html><head><title>Docs</title></head><body><nav><a href="/docs/a">A</a></nav><main><h1>Docs home</h1><p>Welcome to the docs. <a href="/docs/a">A</a> <a href="/docs/b">B</a> <a href="/other">out</a></p></main></body></html>`,
    "/docs/a": `<html><body><main><h1>Page A</h1><p>Content about the let tag and reactivity in Marko.</p></main></body></html>`,
    "/docs/b": `<html><body><main><h1>Page B</h1><p>Content about attribute tags and more things here.</p></main></body></html>`,
    "/other": `<html><body><main><h1>Out of scope</h1><p>should not be crawled at all ever.</p></main></body></html>`,
    "/robots.txt": "User-agent: *\nDisallow: /docs/b\n",
  };
  const server = http.createServer((req, res) => {
    const body = pages[req.url];
    if (!body) return res.writeHead(404).end();
    res.writeHead(200, { "content-type": req.url.endsWith(".txt") ? "text/plain" : "text/html" }).end(body);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const { pages: out } = await crawl([{ name: "t", seeds: [`${base}/docs/`], sitemaps: [], include: [new RegExp(`^${base}/docs/`)], exclude: [] }], { delayMs: 0 });
    const urls = out.map((p) => p.url).sort();
    assert.deepEqual(urls, [`${base}/docs/`, `${base}/docs/a`]); // b is disallowed by robots.txt
    const a = out.find((p) => p.url.endsWith("/a"));
    assert.equal(a.title, "Page A");
    assert.match(a.markdown, /# Page A\n\nContent about the let tag/);
    assert.doesNotMatch(out[0].markdown, /\[A\]\(.*\)\n/); // nav stripped, main kept
  } finally {
    server.close();
  }
});
