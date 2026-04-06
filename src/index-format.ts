/**
 * Vault index format and parser.
 *
 * The index is a single JSON blob in R2 (`{prefix}/_vault-bridge-index.json`)
 * that holds search tokens, tags, outgoing links, and a preview snippet for
 * every file in the vault. It replaces the old manifest with a richer
 * structure: it still contains hash/modified/size for sync diffing, plus
 * everything needed to power search, backlinks, tag lookup, etc. without
 * scanning files at query time.
 *
 * IMPORTANT: This parser is the canonical source of truth and is duplicated
 * verbatim into the obsidian-plugin repo. If you change it here, mirror the
 * change there. The plugin and Worker MUST produce identical entries for the
 * same input or the index will get noisy and inconsistent.
 */

export interface FileIndexEntry {
  hash: string;
  modified: string;
  size: number;
  preview: string;
  tokens: string[];
  filenameTokens: string[];
  tags: string[];
  links: string[];
}

export interface VaultIndex {
  version: 1;
  files: Record<string, FileIndexEntry>;
  lastUpdated: string;
}

export const EMPTY_INDEX: VaultIndex = {
  version: 1,
  files: {},
  lastUpdated: new Date(0).toISOString(),
};

// --- Parser ---

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "have", "has", "had", "do", "does", "did",
  "will", "would", "could", "should", "may", "might", "must", "can",
  "this", "that", "these", "those", "i", "you", "he", "she", "it",
  "we", "they", "them", "to", "of", "in", "on", "at", "by", "for",
  "with", "from", "as", "if", "so", "no", "not", "but",
]);

function tokenize(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const tokens = text.toLowerCase().split(/[^\w]+/);
  for (const t of tokens) {
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function extractTags(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Inline tags: #tag, #tag/sub, #tag-with-dash
  // Must be preceded by start-of-line or whitespace (not e.g. URL fragments)
  const inlineRegex = /(?:^|\s)#([\w/-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = inlineRegex.exec(content)) !== null) {
    const tag = m[1].toLowerCase();
    if (!seen.has(tag)) {
      seen.add(tag);
      out.push(tag);
    }
  }

  // Frontmatter tags
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (fmMatch) {
    const fm = fmMatch[1];

    // tags: [a, b, c] or tags: a, b, c
    const inlineTagsMatch = fm.match(/^tags:\s*\[?(.+?)\]?\s*$/m);
    if (inlineTagsMatch) {
      const tags = inlineTagsMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/['"#]/g, "").toLowerCase());
      for (const tag of tags) {
        if (tag && !seen.has(tag)) {
          seen.add(tag);
          out.push(tag);
        }
      }
    }

    // tags:\n  - a\n  - b
    const listMatch = fm.match(/^tags:\s*\n((?:\s*-\s*.+\n?)+)/m);
    if (listMatch) {
      const items = listMatch[1].match(/-\s*(.+)/g);
      if (items) {
        for (const item of items) {
          const tag = item
            .replace(/^-\s*/, "")
            .trim()
            .replace(/['"#]/g, "")
            .toLowerCase();
          if (tag && !seen.has(tag)) {
            seen.add(tag);
            out.push(tag);
          }
        }
      }
    }
  }

  return out;
}

function extractLinks(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];

  // Wikilinks: [[Page]] or [[Page|alias]] or [[Page#section]] or [[folder/Page]]
  const wikiRegex = /\[\[([^\]\|#]+)/g;
  let m: RegExpExecArray | null;
  while ((m = wikiRegex.exec(content)) !== null) {
    const link = m[1].trim();
    if (link && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }

  // Markdown links: [text](path.md) — only local .md links
  const mdRegex = /\[[^\]]*\]\(([^)]+\.md)\)/g;
  while ((m = mdRegex.exec(content)) !== null) {
    const link = m[1].trim();
    if (link && !seen.has(link)) {
      seen.add(link);
      out.push(link);
    }
  }

  return out;
}

function extractPreview(content: string): string {
  const stripped = content.replace(/^---\n[\s\S]*?\n---\n?/, "");
  return stripped.replace(/\s+/g, " ").trim().slice(0, 200);
}

/**
 * Build an index entry from a file's content and metadata.
 */
export function parseFile(
  content: string,
  hash: string,
  modified: string,
  size: number,
  filename: string
): FileIndexEntry {
  return {
    hash,
    modified,
    size,
    preview: extractPreview(content),
    tokens: tokenize(content),
    filenameTokens: tokenize(filename),
    tags: extractTags(content),
    links: extractLinks(content),
  };
}

/**
 * Resolve a wikilink target to a candidate set of paths in an index.
 * Wikilinks may be bare names ("Hello") or paths ("notes/Hello").
 * Returns possible matches without the .md extension stripping issue.
 */
export function linkMatchesPath(link: string, path: string): boolean {
  // Strip .md from path for comparison
  const pathNoExt = path.replace(/\.md$/, "");
  const filename = pathNoExt.split("/").pop() ?? pathNoExt;

  return link === path || link === pathNoExt || link === filename;
}
