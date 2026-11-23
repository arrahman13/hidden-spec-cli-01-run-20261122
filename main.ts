// mend: one patch tool for every AI edit format, written to SPEC.md (the contract beside this file).
//
//   node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// It reads a patch in one of four formats (unified diff, SEARCH/REPLACE blocks, V4A, JSON edits),
// finds the lines each edit names at the first of three matching tiers, and writes every change or
// none, printing what it changed or why it failed. Node 22, the standard library alone.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands
// over to runner.ts (the last lines below): keep that hand-over and runner.ts as they are.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

/** An exit-2 outcome: usage, no-patch, format or parse, with the one line to print. */
class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}

/** One edit's failure: a code (no-match, ambiguous, missing, exists, unsafe) and the path it concerns. */
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

/** A patch's lines (SPEC.md section 3): split at \n, one trailing \r removed, no empty piece after a final \n. */
function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** A safe path (section 3): relative, no backslash, no empty, `.` or `..` segment. */
function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** A file as lines: its own line break, its lines, and whether it ends with a break. */
interface FileModel {
  lines: string[];
  br: string;
  final: boolean;
}

function splitText(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const lines = text.split(br);
  let final = false;
  if (text.endsWith(br)) {
    lines.pop();
    final = true;
  }
  return { lines, br, final };
}

function joinText(m: FileModel): string {
  return m.lines.length === 0 ? '' : m.lines.join(m.br) + (m.final ? m.br : '');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: [string, string][] = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// Matching lines (section 5). Tier 0 is exact; tier 1 also forgives trailing spaces and tabs;
// tier 2 forgives leading ones too. An occurrence is a start position whose lines all match.

const trimTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const trimBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => /^[ \t]*/.exec(s)![0];

function segMatches(lines: string[], at: number, old: string[], tier: number): boolean {
  for (let k = 0; k < old.length; k += 1) {
    const a = lines[at + k]!;
    const b = old[k]!;
    const eq = tier === 0 ? a === b : tier === 1 ? trimTrail(a) === trimTrail(b) : trimBoth(a) === trimBoth(b);
    if (!eq) return false;
  }
  return true;
}

/** The first tier at which `old` occurs at or after `from`, with every position there, or null. */
function findTier(lines: string[], old: string[], strict: boolean, from = 0, keep: (pos: number) => boolean = () => true): { tier: number; positions: number[] } | null {
  for (const tier of strict ? [0] : [0, 1, 2]) {
    const positions: number[] = [];
    for (let i = from; i + old.length <= lines.length; i += 1) {
      if (keep(i) && segMatches(lines, i, old, tier)) positions.push(i);
    }
    if (positions.length > 0) return { tier, positions };
  }
  return null;
}

/** One line of a replacement: a context line (kept from the file), an old line, or a new line. */
interface Ent {
  t: 'ctx' | 'old' | 'new';
  text: string;
}

/**
 * The lines a replacement writes over the match at `at`: context lines come from the file itself,
 * and at tier 2 the new lines are re-indented from the patch's first old line onto the file's first
 * matched line (section 5).
 */
function replacement(lines: string[], at: number, old: string[], entries: Ent[], tier: number): string[] {
  const out: string[] = [];
  const f = tier === 2 ? leadWs(lines[at]!) : '';
  const p = tier === 2 ? leadWs(old[0]!) : '';
  let oi = 0;
  for (const e of entries) {
    if ((e as { t: string }).t === 'bs') continue;
    if (e.t === 'ctx') {
      out.push(lines[at + oi]!);
      oi += 1;
    } else if (e.t === 'old') {
      oi += 1;
    } else {
      let s = e.text;
      if (tier === 2 && s.trim() !== '' && s.startsWith(p)) s = f + s.slice(p.length);
      out.push(s);
    }
  }
  return out;
}

// Unified diffs (section 6).

interface Hunk {
  a: number;
  entries: (Ent | { t: 'bs' })[];
  noeol: boolean;
}

interface Section {
  gitOld: string | null;
  gitNew: string | null;
  minus: string | null;
  plus: string | null;
  hasPair: boolean;
  renameFrom: string | null;
  renameTo: string | null;
  newFile: boolean;
  delFile: boolean;
  sawHunk: boolean;
  hunks: Hunk[];
}

const newSection = (): Section => ({
  gitOld: null, gitNew: null, minus: null, plus: null, hasPair: false,
  renameFrom: null, renameTo: null, newFile: false, delFile: false, sawHunk: false, hunks: [],
});

/** The path a `---` or `+++` line names: after the four characters, up to a tab, spaces removed, a/ or b/ stripped. */
function headerPath(line: string): string {
  const raw = line.slice(4).split('\t')[0]!.trim();
  return raw.startsWith('a/') || raw.startsWith('b/') ? raw.slice(2) : raw;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: Section[] = [];
  let cur: Section | null = null;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const rest = line.slice('diff --git '.length);
      const sep = rest.startsWith('a/') ? rest.indexOf(' b/', 2) : -1;
      if (sep < 0 || rest.slice(sep + 3) === '') throw new Exit2(`error: parse ${i + 1}`);
      cur = newSection();
      cur.gitOld = rest.slice(2, sep);
      cur.gitNew = rest.slice(sep + 3);
      sections.push(cur);
      i += 1;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur !== null && !cur.sawHunk && !cur.hasPair) {
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
        cur.hasPair = true;
      } else {
        cur = newSection();
        cur.minus = headerPath(line);
        cur.plus = headerPath(lines[i + 1]!);
        cur.hasPair = true;
        sections.push(cur);
      }
      i += 2;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      const entries: (Ent | { t: 'bs' })[] = [];
      let j = i + 1;
      while (j < lines.length) {
        const b = lines[j]!;
        if (b.startsWith('diff --git ')) break;
        if (b.startsWith('--- ') && (lines[j + 1] ?? '').startsWith('+++ ')) break;
        if (b === '') entries.push({ t: 'ctx', text: '' });
        else if (b[0] === ' ') entries.push({ t: 'ctx', text: b.slice(1) });
        else if (b[0] === '-') entries.push({ t: 'old', text: b.slice(1) });
        else if (b[0] === '+') entries.push({ t: 'new', text: b.slice(1) });
        else if (b[0] === '\\') entries.push({ t: 'bs' });
        else break;
        j += 1;
      }
      // Empty lines at the end of a body are not part of it.
      while (entries.length > 0) {
        const last = entries[entries.length - 1]!;
        if (last.t === 'ctx' && last.text === '') entries.pop();
        else break;
      }
      let lastWritten = -1;
      entries.forEach((e, ix) => {
        if (e.t === 'ctx' || e.t === 'new') lastWritten = ix;
      });
      const noeol = lastWritten >= 0 && entries[lastWritten + 1]?.t === 'bs';
      cur.hunks.push({ a: Number(m[1]), entries, noeol });
      cur.sawHunk = true;
      i = j;
      continue;
    }
    if (cur !== null && !cur.sawHunk) {
      // The section's header, before its first hunk.
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) cur.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.delFile = true;
      i += 1;
      continue;
    }
    i += 1; // Outside bodies, lines that are not part of a section header are ignored.
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  return sections.map((s) => sectionEdit(s, strict));
}

