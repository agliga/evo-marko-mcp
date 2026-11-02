// MCP tool, resource and prompt definitions.

import { COMPONENT_SECTIONS, DEFAULT_SECTIONS } from "./store.js";

const text = (t) => ({ content: [{ type: "text", text: t }] });
const error = (t) => ({ content: [{ type: "text", text: t }], isError: true });

export function createTools(store) {
  const tools = [
    {
      name: "list_components",
      title: "List evo-web Marko 6 components",
      description:
        "List the eBay evo-web components available for Marko 6 (package @evo-web/marko, tags named <evo-*>), grouped by category. Optionally filter by category or a free-text query (e.g. 'date picker', 'dropdown').",
      inputSchema: {
        type: "object",
        properties: {
          category: { type: "string", description: `Category filter. One of: ${store.categories().map(([c]) => c).join(", ")}` },
          query: { type: "string", description: "Free-text filter, e.g. 'select an option from a list'." },
        },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ category, query } = {}) => text(store.formatComponentList(store.listComponents({ category, query }))),
    },
    {
      name: "get_component",
      title: "Get an evo-web component definition",
      description:
        "Full definition of one evo-web Marko 6 component: description, attributes (types, defaults, controllable state), attribute tags (<@tab>, <@option>...), Marko 6 usage examples, TypeScript input types, and optionally the accessibility guidance, Skin CSS markup and changelog. Accepts 'button', 'evo-button', '<evo-button>' or a Marko 5 name like 'ebay-button'.",
      inputSchema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Component name, e.g. 'evo-tabs', 'tabs' or 'ebay-tabs'." },
          sections: {
            type: "array",
            items: { type: "string", enum: [...COMPONENT_SECTIONS, "all"] },
            description: `Sections to include. Default: ${DEFAULT_SECTIONS.join(", ")}.`,
          },
        },
        required: ["name"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ name, sections } = {}) => {
        const r = store.resolveComponent(name);
        if (!r.component)
          return error(`No evo-web component named "${name}".${r.suggestions?.length ? ` Did you mean: ${r.suggestions.join(", ")}?` : ""} Use list_components to see all.`);
        return text(store.formatComponent(r.component, sections?.length ? sections : DEFAULT_SECTIONS, { viaLegacy: r.viaLegacy, fuzzyFrom: r.fuzzy ? name : undefined }));
      },
    },
    {
      name: "search_docs",
      title: "Search Marko and evo-web documentation",
      description:
        "Full-text search across the Marko 6 docs (markojs.com: language, core tags, reactivity, TypeScript, @marko/run...), Marko best-practice and 5→6 migration guides, the evo-web site (component docs, accessibility patterns, guides) and every component's attributes and examples. Returns ranked sections with ids to pass to get_doc or get_component.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to look for, e.g. '<let> two way binding', 'attribute tags', 'dialog focus trap'." },
          source: {
            type: "string",
            enum: ["all", "marko", "evo", "components"],
            description: "Restrict to Marko docs, evo-web docs (site + components), or components only. Default: all.",
          },
          limit: { type: "integer", minimum: 1, maximum: 25, description: "Max results (default 8)." },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ query, source = "all", limit = 8 } = {}) => {
        if (!query || !String(query).trim()) return error("query is required");
        return text(store.formatSearch(query, store.search(query, { source, limit })));
      },
    },
    {
      name: "get_doc",
      title: "Read a documentation page",
      description:
        "Read a Marko or evo-web documentation page as Markdown. Pass an id from search_docs/list_docs (e.g. 'marko:reference/core-tag'), a URL (https://markojs.com/docs/reference/reactivity) or a slug ('core-tag'). Use `section` to return only one heading's content.",
      inputSchema: {
        type: "object",
        properties: {
          id: { type: "string", description: "Doc id, URL or slug." },
          section: { type: "string", description: "Optional heading to extract, e.g. '<let>' or 'Attribute Tags'." },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ id, section } = {}) => {
        const d = store.resolveDoc(id);
        if (!d) return error(`No doc found for "${id}". Use list_docs or search_docs to find ids.`);
        return text(store.formatDoc(d, { section }));
      },
    },
    {
      name: "list_docs",
      title: "List documentation pages",
      description: "List available documentation pages (id, title, URL), optionally limited to Marko docs or evo-web docs.",
      inputSchema: {
        type: "object",
        properties: { source: { type: "string", enum: ["all", "marko", "evo"], description: "Default: all." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ source = "all" } = {}) => {
        const docs = store.listDocs({ source });
        const groups = new Map();
        for (const d of docs) {
          const key = `${d.source} / ${d.category}`;
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(d);
        }
        const out = [];
        for (const [k, ds] of groups) {
          out.push(`## ${k}`);
          for (const d of ds) out.push(`- \`${d.id}\` — ${d.title}`);
          out.push("");
        }
        return text(out.join("\n"));
      },
    },
    {
      name: "search_icons",
      title: "Find evo-web icons",
      description: "Search the evo-web icon set (e.g. 'cart', 'chevron down', 'close 16') and get the tag names plus Marko 6 usage.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Icon keywords, optionally with a size like 16 or 24." },
          limit: { type: "integer", minimum: 1, maximum: 100 },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ query, limit = 30 } = {}) => {
        const icons = store.searchIcons(query, limit);
        if (!icons.length) return text(`No icons matched "${query}". ${store.icons.length} icons are available.`);
        return text(
          `${icons.length} icon(s):\n${icons.map((i) => `- \`<${i}/>\``).join("\n")}\n\nUsage in Marko 6: render the icon tag directly (e.g. \`<${icons[0]}/>\`), or pass it to components that take an icon, e.g.\n\n\`\`\`marko\n<evo-icon-button a11yText="Close">\n  <${icons[0]}/>\n</evo-icon-button>\n\`\`\`\n\nSee get_component("evo-icon") for icon attributes.`,
        );
      },
    },
    {
      name: "migrate_from_ebayui",
      title: "Map Marko 5 ebayui-core tags to Marko 6 evo-web tags",
      description:
        "Given a Marko 5 @ebay/ebayui-core tag (e.g. 'ebay-textbox'), return its Marko 6 @evo-web/marko replacement and the changelog notes describing API differences. Without a name, returns the full mapping table.",
      inputSchema: {
        type: "object",
        properties: { name: { type: "string", description: "Legacy tag name, e.g. 'ebay-menu-button'." } },
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: ({ name } = {}) => {
        const legacy = store.data.legacyComponents || [];
        if (!name) {
          const rows = legacy.map((l) => `| \`<${l.name}>\` | ${l.evoEquivalent.length ? l.evoEquivalent.map((e) => `\`<${e}>\``).join(", ") : "_not yet available in @evo-web/marko_"} |`);
          return text(`| Marko 5 (@ebay/ebayui-core) | Marko 6 (@evo-web/marko) |\n| --- | --- |\n${rows.join("\n")}\n\nFor general Marko 5 → 6 guidance see get_doc("marko-skill:marko-5-to-6-migration").`);
        }
        const n = String(name).toLowerCase().replace(/^<|\/?>$/g, "");
        const full = n.startsWith("ebay-") ? n : `ebay-${n}`;
        const entry = legacy.find((l) => l.name === full);
        if (!entry) return error(`"${full}" is not an @ebay/ebayui-core component. Call migrate_from_ebayui without a name for the full table.`);
        if (!entry.evoEquivalent.length)
          return text(`\`<${full}>\` has no Marko 6 equivalent in @evo-web/marko yet. It can still be used from Marko 6 through Marko 5 interop — see get_doc("marko:guide/marko-5-interop").`);
        const parts = [`\`<${full}>\` → ${entry.evoEquivalent.map((e) => `\`<${e}>\``).join(", ")}`];
        for (const e of entry.evoEquivalent) {
          const c = store.byName.get(e);
          if (c?.changelog?.length) parts.push(`### Notes for <${e}>\n${c.changelog.map((x) => `- **${x.version}** — ${x.text}`).join("\n")}`);
        }
        parts.push(`Call get_component("${entry.evoEquivalent[0]}") for the full Marko 6 API.`);
        return text(parts.join("\n\n"));
      },
    },
    {
      name: "index_info",
      title: "Index information",
      description: "Show which source commits/versions the bundled index was built from and how many components/docs it holds.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: () => text("```json\n" + JSON.stringify(store.summary, null, 2) + "\n```"),
    },
  ];
  return tools;
}

