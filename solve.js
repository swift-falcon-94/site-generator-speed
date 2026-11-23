// A faster drop-in for makefun-site 1.0.0.
//
// Written from the makefun-site README (front matter, template dialect,
// Markdown subset, slug rule, report) and its reference behaviour. Same
// answers, byte for byte, for every input; built for speed instead of
// shape: no token objects in Markdown, no per-character HTML escaping in
// inline rendering, slug/date caches, a front-matter scanner that only
// touches the header lines, and templates compiled to plain functions
// with memoised includes. One run(input) call is self-contained: every
// cache lives in that call's build state, nothing carries to the next case.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RESERVED = ['posts', 'tags', 'page'];
const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** HTML escaping: & < > " ' and nothing else. */
function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** The slug of `text`, cached per build (titles, tags and headings repeat). */
function slugify(B, text) {
  const hit = B.slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) > 127) { ascii = false; break; }
  }
  // ASCII is fixed by NFKD, so only non-ASCII text needs normalisation.
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  B.slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

/** A YYYY-MM-DD date in words, from the string alone, cached per build. */
function longDate(B, date) {
  const hit = B.dateCache.get(date);
  if (hit !== undefined) return hit;
  const out = `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
  B.dateCache.set(date, out);
  return out;
}

/** The words of a body: runs of characters other than whitespace. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let ws;
    if (c < 128) ws = c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13;
    else ws = /\s/.test(text[i]);
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A quoted or bare string value, or its refusal reason. */
function stringOf(raw) {
  if (raw[0] === '"') {
    if (raw.length < 2 || raw[raw.length - 1] !== '"') return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw[0] === '[') return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      let ok = raw.length === 10 && raw[4] === '-' && raw[7] === '-';
      let y = 0;
      let mo = 0;
      let d = 0;
      if (ok) {
        for (let i = 0; i < 10; i++) {
          if (i === 4 || i === 7) continue;
          const c = raw.charCodeAt(i);
          if (c < 48 || c > 57) { ok = false; break; }
        }
      }
      if (ok) {
        y = Number(raw.slice(0, 4));
        mo = Number(raw.slice(5, 7));
        d = Number(raw.slice(8, 10));
        if (y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) ok = false;
      }
      if (!ok) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw[0] !== '[' || raw[raw.length - 1] !== ']') return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '' || t.includes('"') || t.includes('[') || t.includes(']')) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let i = 0; i < raw.length; i++) {
        const c = raw[i];
        if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '-')) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      const parts = raw.split('-');
      for (const p of parts) {
        if (p.length === 0) return { error: 'key "slug": not a slug' };
        for (let i = 0; i < p.length; i++) {
          const c = p[i];
          if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9'))) return { error: 'key "slug": not a slug' };
        }
      }
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error }.
 * Only the header lines are scanned; the body is one slice.
 */
function parseFrontMatter(text) {
  const nl = text.indexOf('\n');
  const first = nl === -1 ? text : text.slice(0, nl);
  if (first !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  // Find the closing line: a line that is exactly '---'.
  let closeAt = -1;
  let pos = nl;
  for (;;) {
    const idx = text.indexOf('\n---', pos);
    if (idx === -1) return { error: 'the front matter is not closed' };
    const after = idx + 4;
    if (after === text.length || text[after] === '\n') { closeAt = idx; break; }
    pos = idx + 1;
  }
  const body = closeAt + 4 === text.length ? '' : text.slice(closeAt + 5);
  const fmText = text.slice(nl + 1, closeAt);
  const lines = fmText === '' ? [] : fmText.split('\n');
  const data = {};
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    let blank = true;
    for (let i = 0; i < line.length; i++) {
      if (line[i] !== ' ' && line[i] !== '\t') { blank = false; break; }
    }
    if (blank || line[0] === '#') continue;
    // key: value — key of a-z and _, colon, one space, then the value.
    let j = 0;
    while (j < line.length && ((line[j] >= 'a' && line[j] <= 'z') || line[j] === '_')) j++;
    if (j === 0 || line[j] !== ':') return { error: `line ${li + 2} is not "key: value"` };
    let raw;
    if (j + 1 === line.length) raw = '';
    else if (line[j + 1] === ' ') raw = line.slice(j + 2);
    else return { error: `line ${li + 2} is not "key: value"` };
    let end = raw.length;
    while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
    if (end !== raw.length) raw = raw.slice(0, end);
    const key = line.slice(0, j);
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body };
}

// ---------------------------------------------------------------- Markdown

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const INLINE_TEST = /[\\`*\[&<>"']/;

function isSpaceTab(c) {
  return c === ' ' || c === '\t';
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) if (!isSpaceTab(line[i])) return false;
  return true;
}

/** A fence's language, or null when the line is not a fence opener. */
function fenceLang(line) {
  if (line[0] !== '`' || line[1] !== '`' || line[2] !== '`') return null;
  let j = 3;
  while (j < line.length) {
    const c = line[j];
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c === '_' || c === '+' || c === '-') j++;
    else break;
  }
  for (let k = j; k < line.length; k++) if (!isSpaceTab(line[k])) return null;
  return line.slice(3, j);
}