/** Apply a section's hunks in order to a file model; `d` tracks the sections' length change so far. */
function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const old = h.entries.filter((e) => e.t === 'ctx' || e.t === 'old').map((e) => (e as Ent).text);
    const newCount = h.entries.filter((e) => e.t !== 'old' && e.t !== 'bs').length;
    if (old.length === 0) {
      const at = Math.min(Math.max(h.a + d, 0), model.lines.length);
      const add = h.entries.filter((e) => e.t === 'new').map((e) => (e as Ent).text);
      const atEnd = at === model.lines.length;
      model.lines.splice(at, 0, ...add);
      if (atEnd) model.final = !h.noeol;
      d += add.length;
      continue;
    }
    const found = findTier(model.lines, old, strict);
    if (found === null) throw new Fail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    for (const pos of found.positions) {
      if (Math.abs(pos - target) < Math.abs(best - target)) best = pos;
    }
    const rep = replacement(model.lines, best, old, h.entries as Ent[], found.tier);
    const atEnd = best + old.length === model.lines.length;
    model.lines.splice(best, old.length, ...rep);
    if (atEnd) model.final = !h.noeol;
    d += newCount - old.length;
  }
}

function sectionEdit(sec: Section, strict: boolean): Edit {
  return (tree) => {
    let oldP: string | null;
    let newP: string | null;
    if (sec.hasPair) {
      oldP = sec.minus;
      newP = sec.plus;
    } else if (sec.renameFrom !== null || sec.renameTo !== null) {
      oldP = sec.renameFrom ?? sec.gitOld;
      newP = sec.renameTo ?? sec.gitNew;
    } else {
      oldP = sec.gitOld;
      newP = sec.gitNew;
    }
    if (oldP === '/dev/null' || sec.newFile) {
      // A creation: the file is the + lines of all its hunks, in order.
      const p = newP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const ls: string[] = [];
      for (const h of sec.hunks) for (const e of h.entries) if (e.t === 'new') ls.push((e as Ent).text);
      let fin = true;
      outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi -= 1) {
        const es = sec.hunks[hi]!.entries;
        for (let ei = es.length - 1; ei >= 0; ei -= 1) {
          if (es[ei]!.t === 'new') {
            fin = es[ei + 1]?.t !== 'bs';
            break outer;
          }
        }
      }
      tree.now.set(p, joinText({ lines: ls, br: '\n', final: fin }));
      return;
    }
    if (newP === '/dev/null' || sec.delFile) {
      const p = oldP!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (oldP !== newP) {
      // A move: the hunks apply to the old file, the result is written at the new path.
      const o = oldP!;
      const n = newP!;
      if (!safe(o)) throw new Fail('unsafe', o);
      if (!safe(n)) throw new Fail('unsafe', n);
      const text = tree.get(o);
      if (text === null) throw new Fail('missing', o);
      if (tree.get(n) !== null) throw new Fail('exists', n);
      const model = splitText(text);
      applyHunks(model, sec.hunks, strict, o);
      tree.now.set(n, joinText(model));
      tree.now.set(o, null);
      tree.moves.push([o, n]);
      return;
    }
    const p = oldP!;
    if (!safe(p)) throw new Fail('unsafe', p);
    const text = tree.get(p);
    if (text === null) throw new Fail('missing', p);
    const model = splitText(text);
    applyHunks(model, sec.hunks, strict, p);
    tree.now.set(p, joinText(model));
  };
}

