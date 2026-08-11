/**
 * The comparison baseline: naive keyword file search — what an agent
 * without any memory layer effectively does on its first grep. Tokenizes
 * the question, scores every indexed file by term occurrences (filename
 * hits weighted heavily), returns the top-k paths.
 */
import fs from "node:fs";

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "how", "does", "do", "is", "are", "where",
  "what", "which", "when", "it", "its", "to", "from", "in", "on", "of",
  "for", "with", "work", "works", "implemented", "implement", "defined",
  "come", "use", "uses", "used", "like", "get", "that", "this", "existing",
]);

export function tokenizeQuery(query: string): string[] {
  return [
    ...new Set(
      query
        .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
        .split(/[^a-zA-Z0-9]+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 1 && !STOPWORDS.has(t))
    ),
  ];
}

export interface BaselineHit {
  path: string;
  score: number;
}

export function baselineSearch(query: string, filePaths: string[], topK = 10): BaselineHit[] {
  const tokens = tokenizeQuery(query);
  const hits: BaselineHit[] = [];
  for (const filePath of filePaths) {
    const content = fs.readFileSync(filePath, "utf8").toLowerCase();
    const nameLower = filePath.toLowerCase();
    let score = 0;
    for (const token of tokens) {
      if (nameLower.includes(token)) score += 25;
      let idx = 0;
      let count = 0;
      while ((idx = content.indexOf(token, idx)) !== -1 && count < 200) {
        count += 1;
        idx += token.length;
      }
      score += count;
    }
    if (score > 0) hits.push({ path: filePath, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, topK);
}
