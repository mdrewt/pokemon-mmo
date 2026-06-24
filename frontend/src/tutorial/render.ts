// Markdown → HTML for the tutorial blog, with syntax highlighting.
//
// The chapters are authored as Markdown (data, not hand-written HTML) and rendered at runtime
// with `marked`; fenced code blocks are highlighted with highlight.js via the official
// `marked-highlight` bridge. The content is our OWN static text (imported with `?raw` at build
// time), never user input, so we deliberately skip an HTML sanitizer — there is no untrusted
// string to sanitize, and adding one would be cargo-culting a defense for a threat that can't
// occur here. (If this page ever rendered user-supplied markdown, a sanitizer would be
// mandatory.)

import { Marked } from 'marked';
import { markedHighlight } from 'marked-highlight';
// Import highlight.js's CORE plus only the grammars the chapters use. The full highlight.js
// bundle is ~190 languages (~1 MB); registering the eight we actually need keeps the tutorial
// route's payload an order of magnitude smaller. (The wrap-up chapter calls out this exact
// trim as an example of measuring before shipping.)
import hljs from 'highlight.js/lib/core';
import rust from 'highlight.js/lib/languages/rust';
import typescript from 'highlight.js/lib/languages/typescript';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import ini from 'highlight.js/lib/languages/ini';
import bash from 'highlight.js/lib/languages/bash';
import xml from 'highlight.js/lib/languages/xml';
import css from 'highlight.js/lib/languages/css';
import yaml from 'highlight.js/lib/languages/yaml';
import plaintext from 'highlight.js/lib/languages/plaintext';

hljs.registerLanguage('rust', rust);
hljs.registerLanguage('typescript', typescript);
hljs.registerLanguage('javascript', javascript);
hljs.registerLanguage('json', json);
hljs.registerLanguage('ini', ini);
hljs.registerLanguage('bash', bash);
hljs.registerLanguage('xml', xml);
hljs.registerLanguage('css', css);
hljs.registerLanguage('yaml', yaml);
hljs.registerLanguage('plaintext', plaintext);

/**
 * The fence languages the chapters are allowed to use. highlight.js has no dedicated `toml` or
 * `ron` grammar, so we alias them (TOML ≈ ini; RON ≈ rust — close enough for structs/enums).
 * `content.test.ts` asserts every fenced block in the markdown uses one of these keys, which
 * turns a fence typo (```rsut) into a failing unit test instead of an unhighlighted block.
 */
export const KNOWN_FENCE_LANGS: ReadonlyMap<string, string> = new Map([
  ['rust', 'rust'],
  ['rs', 'rust'],
  ['ron', 'rust'],
  ['typescript', 'typescript'],
  ['ts', 'typescript'],
  ['javascript', 'javascript'],
  ['js', 'javascript'],
  ['json', 'json'],
  ['toml', 'ini'],
  ['ini', 'ini'],
  ['bash', 'bash'],
  ['sh', 'bash'],
  ['shell', 'bash'],
  ['console', 'bash'],
  ['html', 'xml'],
  ['xml', 'xml'],
  ['css', 'css'],
  ['yaml', 'yaml'],
  ['yml', 'yaml'],
  ['text', 'plaintext'],
  ['', 'plaintext'],
]);

function highlight(code: string, lang: string): string {
  const mapped = KNOWN_FENCE_LANGS.get(lang.toLowerCase());
  if (mapped && hljs.getLanguage(mapped)) {
    return hljs.highlight(code, { language: mapped, ignoreIllegals: true }).value;
  }
  // Unknown fence: let highlight.js guess rather than dropping the code unstyled.
  return hljs.highlightAuto(code).value;
}

const marked = new Marked(
  markedHighlight({
    langPrefix: 'hljs language-',
    highlight,
  }),
  { gfm: true },
);

/** Render one chapter's Markdown source to an HTML string (synchronous — highlight is sync). */
export function renderMarkdown(md: string): string {
  const out = marked.parse(md);
  // Our highlighter is synchronous, so `parse` returns a string; assert it to satisfy the
  // `string | Promise<string>` signature without an unchecked cast.
  if (typeof out !== 'string') {
    throw new Error('tutorial markdown render was unexpectedly asynchronous');
  }
  return out;
}