/** A heading line's level and text, or null. */
function headingOf(line) {
  if (line[0] !== '#') return null;
  let n = 0;
  while (n < line.length && line[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n >= line.length || !isSpaceTab(line[n])) return null;
  let j = n;
  while (j < line.length && isSpaceTab(line[j])) j++;
  let end = line.length;
  while (end > j && isSpaceTab(line[end - 1])) end--;
  if (end === j) return null;
  return { depth: n, text: line.slice(j, end) };
}

function isHr(line) {
  if (line.length < 3) return false;
  const h = line[0] === '-' && line[1] === '-' && line[2] === '-';
  const s = line[0] === '*' && line[1] === '*' && line[2] === '*';
  if (!h && !s) return false;
  for (let k = 3; k < line.length; k++) if (!isSpaceTab(line[k])) return false;
  return true;
}

/** Whether `line` ends a paragraph: blank, fence, heading or break. */
function endsParagraph(line) {
  const c = line[0];
  if (c === undefined) return true;
  if (c === '#') return headingOf(line) !== null;
  if (c === '`') return fenceLang(line) !== null;
  if (c === '-' || c === '*') return isHr(line);
  if (c === ' ' || c === '\t') return isBlank(line);
  return false;
}

function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && isSpaceTab(line[a])) a++;
  while (b > a && isSpaceTab(line[b - 1])) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** The first index from `from` where `s` holds `what` outside an escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s[j] !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `link(target)` is a link's href. */
