// Tiny BM25 full-text index.

const STOP = new Set(
  "a an and are as at be but by for from has have how i if in into is it its of on or that the their them then there these this to was what when where which with you your can do does use using used".split(
    " ",
  ),
);

/** Tokenize text. Hyphenated words (evo-button, a11y-text) are indexed whole and split. */
export function tokenize(text) {
  const out = [];
  for (const m of String(text).matchAll(/[A-Za-z0-9@$][A-Za-z0-9@$_-]*/g)) {
    const raw = m[0].replace(/-+$/, "");
    const word = raw.toLowerCase();
    if (!word) continue;
    if (!STOP.has(word)) out.push(word);
    if (word.includes("-")) for (const part of word.split("-")) if (part && !STOP.has(part)) out.push(part);
    // camelCase attribute names: a11yCloseText -> a11y, close, text
    if (/[a-z0-9][A-Z]/.test(raw)) {
      for (const part of raw.split(/(?<=[a-z0-9])(?=[A-Z])/)) {
        const p = part.toLowerCase().replace(/[@$]/g, "");
        if (p && p !== word && !STOP.has(p)) out.push(p);
      }
    }
    if (word.startsWith("@") && word.length > 1) out.push(word.slice(1));
  }
  return out;
}

export class SearchIndex {
  constructor({ k1 = 1.2, b = 0.75 } = {}) {
    this.k1 = k1;
    this.b = b;
    this.docs = [];
    this.postings = new Map();
    this.totalLen = 0;
  }

  /** Add a document. `fields` is [{ text, weight }]. */
  add(ref, fields) {
    const tf = new Map();
    let len = 0;
    for (const { text, weight = 1 } of fields) {
      for (const t of tokenize(text || "")) {
        tf.set(t, (tf.get(t) || 0) + weight);
        len += weight;
      }
    }
    const id = this.docs.length;
    this.docs.push({ ref, len });
    this.totalLen += len;
    for (const [t, f] of tf) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = []));
      p.push([id, f]);
    }
  }

  search(query, { limit = 10, filter } = {}) {
    const terms = [...new Set(tokenize(query))];
    if (!terms.length || !this.docs.length) return [];
    const N = this.docs.length;
    const avg = this.totalLen / N;
    const scores = new Map();
    const matched = new Map();
    for (const t of terms) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.length + 0.5) / (p.length + 0.5));
      for (const [id, f] of p) {
        const d = this.docs[id];
        const s = (idf * f * (this.k1 + 1)) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg));
        scores.set(id, (scores.get(id) || 0) + s);
        matched.set(id, (matched.get(id) || 0) + 1);
      }
    }
    const results = [];
    for (const [id, score] of scores) {
      const ref = this.docs[id].ref;
      if (filter && !filter(ref)) continue;
      // Reward documents matching more of the query terms.
      const coverage = matched.get(id) / terms.length;
      results.push({ ref, score: score * (0.5 + coverage) });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, limit);
  }
}
