// Polite, dependency-free website crawler that turns pages into Markdown.

import { parseHtml, htmlToMarkdown, extractMain, findTitle, findLinks } from "./html-to-markdown.mjs";

export const DEFAULT_SITES = [
  {
    name: "markojs.com",
    seeds: ["https://markojs.com/docs/introduction/welcome-to-marko", "https://markojs.com/"],
    sitemaps: ["https://markojs.com/sitemap.xml"],
    include: [/^https:\/\/markojs\.com\/docs\//],
    exclude: [/\/docs\/newsletter\/feed\.xml$/, /\.(xml|txt|png|svg|jpe?g|gif|ico|css|js)$/i],
  },
  {
    name: "opensource.ebay.com/evo-web",
    seeds: ["https://opensource.ebay.com/evo-web/", "https://opensource.ebay.com/evo-web/sitemap/"],
    sitemaps: [],
    include: [/^https:\/\/opensource\.ebay\.com\/evo-web\//],
    // Storybook builds are client-rendered and not crawlable as documents.
    exclude: [
      /^https:\/\/opensource\.ebay\.com\/evo-web\/(marko|react|ebayui-core|ebayui-core-react|skin-storybook|public|guide-examples)\//,
      /\.(xml|txt|png|svg|jpe?g|gif|ico|css|js|json|woff2?)$/i,
    ],
  },
];

function normalize(url) {
  try {
    const u = new URL(url);
    u.hash = "";
    u.search = "";
    return u.href;
  } catch {
    return null;
  }
}

function inScope(url, site) {
  return site.include.some((r) => r.test(url)) && !site.exclude.some((r) => r.test(url));
}

async function fetchText(fetchImpl, url, { timeoutMs, userAgent }) {
  const res = await fetchImpl(url, {
    headers: { "user-agent": userAgent, accept: "text/html,application/xml;q=0.9,*/*;q=0.5" },
    redirect: "follow",
    signal: AbortSignal.timeout(timeoutMs),
  });
  const type = res.headers.get("content-type") || "";
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url || url, type, text };
}

async function robotsRules(fetchImpl, origin, opts) {
  try {
    const r = await fetchText(fetchImpl, `${origin}/robots.txt`, opts);
    if (!r.ok) return [];
    const rules = [];
    let applies = false;
    for (const raw of r.text.split("\n")) {
      const line = raw.replace(/#.*/, "").trim();
      const [k, ...rest] = line.split(":");
      const v = rest.join(":").trim();
      if (/^user-agent$/i.test(k)) applies = v === "*" || opts.userAgent.toLowerCase().includes(v.toLowerCase());
      else if (applies && /^disallow$/i.test(k) && v) rules.push(v);
    }
    return rules;
  } catch {
    return [];
  }
}

/**
 * Crawl the given sites. Returns { pages: [{ url, title, markdown, site }], errors }.
 * Options: maxPages (per site), concurrency, delayMs, timeoutMs, fetch, onPage.
 */
export async function crawl(sites = DEFAULT_SITES, opts = {}) {
  const {
    maxPages = 400,
    concurrency = 4,
    delayMs = 150,
    timeoutMs = 20000,
    userAgent = "evo-marko-mcp-crawler (+https://github.com/agliga/evo-marko-mcp)",
    fetch: fetchImpl = globalThis.fetch,
    onPage = () => {},
  } = opts;
  const fopts = { timeoutMs, userAgent };
  const pages = [];
  const errors = [];

  for (const site of sites) {
    const seen = new Set();
    const queue = [];
    const robots = new Map();
    const enqueue = (u) => {
      const n = normalize(u);
      if (!n || seen.has(n) || !inScope(n, site)) return;
      seen.add(n);
      queue.push(n);
    };

    for (const sm of site.sitemaps || []) {
      try {
        const r = await fetchText(fetchImpl, sm, fopts);
        if (r.ok) for (const m of r.text.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) enqueue(m[1].replace(/&amp;/g, "&"));
      } catch (e) {
        errors.push({ url: sm, error: String(e.message || e) });
      }
    }
    for (const s of site.seeds) enqueue(s);

    let count = 0;
    let inFlight = 0;
    const worker = async () => {
      while ((queue.length || inFlight) && count < maxPages) {
        if (!queue.length) {
          // Another worker may still discover links; wait for it.
          await new Promise((res) => setTimeout(res, 25));
          continue;
        }
        const url = queue.shift();
        count++;
        inFlight++;
        try {
          await visit(url);
        } finally {
          inFlight--;
        }
        if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
      }
    };
    const visit = async (url) => {
      {
        const origin = new URL(url).origin;
        if (!robots.has(origin)) robots.set(origin, await robotsRules(fetchImpl, origin, fopts));
        const path = new URL(url).pathname;
        if (robots.get(origin).some((rule) => path.startsWith(rule))) return;
        try {
          const r = await fetchText(fetchImpl, url, fopts);
          if (!r.ok || !/html/i.test(r.type)) {
            if (!r.ok) errors.push({ url, error: `HTTP ${r.status}` });
            return;
          }
          const tree = parseHtml(r.text);
          for (const link of findLinks(tree, r.url)) enqueue(link);
          const main = extractMain(tree);
          const markdown = htmlToMarkdown(main, {
            baseUrl: r.url,
            skipTags: ["nav", "header", "footer", "aside"],
            skipClasses: ["demo", "demo__inner", "skip-link", "breadcrumbs", "toc"],
          });
          if (markdown.length < 40) return;
          const page = { site: site.name, url: normalize(r.url) || url, title: findTitle(tree), markdown };
          pages.push(page);
          onPage(page);
        } catch (e) {
          errors.push({ url, error: String(e.message || e) });
        }
      }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
  }

  // De-duplicate pages that resolved to the same final URL.
  const byUrl = new Map();
  for (const p of pages) if (!byUrl.has(p.url)) byUrl.set(p.url, p);
  return { pages: [...byUrl.values()].sort((a, b) => a.url.localeCompare(b.url)), errors };
}