function inline(s, link) {
  // The common case: no markup and nothing to escape — return as-is.
  if (!INLINE_TEST.test(s)) return s;
  // Jump from one markup character to the next with the regex engine;
  // the plain runs between them only need one HTML escape each.
  const re = /[\\`*[]/g;
  const out = [];
  let run = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    const i = m.index;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < s.length && ESCAPABLE.has(s[i + 1])) {
        if (i > run) out.push(escapeHtml(s.slice(run, i)));
        out.push(ESCAPES[s[i + 1]] ?? s[i + 1]);
        run = i + 2;
        re.lastIndex = run;
      }
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out.push(escapeHtml(s.slice(run, i)));
        out.push('<code>', escapeHtml(s.slice(i + 1, j)), '</code>');
        run = j + 1;
        re.lastIndex = run;
      }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out.push(escapeHtml(s.slice(run, i)));
          out.push('<strong>', inline(s.slice(i + 2, j), link), '</strong>');
          run = j + 2;
          re.lastIndex = run;
        } else {
          // No closer: both stars stay plain, as the reference does.
          re.lastIndex = i + 2;
        }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) {
        if (i > run) out.push(escapeHtml(s.slice(run, i)));
        out.push('<em>', inline(s.slice(i + 1, j), link), '</em>');
        run = j + 1;
        re.lastIndex = run;
      }
      continue;
    }
    // c === '['
    const k = findUnescaped(s, ']', i + 1);
    const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
    const target = mm === -1 ? '' : s.slice(k + 2, mm);
    if (target !== '' && !/\s/.test(target)) {
      if (i > run) out.push(escapeHtml(s.slice(run, i)));
      out.push('<a href="', escapeHtml(link(target)), '">', inline(s.slice(i + 1, k), link), '</a>');
      run = mm + 1;
      re.lastIndex = run;
    }
  }
  if (s.length > run) out.push(escapeHtml(s.slice(run)));
  return out.join('');
}

/**
 * `src` rendered, in one pass over its lines: its HTML, its table of
 * contents (level 2 and 3 headings) and its excerpt (first paragraph).
 */
function renderMarkdown(B, src, link) {
  const lines = src.split('\n');
  const blocks = [];
  const toc = [];
  const ids = new Set();
  let excerpt = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const c0 = line[0];
    if (c0 === undefined || c0 === ' ' || c0 === '\t') {
      // Blank, or a paragraph line: no block starts with a space or tab.
      if (isBlank(line)) {
        i++;
        continue;
      }
    } else if (c0 === '`') {
      const lang = fenceLang(line);
      if (lang !== null) {
        const body = [];
        i++;
        while (i < lines.length && !(lines[i][0] === '`' && lines[i][1] === '`' && lines[i][2] === '`' && fenceClose(lines[i]))) body.push(lines[i++]);
        i++;
        const inner = body.length === 0 ? '' : escapeHtml(`${body.join('\n')}\n`);
        blocks.push(`<pre><code${lang === '' ? '' : ` class="language-${lang}"`}>${inner}</code></pre>\n`);
        continue;
      }
    } else if (c0 === '#') {
      const heading = headingOf(line);
      if (heading !== null) {
        const id = uniqueSlug(slugify(B, heading.text), ids);
        const html = inline(heading.text, link);
        blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>\n`);
        if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
        i++;
        continue;
      }
    } else if (c0 === '-' || c0 === '*') {
      if (isHr(line)) {
        blocks.push('<hr>\n');
        i++;
        continue;
      }
    } else if (c0 === '>') {
      const body = [];
      while (i < lines.length && lines[i][0] === '>') {
        const l = lines[i++];
        body.push(trimLine(l[1] === ' ' ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>\n' : `<blockquote>\n<p>${inline(kept.join('\n'), link)}</p>\n</blockquote>\n`);
      continue;
    }
    const bullet = (c0 === '-' || c0 === '*') && line[1] === ' ';
    let ordered = null;
    if (!bullet) ordered = orderedOf(line);
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < lines.length) {
        const l = lines[i];
        if (isOrdered) {
          const o = orderedOf(l);
          if (o !== null) {
            items.push([trimLine(o.text)]);
            i++;
            continue;
          }
        } else if ((l[0] === '-' || l[0] === '*') && l[1] === ' ') {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (isContinued(l)) {
          items[items.length - 1].push(trimLine(l));
          i++;
          continue;
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      let lis = '';
      for (const parts of items) lis += `<li>${inline(parts.join('\n'), link)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>\n`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), link);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>\n`);
  }
  return { html: blocks.join(''), toc, excerpt: excerpt ?? '' };
}

/** A fence closing line: ``` then spaces or tabs only. */
function fenceClose(line) {
  if (line[3] !== undefined && line[3] !== ' ' && line[3] !== '\t') return false;
  for (let k = 3; k < line.length; k++) if (!isSpaceTab(line[k])) return false;
  return true;
}

/** An ordered-list item's number and text, or null. */
function orderedOf(line) {
  let n = 0;
  while (n < line.length && line[n] >= '0' && line[n] <= '9') n++;
  if (n === 0 || n > 9) return null;
  if (line[n] !== '.' || line[n + 1] !== ' ') return null;
  return { start: Number(line.slice(0, n)), text: line.slice(n + 2) };
}

/** A list continuation line: two or more spaces, then a non-space char. */
function isContinued(line) {
  if (line.length < 3 || line[0] !== ' ' || line[1] !== ' ') return false;
  let j = 2;
  while (j < line.length && line[j] === ' ') j++;
  if (j >= line.length) return false;
  const c = line[j];
  if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\v' || c === '\f') return false;
  return line.charCodeAt(j) < 128 || !/\s/.test(c);
}

// ---------------------------------------------------------------- Templates

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.v, path[0])) s = s.p;
  if (s === null) return undefined;
  let v = s.v[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * A template's free first-segment names (names it reads that no enclosing
 * for binds), with includes followed in the same scope. `bound` holds the
 * names the enclosing fors bind at the point of reading.
 */
function freeVars(nodes, bound, trees, visiting, bad) {
  const free = new Set();
  for (const n of nodes) {
    if (n.kind === 'var' || n.kind === 'raw') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
    } else if (n.kind === 'if') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      for (const x of freeVars(n.then, bound, trees, visiting, bad)) free.add(x);
      if (n.else !== null) for (const x of freeVars(n.else, bound, trees, visiting, bad)) free.add(x);
    } else if (n.kind === 'for') {
      if (!bound.has(n.path[0])) free.add(n.path[0]);
      const inner = new Set(bound);
      inner.add(n.name);
      inner.add('loop');
      for (const x of freeVars(n.body, inner, trees, visiting, bad)) free.add(x);
    } else if (n.kind === 'include') {
      const sub = freeEmpty(n.name, trees, visiting, bad);
      for (const x of sub) if (!bound.has(x)) free.add(x);
    }
  }
  return free;
}

