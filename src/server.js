// Minimal Model Context Protocol server over stdio (newline-delimited JSON-RPC 2.0).
// Implements: initialize, ping, tools/*, resources/*, prompts/*, logging/setLevel.

import { createInterface } from "node:readline";
import { Store } from "./store.js";
import { createTools, createResources, createPrompts } from "./tools.js";

export const SERVER_NAME = "evo-marko-mcp";
export const SERVER_VERSION = "1.0.0";
export const SUPPORTED_PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `This server holds definitions for every eBay evo-web component for Marko 6 (package @evo-web/marko, tags named <evo-*>) plus the Marko 6 documentation from markojs.com and the evo-web site (opensource.ebay.com/evo-web).
- Use list_components / get_component before writing any <evo-*> markup; follow the attributes, attribute tags (<@name>) and examples exactly.
- Use search_docs and get_doc for Marko 6 language questions (Tags API: <let>, <const>, <if>, <for>, attribute tags, := two-way binding). Do not use Marko 5 class-component syntax (class {}, this.state, on-click) in new Marko 6 code.
- Use migrate_from_ebayui when converting @ebay/ebayui-core (<ebay-*>) usage.`;

export class McpServer {
  constructor({ store = new Store(), write = (msg) => process.stdout.write(JSON.stringify(msg) + "\n") } = {}) {
    this.store = store;
    this.write = write;
    this.tools = createTools(store);
    this.toolsByName = new Map(this.tools.map((t) => [t.name, t]));
    this.res = createResources(store);
    this.prompts = createPrompts();
  }

  async handle(msg) {
    if (Array.isArray(msg)) {
      const out = (await Promise.all(msg.map((m) => this.handle(m)))).filter(Boolean);
      return out.length ? out : null;
    }
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      if (msg && "id" in msg && !("method" in msg)) return null; // a response to us; ignore
      return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid Request" } };
    }
    const isNotification = !("id" in msg) || msg.id === null;
    try {
      const result = await this.dispatch(msg.method, msg.params || {});
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: msg.id, result };
    } catch (e) {
      if (isNotification) return null;
      return { jsonrpc: "2.0", id: msg.id, error: { code: e.code ?? -32603, message: e.message || String(e) } };
    }
  }

  async dispatch(method, params) {
    switch (method) {
      case "initialize": {
        const requested = params.protocolVersion;
        return {
          protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : SUPPORTED_PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false }, prompts: { listChanged: false }, logging: {} },
          serverInfo: { name: SERVER_NAME, title: "evo-web + Marko 6", version: SERVER_VERSION },
          instructions: INSTRUCTIONS,
        };
      }
      case "notifications/initialized":
      case "notifications/cancelled":
      case "notifications/roots/list_changed":
        return {};
      case "ping":
        return {};
      case "logging/setLevel":
        return {};
      case "tools/list":
        return { tools: this.tools.map(({ handler, ...t }) => t) };
      case "tools/call": {
        const tool = this.toolsByName.get(params.name);
        if (!tool) throw Object.assign(new Error(`Unknown tool: ${params.name}`), { code: -32602 });
        try {
          return await tool.handler(params.arguments || {});
        } catch (e) {
          return { content: [{ type: "text", text: `Error: ${e.message || e}` }], isError: true };
        }
      }
      case "resources/list":
        return { resources: this.res.resources };
      case "resources/templates/list":
        return { resourceTemplates: this.res.templates };
      case "resources/read": {
        const textOut = this.res.read(params.uri);
        if (textOut == null) throw Object.assign(new Error(`Resource not found: ${params.uri}`), { code: -32002 });
        return { contents: [{ uri: params.uri, mimeType: "text/markdown", text: textOut }] };
      }
      case "prompts/list":
        return { prompts: this.prompts.map(({ render, ...p }) => p) };
      case "prompts/get": {
        const p = this.prompts.find((x) => x.name === params.name);
        if (!p) throw Object.assign(new Error(`Unknown prompt: ${params.name}`), { code: -32602 });
        return { description: p.description, messages: p.render(params.arguments || {}) };
      }
      case "completion/complete":
        return { completion: { values: [], hasMore: false } };
      default:
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
  }

  listen(input = process.stdin) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", async (line) => {
      if (!line.trim()) return;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        this.write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      const res = await this.handle(msg);
      if (res) this.write(res);
    });
    return rl;
  }
}
