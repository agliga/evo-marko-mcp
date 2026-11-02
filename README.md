# evo-marko-mcp

An [MCP](https://modelcontextprotocol.io) server that gives AI assistants accurate definitions for every **eBay evo-web component in Marko 6** and the **Marko 6 documentation**, so they write correct `<evo-*>` markup and Tags API code instead of guessing.

It covers:

- **All `@evo-web/marko` components** (the Marko 6 / Tags API implementation of evo-web): description, every attribute with type/default/options, *controllable* attributes (`:=` binding), attribute tags (`<@tab>`, `<@option>`, nested `<@panel>`…), native-attribute passthrough, all Storybook examples, TypeScript `Input` types, accessibility guidance, Skin CSS markup, changelog notes, and the Marko 5 `<ebay-*>` tag each one replaces.
- **Marko docs from [markojs.com](https://markojs.com/docs/)** — language reference, core tags, reactivity, TypeScript, `@marko/run`, explanations and guides — plus the official Marko best-practices and Marko 5→6 migration guides.
- **The evo-web site ([opensource.ebay.com/evo-web](https://opensource.ebay.com/evo-web/))** — component pages, accessibility patterns / techniques / anti-patterns, and guides.
- **1,100+ evo icons** (`<evo-icon-*>`).

No runtime dependencies. Node 18.17+.

## Install

### Claude Code

```sh
claude mcp add evo-marko -- npx -y github:agliga/evo-marko-mcp
```

### Claude Desktop / Cursor / VS Code / any MCP client

```json
{
  "mcpServers": {
    "evo-marko": {
      "command": "npx",
      "args": ["-y", "github:agliga/evo-marko-mcp"]
    }
  }
}
```

Or from a local clone: `"command": "node", "args": ["/path/to/evo-marko-mcp/bin/evo-marko-mcp.js"]`.

## Tools

| Tool | What it does |
| --- | --- |
| `list_components` | All evo-web Marko 6 components by category; filter by `category` or free-text `query` ("date picker"). |
| `get_component` | Full definition of one component. Accepts `button`, `evo-button`, `<evo-button>` or a Marko 5 name like `ebay-button`. `sections`: `overview`, `usage`, `attributes`, `attrTags`, `examples` (default) plus `types`, `accessibility`, `css`, `sitePage`, `changelog`, or `all`. |
| `search_docs` | BM25 search across Marko docs, evo-web docs and component definitions. `source`: `all` \| `marko` \| `evo` \| `components`. |
| `get_doc` | Read a doc page by id (`marko:reference/core-tag`), URL or slug; `section` returns one heading. |
| `list_docs` | List every doc page id and title. |
| `search_icons` | Find `<evo-icon-*>` tags ("chevron down 16"). |
| `migrate_from_ebayui` | Map `@ebay/ebayui-core` `<ebay-*>` tags to their `@evo-web/marko` replacements, with API-change notes. |
| `index_info` | Source commits and versions the index was built from. |

Every component and doc page is also exposed as an MCP **resource** (`evo-marko://components/{name}`, `evo-marko://docs/{id}`), and a `build_with_evo_marko` **prompt** walks an assistant through building a template with these tools.

Example — `get_component { "name": "tabs" }` returns, among other things:

```marko
<let/curr=0>
<evo-tabs index:=curr>
  <@tab>
    <@panel><h3>Panel 1</h3></@panel>
    Tab 1
  </@tab>
  ...
</evo-tabs>
```

## How the data is built

`data/index.json` is generated and committed, so the server works offline with no setup. It is built from the source repositories that publish both sites, which is more precise than scraping rendered HTML (real TypeScript types, Storybook arg docs, and example `.marko` files):

| Site | Source |
| --- | --- |
| opensource.ebay.com/evo-web | [eBay/evo-web](https://github.com/eBay/evo-web) — `packages/evo-marko/src/tags/*` (types, README, stories, examples), `src/routes/**` (site pages), `src/data/component-metadata.json` |
| markojs.com | [marko-js/website](https://github.com/marko-js/website) `docs/**/*.md`, [marko-js/marko](https://github.com/marko-js/marko) `skills/` |

A live-site crawler is included as well. Pages it finds that are not already covered by the sources are merged into the index.

```sh
npm run build:index              # shallow-clones the repos into .cache/sources and rebuilds data/index.json
npm run crawl                    # crawls markojs.com/docs and opensource.ebay.com/evo-web -> data/crawl.json
npm run refresh                  # crawl, then rebuild
node scripts/build-index.mjs --sources ~/code   # reuse existing clones in ~/code/{evo-web,website,marko}
```

The crawler respects `robots.txt`, stays inside `markojs.com/docs/` and `opensource.ebay.com/evo-web/`, skips the client-rendered Storybook builds, and rate-limits itself (`--max-pages`, `--concurrency`, `--site`).

## Development

```sh
npm test          # node:test — parsers, crawler (against a local server), every tool, stdio transport
npm start         # run the server on stdio
node bin/evo-marko-mcp.js --info
```

Layout:

```
bin/evo-marko-mcp.js        CLI entry (stdio server)
src/server.js               MCP JSON-RPC protocol (initialize, tools, resources, prompts)
src/tools.js                tool / resource / prompt definitions
src/store.js                index loading, name resolution, Markdown formatting
src/search.js               BM25 search
scripts/build-index.mjs     builds data/index.json from the source repos (+ crawl.json)
scripts/crawl.mjs           live-site crawler CLI
scripts/lib/                HTML→Markdown, TS/Storybook extraction, crawler
data/index.json             generated index (committed)
```

## License

MIT