/** A template's free names with nothing bound (cycle-safe). */
function freeEmpty(name, trees, visiting, bad) {
  const nodes = trees.get(name);
  if (nodes === undefined) return new Set();
  if (visiting.has(name)) {
    bad.add(name);
    return new Set();
  }
  visiting.add(name);
  const free = freeVars(nodes, new Set(), trees, visiting, bad);
  visiting.delete(name);
  return free;
}

/** Compile one template's nodes to a function (S, C, O, D). */
function compileTemplate(nodes) {
  let tmp = 0;
  const gen = (ns, scope) => {
    let src = '';
    for (const n of ns) {
      if (n.kind === 'text') src += `O.push(${JSON.stringify(n.text)});`;
      else if (n.kind === 'var') src += `O.push(C.esc(C.txt(C.look(${scope},${JSON.stringify(n.path)}))));`;
      else if (n.kind === 'raw') src += `O.push(C.txt(C.look(${scope},${JSON.stringify(n.path)})));`;
      else if (n.kind === 'if') {
        src += `if(C.tru(C.look(${scope},${JSON.stringify(n.path)}))!==${n.not}){${gen(n.then, scope)}}`;
        if (n.else !== null) src += `else{${gen(n.else, scope)}}`;
      } else if (n.kind === 'for') {
        const k = tmp++;
        const a = `_a${k}`;
        const s = `_s${k}`;
        const o = `_o${k}`;
        const it = `_k${k}`;
        src += `{var ${a}=C.look(${scope},${JSON.stringify(n.path)});if(Array.isArray(${a})){var ${s}={v:{},p:${scope}};var ${o}={index:1,first:true,last:false,length:${a}.length};${s}.v.loop=${o};for(var ${it}=0;${it}<${a}.length;${it}++){${s}.v[${JSON.stringify(n.name)}]=${a}[${it}];${o}.index=${it}+1;${o}.first=${it}===0;${o}.last=${it}===${a}.length-1;${gen(n.body, s)}}}}`;
      } else if (n.kind === 'include') {
        src += `C.inc(${scope},C,O,D,${JSON.stringify(n.name)});`;
      }
    }
    return src;
  };
  return new Function('S', 'C', 'O', 'D', gen(nodes, 'S'));
}

/** Render template `name` in `vars`; null when the template is missing. */
function renderTemplate(C, name, vars) {
  const fn = C.tpl.get(name);
  if (fn === undefined) return null;
  const out = [];
  fn({ v: vars, p: null }, C, out, 0);
  return out.join('');
}

// ---------------------------------------------------------------- includes

/**
 * One {% include %} step. Templates whose output cannot depend on the
 * calling scope (only site, tags and recent, constant for the whole build)
 * render once per depth and are reused; templates that read one further
 * name render once per value of that name (a card once per post, a
 * tag-list once per post). Anything else renders every time.
 */
function includeRender(S, C, O, D, name) {
  if (D >= 8) return;
  const fn = C.tpl.get(name);
  if (fn === undefined) return;
  const meta = C.meta.get(name);
  if (meta.kind === 1) {
    const key = `${name}|${D}`;
    let s = C.memo.get(key);
    if (s === undefined) {
      const o = [];
      fn(S, C, o, D + 1);
      s = o.join('');
      C.memo.set(key, s);
    }
    O.push(s);
    return;
  }
  if (meta.kind === 2) {
    const v = lookup(S, [meta.var]);
    const key = `${name}|${D}`;
    let cache = C.memo2.get(key);
    if (cache === undefined) {
      cache = { obj: new WeakMap(), prim: new Map() };
      C.memo2.set(key, cache);
    }
    let s;
    if ((v !== null && typeof v === 'object') || typeof v === 'function') {
      s = cache.obj.get(v);
      if (s === undefined) {
        const o = [];
        fn(S, C, o, D + 1);
        s = o.join('');
        cache.obj.set(v, s);
      }
    } else {
      const pk = `${typeof v}:${String(v)}`;
      s = cache.prim.get(pk);
      if (s === undefined) {
        const o = [];
        fn(S, C, o, D + 1);
        s = o.join('');
        cache.prim.set(pk, s);
      }
    }
    O.push(s);
    return;
  }
  fn(S, C, O, D + 1);
}

