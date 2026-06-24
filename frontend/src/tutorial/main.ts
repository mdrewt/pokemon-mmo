// The tutorial blog app. Loads the Markdown chapters, renders them, and wires up the sidebar
// table of contents, hash-based chapter routing, prev/next paging, in-chapter heading anchors,
// and per-code-block copy buttons. This is a plain DOM app — no framework — because the page is
// static long-form content; a SPA framework would be weight without benefit (see the wrap-up
// chapter, which owns up to exactly this kind of tradeoff).

import './tutorial.css';
import { renderMarkdown } from './render';

interface Chapter {
  /** Stable id used for the URL hash, derived from the filename (e.g. `02-game-core`). */
  id: string;
  /** Display title, taken from the chapter's first `# ` heading. */
  title: string;
  /** Raw markdown source. */
  md: string;
  /** Rendered HTML body, parsed lazily on first view and cached (only the viewed chapter renders). */
  html?: string;
}

/** Eagerly load every chapter's raw Markdown at build time, keyed by file path. */
const sources = import.meta.glob('./content/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function titleOf(md: string, fallback: string): string {
  const heading = md.split('\n').find((line) => line.startsWith('# '));
  return heading ? heading.slice(2).trim() : fallback;
}

/** Filename (sans numeric prefix + extension) → chapter id, e.g. `00-introduction.md` → `introduction`. */
function idOf(path: string): string {
  const file = path.split('/').pop() ?? path;
  return file.replace(/\.md$/, '').replace(/^\d+[-_]?/, '');
}

// Sort by file path so the numeric filename prefixes define chapter order.
const chapters: Chapter[] = Object.keys(sources)
  .sort()
  .map((path) => {
    const md = sources[path] ?? '';
    const id = idOf(path);
    return { id, title: titleOf(md, id), md };
  });

/** Render a chapter's HTML on first view, then serve the cached result. */
function chapterHtml(ch: Chapter): string {
  ch.html ??= renderMarkdown(ch.md);
  return ch.html;
}

const root = document.getElementById('tutorial-root');
if (!root) throw new Error('tutorial-root mount node missing');

root.innerHTML = `
  <header class="tut-header">
    <a class="tut-back" href="/">&larr; Back to the game</a>
    <span class="tut-brand">Monster&nbsp;Tamer&nbsp;MMO &middot; Build&nbsp;It&nbsp;Yourself</span>
  </header>
  <div class="tut-body">
    <nav class="tut-toc" aria-label="Table of contents"><ol></ol></nav>
    <main class="tut-main">
      <article class="tut-article"></article>
      <div class="tut-pager">
        <a class="tut-prev" href="#"></a>
        <a class="tut-next" href="#"></a>
      </div>
    </main>
  </div>
`;

const tocList = root.querySelector<HTMLOListElement>('.tut-toc ol');
const article = root.querySelector<HTMLElement>('.tut-article');
const prevLink = root.querySelector<HTMLAnchorElement>('.tut-prev');
const nextLink = root.querySelector<HTMLAnchorElement>('.tut-next');
if (!tocList || !article || !prevLink || !nextLink) throw new Error('tutorial layout failed to build');

// Build the top-level chapter list once.
for (const ch of chapters) {
  const li = document.createElement('li');
  const a = document.createElement('a');
  a.href = `#${ch.id}`;
  a.textContent = ch.title;
  a.dataset['chapter'] = ch.id;
  li.appendChild(a);
  tocList.appendChild(li);
}

function currentIndex(): number {
  const id = location.hash.replace(/^#/, '');
  const idx = chapters.findIndex((c) => c.id === id);
  return idx === -1 ? 0 : idx;
}

function showChapter(index: number): void {
  const ch = chapters[index];
  if (!ch || !article || !tocList || !prevLink || !nextLink) return;

  article.innerHTML = chapterHtml(ch);

  // Give headings stable, UNIQUE ids so in-page anchors and the sub-TOC work. A chapter can repeat a
  // heading ("How it works", "Common pitfalls"), which would otherwise emit duplicate ids; suffix
  // collisions with -2, -3, … so every anchor resolves to its own section.
  const subItems: { id: string; text: string }[] = [];
  const usedIds = new Set<string>();
  article.querySelectorAll<HTMLHeadingElement>('h2, h3').forEach((h) => {
    const base = slugify(h.textContent ?? '');
    if (!base) return;
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    h.id = id;
    if (h.tagName === 'H2') subItems.push({ id, text: h.textContent ?? '' });
  });

  // Add a copy button to every code block.
  article.querySelectorAll<HTMLPreElement>('pre').forEach((pre) => {
    const btn = document.createElement('button');
    btn.className = 'tut-copy';
    btn.type = 'button';
    btn.textContent = 'Copy';
    pre.appendChild(btn);
  });

  // External links (citations, the References list, "further reading") open in a new tab so a reader
  // following a source doesn't lose their place in the tutorial.
  article.querySelectorAll<HTMLAnchorElement>('a[href^="http"]').forEach((a) => {
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  });

  // Highlight the active chapter in the sidebar and render its H2 sub-sections beneath it.
  tocList.querySelectorAll('li').forEach((li) => {
    const link = li.querySelector<HTMLAnchorElement>('a[data-chapter]');
    const isActive = link?.dataset['chapter'] === ch.id;
    li.classList.toggle('active', !!isActive);
    li.querySelector('.tut-subtoc')?.remove();
    if (isActive && subItems.length > 0) {
      const sub = document.createElement('ul');
      sub.className = 'tut-subtoc';
      for (const item of subItems) {
        const sLi = document.createElement('li');
        const sA = document.createElement('a');
        sA.href = `#${ch.id}`;
        sA.textContent = item.text;
        sA.addEventListener('click', (e) => {
          e.preventDefault();
          document.getElementById(item.id)?.scrollIntoView({ behavior: 'smooth' });
        });
        sLi.appendChild(sA);
        sub.appendChild(sLi);
      }
      li.appendChild(sub);
    }
  });

  // Pager.
  const prev = chapters[index - 1];
  const next = chapters[index + 1];
  if (prev) {
    prevLink.style.visibility = 'visible';
    prevLink.href = `#${prev.id}`;
    prevLink.textContent = `← ${prev.title}`;
  } else {
    prevLink.style.visibility = 'hidden';
  }
  if (next) {
    nextLink.style.visibility = 'visible';
    nextLink.href = `#${next.id}`;
    nextLink.textContent = `${next.title} →`;
  } else {
    nextLink.style.visibility = 'hidden';
  }

  document.title = `${ch.title} — Build a Multiplayer MMO`;
  window.scrollTo({ top: 0 });
}

// Copy-to-clipboard via event delegation (one listener, survives chapter re-renders).
article.addEventListener('click', (e) => {
  const target = e.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains('tut-copy')) return;
  const pre = target.closest('pre');
  const code = pre?.querySelector('code');
  if (!code) return;
  void navigator.clipboard?.writeText(code.innerText).then(() => {
    target.textContent = 'Copied!';
    setTimeout(() => (target.textContent = 'Copy'), 1200);
  });
});

window.addEventListener('hashchange', () => showChapter(currentIndex()));

// Land on the chapter named in the URL hash (or the first chapter), normalizing the hash so a
// bare `/tutorial.html` deep-links cleanly.
if (!location.hash && chapters[0]) {
  location.replace(`#${chapters[0].id}`);
}
showChapter(currentIndex());
