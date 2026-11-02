#!/usr/bin/env node
import { McpServer } from "../src/server.js";
import { Store } from "../src/store.js";

const arg = process.argv[2];

if (arg === "--help" || arg === "-h") {
  console.log(`evo-marko-mcp — MCP server (stdio) for eBay evo-web components and Marko 6 docs

Usage:
  evo-marko-mcp                 start the MCP server on stdio
  evo-marko-mcp --info          print what the bundled index contains

Environment:
  EVO_MARKO_MCP_INDEX=path      use a different index.json`);
  process.exit(0);
}

const store = new Store();
if (arg === "--info") {
  console.log(JSON.stringify(store.summary, null, 2));
  process.exit(0);
}

new McpServer({ store }).listen();
// Never write logs to stdout: it carries the protocol.
console.error(`[evo-marko-mcp] ready: ${store.components.length} components, ${store.docs.length} docs`);
