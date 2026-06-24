// Guards the tutorial content as data: the chapters load in a stable order, each is a well-formed
// document (exactly one H1 title), and every fenced code block uses a language the renderer can
// highlight. A fence typo (```rsut) or a missing/duplicate title fails here instead of shipping a
// broken page — the same "make content bugs build failures" discipline the tutorial itself preaches.

import { describe, it, expect } from 'vitest';
import { KNOWN_FENCE_LANGS } from './render';

const sources = import.meta.glob('./content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const entries = Object.entries(sources).sort(([a], [b]) => a.localeCompare(b));

/** The info strings of every opening code fence in a markdown document. */
function fenceLangs(md: string): string[] {
  const langs: string[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    const m = /^```(\S*)/.exec(line.trimEnd());
    if (!m) continue;
    if (!inFence) {
      langs.push(m[1] ?? ''); // opening fence — record its language (may be empty)
      inFence = true;
    } else {
      inFence = false; // closing fence
    }
  }
  return langs;
}

/** ATX `# ` headings that are real prose headings, i.e. NOT inside a fenced code block (a `# ...`
 *  comment line in a TOML/RON snippet is code, not a heading). */
function h1Count(md: string): number {
  let inFence = false;
  let count = 0;
  for (const line of md.split('\n')) {
    if (/^```/.test(line.trimEnd())) {
      inFence = !inFence;
      continue;
    }
    if (!inFence && /^# \S/.test(line)) count += 1;
  }
  return count;
}

describe('tutorial content', () => {
  it('ships the full milestone arc (intro + M0–M11 + wrap-up)', () => {
    // 00 intro, 01–12 the twelve milestone/framing chapters, 13 wrap-up.
    expect(entries.length).toBe(14);
  });

  it('orders chapters by their numeric filename prefix', () => {
    const files = entries.map(([path]) => path.split('/').pop() ?? path);
    expect(files).toEqual([...files].sort());
    expect(files[0]).toMatch(/^00[-_]/);
    expect(files.at(-1)).toMatch(/^13[-_]/);
  });

  it('gives every chapter exactly one H1 title', () => {
    for (const [path, md] of entries) {
      expect(h1Count(md), `${path} should have exactly one H1`).toBe(1);
    }
  });

  it('only uses fence languages the renderer can highlight', () => {
    for (const [path, md] of entries) {
      for (const lang of fenceLangs(md)) {
        expect(
          KNOWN_FENCE_LANGS.has(lang.toLowerCase()),
          `${path}: unknown code fence language "${lang}"`,
        ).toBe(true);
      }
    }
  });

  it('balances every code fence (no unterminated block)', () => {
    for (const [path, md] of entries) {
      const fences = md.split('\n').filter((line) => /^```/.test(line.trimEnd())).length;
      expect(fences % 2, `${path} has an unterminated code fence`).toBe(0);
    }
  });
});

/** Inline citation numbers used in the prose, e.g. `<sup>[3](https://…)</sup>` → 3. */
function citationNumbers(md: string): number[] {
  return [...md.matchAll(/<sup>\[(\d+)\]\(([^)]+)\)<\/sup>/g)].map((m) => Number(m[1]));
}

/** Inline citation target URLs, for the trustworthiness check. */
function citationUrls(md: string): string[] {
  return [...md.matchAll(/<sup>\[\d+\]\(([^)]+)\)<\/sup>/g)].map((m) => m[1] ?? '');
}

/** The numbered entries under the chapter's `## References` heading, e.g. `3. [Title](url) …` → 3. */
function referenceNumbers(md: string): number[] {
  const idx = md.indexOf('## References');
  if (idx === -1) return [];
  return md
    .slice(idx)
    .split('\n')
    .map((line) => /^(\d+)\.\s/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]));
}

describe('tutorial references (Wikipedia-style citations)', () => {
  it('gives every chapter a References section', () => {
    for (const [path, md] of entries) {
      expect(md.includes('## References'), `${path} is missing a References section`).toBe(true);
    }
  });

  it('matches inline citations to reference entries one-to-one (no dangling or uncited)', () => {
    for (const [path, md] of entries) {
      const cited = [...new Set(citationNumbers(md))].sort((a, b) => a - b);
      const refs = referenceNumbers(md);
      // References list is a contiguous 1..N with no duplicates.
      const expected = refs.map((_, i) => i + 1);
      expect(refs, `${path} references must be numbered 1..N with no gaps`).toEqual(expected);
      // Every reference is cited at least once, and every inline citation has a reference.
      expect(cited, `${path}: inline citations must match the References list exactly`).toEqual(
        expected,
      );
    }
  });

  it('cites only https sources', () => {
    for (const [path, md] of entries) {
      for (const url of citationUrls(md)) {
        expect(url.startsWith('https://'), `${path}: non-https citation ${url}`).toBe(true);
      }
    }
  });
});
