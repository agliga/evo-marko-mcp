#!/usr/bin/env node
// Crawl https://markojs.com/docs and https://opensource.ebay.com/evo-web/ and
// save the pages as Markdown to data/crawl.json. Then run `npm run build:index`
// to merge them into data/index.json.
//
// Usage: node scripts/crawl.mjs [--max-pages 400] [--concurrency 4] [--site markojs.com]

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { crawl, DEFAULT_SITES } from "./lib/crawler.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const val = (n, d) => {
  const i = args.indexOf(n);
  return i === -1 ? d : args[i + 1];
};

const only = val("--site", null);
const sites = only ? DEFAULT_SITES.filter((s) => s.name.includes(only)) : DEFAULT_SITES;
const out = path.resolve(val("--out", path.join(ROOT, "data", "crawl.json")));

const started = Date.now();
const { pages, errors } = await crawl(sites, {
  maxPages: Number(val("--max-pages", 400)),
  concurrency: Number(val("--concurrency", 4)),
  onPage: (p) => console.error(`[crawl] ${p.url}`),
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify({ crawledAt: new Date().toISOString(), sites: sites.map((s) => s.name), pages, errors }, null, 1));
console.error(`[crawl] ${pages.length} pages, ${errors.length} errors in ${((Date.now() - started) / 1000).toFixed(1)}s -> ${out}`);
if (errors.length) console.error(errors.slice(0, 10).map((e) => `  ${e.url}: ${e.error}`).join("\n"));
