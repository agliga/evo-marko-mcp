import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { McpServer, SUPPORTED_PROTOCOL_VERSIONS } from "../src/server.js";
import { Store } from "../src/store.js";

const store = new Store();
const server = new McpServer({ store, write: () => {} });
let nextId = 1;
const call = (method, params = {}) => server.handle({ jsonrpc: "2.0", id: nextId++, method, params });
const tool = async (name, args = {}) => {
  const r = await call("tools/call", { name, arguments: args });
  return { text: r.result.content[0].text, isError: Boolean(r.result.isError) };
};

test("bundled index covers evo-marko components and Marko docs", () => {
  assert.ok(store.components.length >= 60, "components");
  assert.ok(store.docs.some((d) => d.id === "marko:reference/core-tag"));
  assert.ok(store.docs.some((d) => d.id.startsWith("evo:accessibility/")));
  for (const c of store.components) {
    assert.match(c.name, /^evo-/);
    assert.ok(c.examples.length > 0, `${c.name} has examples`);
    assert.ok(c.attributes.length + c.attrTags.length + c.passthrough.length > 0, `${c.name} documents its input`);
  }
});

test("initialize negotiates protocol version", async () => {
  const r = await call("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
  assert.equal(r.result.protocolVersion, "2025-06-18");
  assert.ok(r.result.capabilities.tools);
  const r2 = await call("initialize", { protocolVersion: "1999-01-01" });
  assert.equal(r2.result.protocolVersion, SUPPORTED_PROTOCOL_VERSIONS[0]);
  assert.equal(await server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});

test("tools/list exposes schemas without handlers", async () => {
  const r = await call("tools/list");
  const names = r.result.tools.map((t) => t.name);
  for (const n of ["list_components", "get_component", "search_docs", "get_doc", "list_docs", "search_icons", "migrate_from_ebayui", "index_info"]) assert.ok(names.includes(n), n);
  for (const t of r.result.tools) {
    assert.equal(t.handler, undefined);
    assert.equal(t.inputSchema.type, "object");
  }
});

test("get_component resolves names and documents Marko 6 usage", async () => {
  for (const name of ["evo-tabs", "tabs", "<evo-tabs>", "ebay-tabs", "Tabs"]) {
    const { text, isError } = await tool("get_component", { name });
    assert.equal(isError, false, name);
    assert.match(text, /# `<evo-tabs>`/);
  }
  const { text } = await tool("get_component", { name: "evo-tabs" });
  assert.match(text, /<@tab>/);
  assert.match(text, /<@panel>/);
  assert.match(text, /controllable/);
  assert.match(text, /```marko/);
  const all = await tool("get_component", { name: "evo-button", sections: ["all"] });
  assert.match(all.text, /## TypeScript input types/);
  assert.match(all.text, /## Accessibility/);
  const missing = await tool("get_component", { name: "not-a-thing-at-all" });
  assert.equal(missing.isError, true);
});

test("search_docs finds Marko language reference and component docs", async () => {
  const r = await tool("search_docs", { query: "two-way binding change handler", source: "marko", limit: 3 });
  assert.match(r.text, /marko:reference\/language/);
  const c = await tool("search_docs", { query: "dialog", source: "components", limit: 5 });
  assert.match(c.text, /evo-dialog|evo-alert-dialog|evo-confirm-dialog/);
});

test("get_doc returns full pages and single sections", async () => {
  const full = await tool("get_doc", { id: "https://markojs.com/docs/reference/core-tag" });
  assert.match(full.text, /# Core Tags/);
  const sec = await tool("get_doc", { id: "core-tag", section: "<let>" });
  assert.match(sec.text, /^Source: .*\n\n## `<let>`/);
  assert.doesNotMatch(sec.text, /## `<const>`/);
});

test("list_components, icons, migration and resources", async () => {
  assert.match((await tool("list_components", { category: "buttons" })).text, /evo-button/);
  assert.match((await tool("search_icons", { query: "chevron down 16" })).text, /evo-icon-chevron-down-16/);
  assert.match((await tool("migrate_from_ebayui", { name: "ebay-textbox" })).text, /evo-input/);
  const res = await call("resources/list");
  assert.ok(res.result.resources.some((r) => r.uri === "evo-marko://components/evo-button"));
  const read = await call("resources/read", { uri: "evo-marko://components/evo-button" });
  assert.match(read.result.contents[0].text, /evo-button/);
  const bad = await call("resources/read", { uri: "evo-marko://nope" });
  assert.equal(bad.error.code, -32002);
  assert.equal((await call("nope")).error.code, -32601);
});

test("stdio transport speaks newline-delimited JSON-RPC", async () => {
  const bin = fileURLToPath(new URL("../bin/evo-marko-mcp.js", import.meta.url));
  const p = spawn(process.execPath, [bin], { stdio: ["pipe", "pipe", "ignore"] });
  const lines = [];
  let buf = "";
  const done = new Promise((resolve) => {
    p.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
        if (lines.length === 2) resolve();
      }
    });
  });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26" } }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "get_component", arguments: { name: "switch" } } }) + "\n");
  await done;
  p.kill();
  assert.equal(lines[0].result.serverInfo.name, "evo-marko-mcp");
  assert.match(lines[1].result.content[0].text, /evo-switch/);
});