export function createResources(store) {
  const resources = [
    ...store.components.map((c) => ({
      uri: `evo-marko://components/${c.name}`,
      name: c.name,
      title: `<${c.name}> — ${c.title}`,
      description: c.description,
      mimeType: "text/markdown",
    })),
    ...store.docs.map((d) => ({
      uri: `evo-marko://docs/${encodeURIComponent(d.id)}`,
      name: d.id,
      title: d.title,
      description: `${d.source} — ${d.url}`,
      mimeType: "text/markdown",
    })),
  ];
  const templates = [
    { uriTemplate: "evo-marko://components/{name}", name: "component", title: "evo-web component definition", mimeType: "text/markdown" },
    { uriTemplate: "evo-marko://docs/{id}", name: "doc", title: "Marko / evo-web documentation page", mimeType: "text/markdown" },
  ];
  const read = (uri) => {
    const m = /^evo-marko:\/\/(components|docs)\/(.+)$/.exec(uri);
    if (!m) return null;
    const key = decodeURIComponent(m[2]);
    if (m[1] === "components") {
      const r = store.resolveComponent(key);
      return r.component ? store.formatComponent(r.component, ["all"]) : null;
    }
    const d = store.resolveDoc(key);
    return d ? store.formatDoc(d) : null;
  };
  return { resources, templates, read };
}

export function createPrompts() {
  return [
    {
      name: "build_with_evo_marko",
      title: "Build UI with evo-web + Marko 6",
      description: "Guide the assistant to build a Marko 6 template using evo-web components, grounded in this server's docs.",
      arguments: [{ name: "task", description: "What to build, e.g. 'a checkout form with a country select'", required: true }],
      render: ({ task = "" } = {}) => [
        {
          role: "user",
          content: {
            type: "text",
            text: `Build the following with Marko 6 (Tags API) and eBay evo-web components from @evo-web/marko:\n\n${task}\n\nBefore writing code:\n1. Call list_components (with a query) to pick the right <evo-*> tags.\n2. Call get_component for each tag you use and follow its attributes, attribute tags and examples exactly.\n3. Use search_docs / get_doc for Marko 6 language features (<let>, <const>, <if>, <for>, attribute tags, := binding) instead of Marko 5 class-component syntax.\nThen write the .marko template and explain any controllable state and accessibility text (a11y* attributes) that must be localized.`,
          },
        },
      ],
    },
  ];
}