// SEARCH/REPLACE blocks (section 7).

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  interface Block {
    path: string;
    oldLines: string[];
    newLines: string[];
  }
  const blocks: Block[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i += 1;
      continue;
    }
    const at = i;
    let path: string | null = null;
    for (let j = at - 1; j > prevEnd; j -= 1) {
      const l = lines[j]!;
      if (blank(l) || l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new Exit2(`error: parse ${at + 1}`);
    }
    let eq = -1;
    for (let j = at + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${at + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j += 1) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${at + 1}`);
    blocks.push({ path, oldLines: lines.slice(at + 1, eq), newLines: lines.slice(eq + 1, rep) });
    prevEnd = rep;
    prevPath = path;
    i = rep + 1;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    if (!safe(b.path)) throw new Fail('unsafe', b.path);
    if (b.oldLines.length === 0) {
      if (tree.get(b.path) !== null) throw new Fail('exists', b.path);
      tree.now.set(b.path, joinText({ lines: b.newLines, br: '\n', final: true }));
      return;
    }
    const text = tree.get(b.path);
    if (text === null) throw new Fail('missing', b.path);
    const model = splitText(text);
    const found = findTier(model.lines, b.oldLines, strict);
    if (found === null) throw new Fail('no-match', b.path);
    if (found.positions.length > 1) throw new Fail('ambiguous', b.path);
    const entries: Ent[] = [
      ...b.oldLines.map((t) => ({ t: 'old' as const, text: t })),
      ...b.newLines.map((t) => ({ t: 'new' as const, text: t })),
    ];
    const rep = replacement(model.lines, found.positions[0]!, b.oldLines, entries, found.tier);
    model.lines.splice(found.positions[0]!, b.oldLines.length, ...rep);
    tree.now.set(b.path, joinText(model));
  });
}

// V4A patches (section 8).

interface Chunk {
  anchor: string | null;
  eof: boolean;
  entries: Ent[];
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last > first && blank(lines[last]!)) last -= 1;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  const edits: Edit[] = [];
  const starts = (l: string): 'add' | 'del' | 'upd' | null =>
    l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'del' : l.startsWith('*** Update File: ') ? 'upd' : null;

  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i += 1;
      continue;
    }
    const kind = starts(line);
    if (kind === null) throw new Exit2(`error: parse ${i + 1}`);
    const headNo = i + 1;
    const path = line.slice(line.indexOf(': ') + 2).trim();
    // The section's lines run to the next section or to *** End Patch; blank lines at its end are not part of it.
    const body: { text: string; no: number }[] = [];
    let j = i + 1;
    while (j < last && starts(lines[j]!) === null) {
      body.push({ text: lines[j]!, no: j + 1 });
      j += 1;
    }
    while (body.length > 0 && blank(body[body.length - 1]!.text)) body.pop();
    i = j;

    if (kind === 'add') {
      const content: string[] = [];
      for (const b of body) {
        if (b.text.startsWith('+')) content.push(b.text.slice(1));
        else if (b.text === '') content.push('');
        else throw new Exit2(`error: parse ${b.no}`);
      }
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) !== null) throw new Fail('exists', path);
        tree.now.set(path, joinText({ lines: content, br: '\n', final: true }));
      });
    } else if (kind === 'del') {
      if (body.length > 0) throw new Exit2(`error: parse ${body[0]!.no}`);
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (tree.get(path) === null) throw new Fail('missing', path);
        tree.now.set(path, null);
      });
    } else {
      let moveTo: string | null = null;
      let rest = body;
      if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
        moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
        rest = rest.slice(1);
      }
      const chunks: Chunk[] = [];
      let chunk: Chunk | null = null;
      for (const b of rest) {
        if (b.text.startsWith('@@')) {
          chunk = { anchor: b.text.slice(2).trim() || null, eof: false, entries: [] };
          chunks.push(chunk);
        } else if (b.text === '*** End of File') {
          if (chunk === null) {
            chunk = { anchor: null, eof: true, entries: [] };
            chunks.push(chunk);
          }
          chunk.eof = true;
        } else if (b.text === '' || b.text[0] === ' ' || b.text[0] === '-' || b.text[0] === '+') {
          if (chunk === null) {
            chunk = { anchor: null, eof: false, entries: [] };
            chunks.push(chunk);
          }
          chunk.entries.push({ t: b.text === '' || b.text[0] === ' ' ? 'ctx' : b.text[0] === '-' ? 'old' : 'new', text: b.text === '' ? '' : b.text.slice(1) });
        } else {
          throw new Exit2(`error: parse ${b.no}`);
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headNo}`);
      const to = moveTo;
      edits.push((tree) => {
        if (!safe(path)) throw new Fail('unsafe', path);
        if (to !== null && !safe(to)) throw new Fail('unsafe', to);
        const text = tree.get(path);
        if (text === null) throw new Fail('missing', path);
        if (to !== null && tree.get(to) !== null) throw new Fail('exists', to);
        const model = splitText(text);
        let cursor = 0;
        for (const ch of chunks) {
          if (ch.anchor !== null) {
            const a = findTier(model.lines, [ch.anchor], strict, cursor);
            if (a === null) throw new Fail('no-match', path);
            cursor = a.positions[0]! + 1;
          }
          const old = ch.entries.filter((e) => e.t !== 'new').map((e) => e.text);
          if (old.length === 0) {
            const at = ch.eof ? model.lines.length : Math.min(cursor, model.lines.length);
            const add = ch.entries.filter((e) => e.t === 'new').map((e) => e.text);
            model.lines.splice(at, 0, ...add);
            cursor = at + add.length;
            continue;
          }
          const found = findTier(model.lines, old, strict, cursor, (pos) => !ch.eof || pos + old.length === model.lines.length);
          if (found === null) throw new Fail('no-match', path);
          const rep = replacement(model.lines, found.positions[0]!, old, ch.entries, found.tier);
          model.lines.splice(found.positions[0]!, old.length, ...rep);
          cursor = found.positions[0]! + rep.length;
        }
        if (to !== null) {
          tree.now.set(to, joinText(model));
          tree.now.set(path, null);
          tree.moves.push([path, to]);
        } else {
          tree.now.set(path, joinText(model));
        }
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return edits;
}

// JSON edits (section 9).

/** One JSON edit object, as an Edit, or null when it is not a valid edit object. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const existing = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text); // A create writes its file_text byte for byte.
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = existing(tree);
      const model = splitText(before);
      const crlf = model.br === '\r\n';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const model = splitText(existing(tree));
      if (line < 0 || line > model.lines.length) throw new Fail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, joinText(model));
    };
  }
  return null;
}

function parseJson(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    // Array form: any fault is a parse error at the line where the array starts.
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  // JSON Lines: one edit object a line, blank lines ignored.
  lines.forEach((l, ix) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${ix + 1}`);
    edits.push(e);
  });
  return edits;
}

// Detecting the format (section 4).

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, ix) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[ix + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// The command line (section 1), the run (sections 2 and 10).

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice('--format='.length))) format = a.slice('--format='.length);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json' ? parseJson(text, lines)
      : kind === 'unified' ? parseUnified(lines, strict)
      : kind === 'search-replace' ? parseSearchReplace(lines, strict)
      : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  // Edits apply in the patch's order; a failed edit changes nothing and stops nothing (section 10).
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const moveCount = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = moveCount;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  // What changed, in byte order of the paths; a move that took a file from a path that is gone to
  // one that is new is one R line, sorted by its new path (section 2).
  const rows: { key: string; text: string }[] = [];
  const movedTo = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null && !movedTo.has(n)) {
      movedTo.set(n, o);
    }
  }
  const movedFrom = new Set(movedTo.values());
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (movedTo.has(p)) {
      rows.push({ key: p, text: `R ${movedTo.get(p)!} -> ${p}` });
      continue;
    }
    if (movedFrom.has(p) && was !== null && now === null) continue;
    if (was === now) continue;
    rows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const p of tree.now.keys()) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.text), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
