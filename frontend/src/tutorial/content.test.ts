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