// ---------------------------------------------------------------- the build

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

function resolveLinkUncached(bySource, staticPaths, base, dir, target) {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
  const hash = target.indexOf('#');
  const rel = hash === -1 ? target : target.slice(0, hash);
  const frag = hash === -1 ? '' : target.slice(hash);
  const path = rel === '' ? null : resolvePath(dir, rel);
  if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
  if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
  return null;
}

/** One site's output tree: path -> text. */
function build(input) {
  const B = { slugCache: new Map(), dateCache: new Map(), linkCache: new Map(), broken: new Set(), report: [] };

  // Templates: parsed and compiled once per build; a template that does
  // not parse is reported and left out, as if it were not there.
  const trees = new Map();
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      trees.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      B.report.push(err.message);
    }
  }
  const C = {
    tpl: new Map(),
    meta: new Map(),
    esc: escapeHtml,
    look: lookup,
    txt: textOf,
    tru: truthy,
    memo: new Map(),
    memo2: new Map(),
    inc: includeRender,
  };
  const bad = new Set();
  for (const [name, nodes] of trees) {
    C.tpl.set(name, compileTemplate(nodes));
    const free = freeEmpty(name, trees, new Set(), bad);
    let kind = 0;
    let varName = null;
    if (!free.has('loop') && !bad.has(name)) {
      const extra = [];
      for (const x of free) if (x !== 'site' && x !== 'tags' && x !== 'recent') extra.push(x);
      if (extra.length === 0) kind = 1;
      else if (extra.length === 1) {
        kind = 2;
        varName = extra[0];
      }
    }
    C.meta.set(name, { kind, var: varName });
  }
  if (bad.size > 0) for (const m of C.meta.values()) m.kind = 0;

  const base = input.site.base_url.replace(/\/+$/, '');

  // Sources, in code-unit order of their paths, line ends made "\n".
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter: a refused source is reported and dropped, and so is a draft.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      B.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
    if (own !== undefined) {
      B.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      B.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!C.tpl.has(layout)) {
      B.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      B.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's slug made unique in its directory, in source order.
  const bySource = new Map();
  const taken = new Map();
  const takenIn = (dir) => {
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    return set;
  };
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(B, s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown, each body's links resolved to the pages and static files they name.
  const staticPaths = new Set(statics.map((f) => f.path));
  for (const s of kept) {
    const dir = dirOf(s.path);
    const link = (target) => {
      const key = `${dir}\n${target}`;
      let hit = B.linkCache.get(key);
      if (hit === undefined) {
        hit = resolveLinkUncached(bySource, staticPaths, base, dir, target);
        B.linkCache.set(key, hit);
      }
      if (hit === null) B.broken.add(`broken-link ${s.path} -> ${target}`);
      return hit === null ? target : hit;
    };
    const md = renderMarkdown(B, s.body, link);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
    s.words = wordsOf(s.body);
  }

  // Collections: the posts, newest first and then by slug; newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(B, name);
      if (seen.has(slug)) continue;
      seen.add(slug);
      out.push(name);
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(B, name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(B, name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // One view per source serves as its card and as its page.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(B, s.data.date) });
  for (const s of kept) {
    s.view = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(B, s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(s.words / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
      slug: s.slug,
      content: s.html,
      toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
      newer: s.post ? linkOf(s.newer ?? null) : null,
      older: s.post ? linkOf(s.older ?? null) : null,
      is_post: s.post,
    };
  }

  // Layouts: every page through its layout, the index pages and the tag pages through theirs.
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => p.view);
  const output = {};
  const pageVars = { site, tags: allTags, recent, page: null };
  for (const s of kept) {
    pageVars.page = s.view;
    output[`${s.outDir}/index.html`] = renderTemplate(C, s.layout, pageVars);
  }
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = renderTemplate(C, 'index', {
      site,
      tags: allTags,
      recent,
      posts: posts.slice((k - 1) * per, k * per).map((p) => p.view),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = renderTemplate(C, 'tag', {
      site,
      tags: allTags,
      recent,
      tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => p.view) },
    });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = renderTemplate(C, 'tags', { site, tags: allTags, recent });
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) B.report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  const lines = [...B.report, ...B.broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  return build(input);
}
