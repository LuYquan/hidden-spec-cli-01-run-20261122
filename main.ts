// mend: one patch tool for every AI edit format.
//
// Applies unified diffs (often with wrong line numbers), SEARCH/REPLACE
// blocks, V4A patches and JSON text-editor tool calls to a tree of text
// files. Every file is changed or nothing is. Node 22, standard library
// only. Run as: node main.ts [--format=NAME] [--check] [--strict] [PATCH]
//
// When MAKEFUN_ENV_URL is set, the trial is handed over to runner.ts
// instead: it runs main.ts on every check of the env and posts the results.

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { runTrial } from './runner.ts';

/* ---------------- errors ---------------- */

class ParseError extends Error {
  line: number;
  constructor(line: number) {
    super(`parse ${line}`);
    this.line = line;
  }
}

/* ---------------- small helpers ---------------- */

function isBlank(s: string): boolean {
  return s.trim() === '';
}

/** Trailing spaces and tabs removed. */
function stripTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}

function leadingWs(s: string): string {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
}

/**
 * A patch's lines: its text split at \n, each with one trailing \r
 * removed, without the empty piece after a final \n. An empty patch
 * has no lines; a patch of one \n has one empty line.
 */
function splitPatch(text: string): string[] {
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/** Lines of a string value: an empty string has none. */
function splitValueLines(s: string): string[] {
  if (s === '') return [];
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

/* ---------------- files ---------------- */

type Br = '\n' | '\r\n';

interface WorkFile {
  lines: string[];
  br: Br;
  ends: boolean;
}

/**
 * A file's model: the line break is CRLF iff the first `\n` follows
 * a `\r`, and `ends` says whether the text ends with that break.
 * An empty file has no lines and no final break.
 */
function parseFileText(text: string): WorkFile {
  const idx = text.indexOf('\n');
  const br: Br = idx > 0 && text[idx - 1] === '\r' ? '\r\n' : '\n';
  if (text === '') return { lines: [], br, ends: false };
  const parts = text.split(br);
  let ends = false;
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop();
    ends = true;
  }
  return { lines: parts, br, ends };
}

function renderFileText(f: WorkFile): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.ends ? f.br : '');
}

function isSafePath(p: string): boolean {
  if (p === '') return false;
  if (p.startsWith('/')) return false;
  if (p.includes('\\')) return false;
  const segs = p.split('/');
  for (const s of segs) {
    if (s === '' || s === '.' || s === '..') return false;
  }
  return true;
}

/** The working tree: in-memory overlay over the files on disk. */
/**
 * The tree as an in-memory overlay: `orig` is each file's content
 * before the patch (null when it did not exist), `cur` is its content
 * after the edits applied so far. Files are read lazily on first use
 * and nothing is written to disk until every edit has succeeded.
 */
class Tree {
  private orig = new Map<string, string | null>();
  private cur = new Map<string, string | null>();

  get(path: string): string | null {
    if (this.cur.has(path)) return this.cur.get(path) as string | null;
    let v: string | null = null;
    try {
      v = readFileSync(path, 'utf8');
    } catch {
      v = null;
    }
    this.orig.set(path, v);
    this.cur.set(path, v);
    return v;
  }

  exists(path: string): boolean {
    return this.get(path) !== null;
  }

  original(path: string): string | null {
    if (this.orig.has(path)) return this.orig.get(path) as string | null;
    return this.get(path);
  }

  set(path: string, text: string): void {
    if (!this.orig.has(path)) this.get(path);
    this.cur.set(path, text);
  }

  del(path: string): void {
    if (!this.orig.has(path)) this.get(path);
    this.cur.set(path, null);
  }

  touched(): string[] {
    return [...this.cur.keys()];
  }
}

/* ---------------- line matching (SPEC section 5) ---------------- */

/** The key a line is compared by at a tier. */
function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(/[ \t]+$/, '');
  return line.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
}

/** 0-based positions where O occurs in lines at a tier. */
function occurrences(lines: string[], o: string[], tier: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  const ok = o.map((l) => tierKey(l, tier));
  for (let i = 0; i + o.length <= lines.length; i++) {
    let good = true;
    for (let j = 0; j < o.length; j++) {
      if (tierKey(lines[i + j], tier) !== ok[j]) {
        good = false;
        break;
      }
    }
    if (good) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) where O occurs. */
function findFirstTier(
  lines: string[],
  o: string[],
  strict: boolean,
): { tier: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occurrences(lines, o, t);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The occurrence nearest to target, ties broken by the earlier one. */
function nearestOccurrence(occ: number[], target: number): number {
  let best = occ[0];
  for (const p of occ) if (Math.abs(p - target) < Math.abs(best - target)) best = p;
  return best;
}

interface NEntry {
  text: string;
  /** A context line: written as the file's own matched line. */
  ctx: boolean;
  /** For a context line, its index in O. */
  oIdx: number;
}

/**
 * The lines N is written as at a match. Context lines come from the file;
 * at tier 2 every other line is re-indented from O's first line's leading
 * whitespace to the file's first matched line's.
 */
function buildReplacement(
  n: NEntry[],
  o: string[],
  fileLines: string[],
  pos: number,
  tier: number,
): string[] {
  if (tier !== 2) {
    return n.map((e) => (e.ctx ? fileLines[pos + e.oIdx] : e.text));
  }
  const f = leadingWs(fileLines[pos] ?? '');
  // O is never empty here: every caller takes the empty-O path first.
  const p = leadingWs(o[0]);
  return n.map((e) => {
    if (e.ctx) return fileLines[pos + e.oIdx];
    const t = e.text;
    if (t === '' || /^[ \t]+$/.test(t)) return t;
    if (t.startsWith(p)) return f + t.slice(p.length);
    return t;
  });
}

/** Split a hunk/chunk body into its old lines O and its new lines N. */
function splitBody(
  body: Array<{ kind: string; text: string }>,
): { oLines: string[]; nEntries: NEntry[] } {
  const oLines: string[] = [];
  const nEntries: NEntry[] = [];
  for (const bl of body) {
    if (bl.kind === ' ') {
      oLines.push(bl.text);
      nEntries.push({ text: bl.text, ctx: true, oIdx: oLines.length - 1 });
    } else if (bl.kind === '-') {
      oLines.push(bl.text);
    } else if (bl.kind === '+') {
      nEntries.push({ text: bl.text, ctx: false, oIdx: -1 });
    }
  }
  return { oLines, nEntries };
}

/* ---------------- edits ---------------- */

interface Mutation {
  path: string;
  text: string | null;
}

interface EditOutcome {
  ok: boolean;
  code?: string;
  path?: string;
  mutations?: Mutation[];
  move?: { old: string; nw: string } | null;
}

function failOutcome(code: string, path: string): EditOutcome {
  return { ok: false, code, path };
}

function okOutcome(
  mutations: Mutation[],
  move: { old: string; nw: string } | null = null,
): EditOutcome {
  return { ok: true, mutations, move };
}

/* ---------------- unified diffs (SPEC section 6) ---------------- */

type BodyKind = ' ' | '-' | '+' | '\\';

interface BodyLine {
  kind: BodyKind;
  text: string;
  /** The patch line as written (kept to tell a truly empty line apart). */
  raw: string;
}

interface Hunk {
  a: number;
  body: BodyLine[];
  oLines: string[];
  nEntries: NEntry[];
}

interface UnifiedSection {
  oldPath: string;
  newPath: string;
  newFileMode: boolean;
  deletedFileMode: boolean;
  hunks: Hunk[];
}

/** The path of a --- / +++ line: after the four characters, up to the first tab, trimmed, a/ or b/ removed. */
function diffPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;

function parseUnified(lines: string[]): UnifiedSection[] {
  const sections: UnifiedSection[] = [];
  let pairOld: string | null = null;
  let pairNew: string | null = null;
  let renameFrom: string | null = null;
  let renameTo: string | null = null;
  let diffX: string | null = null;
  let diffY: string | null = null;
  let newFileMode = false;
  let deletedFileMode = false;
  let hunks: Hunk[] = [];
  let inSection = false;
  let inHeader = false;
  let curHunk: Hunk | null = null;

  const finishHunkBody = (): void => {
    if (curHunk !== null) {
      const body = curHunk.body;
      // Trailing truly-empty lines ('' only, not whitespace-only)
      // are not part of a hunk body.
      while (body.length > 0 && body[body.length - 1].raw === '') body.pop();
      const split = splitBody(body);
      curHunk.oLines = split.oLines;
      curHunk.nEntries = split.nEntries;
      hunks.push(curHunk);
      curHunk = null;
    }
  };

  const finishSection = (): void => {
    if (!inSection) return;
    finishHunkBody();
    // Path precedence: the --- / +++ pair beats rename from/to,
    // which beats the diff --git line.
    const oldPath = pairOld ?? renameFrom ?? diffX ?? '';
    const newPath = pairNew ?? renameTo ?? diffY ?? '';
    sections.push({ oldPath, newPath, newFileMode, deletedFileMode, hunks });
    pairOld = null;
    pairNew = null;
    renameFrom = null;
    renameTo = null;
    diffX = null;
    diffY = null;
    newFileMode = false;
    deletedFileMode = false;
    hunks = [];
    inSection = false;
    inHeader = false;
  };

  const startSectionFromDiff = (x: string, y: string): void => {
    finishSection();
    inSection = true;
    inHeader = true;
    diffX = x;
    diffY = y;
  };

  const startSectionFromPair = (o: string, n: string): void => {
    finishSection();
    inSection = true;
    inHeader = true;
    pairOld = o;
    pairNew = n;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(stripTrail(line));
      if (m === null) throw new ParseError(i + 1);
      startSectionFromDiff(m[1], m[2]);
      continue;
    }
    if (
      line.startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      const o = diffPath(line);
      const n = diffPath(lines[i + 1]);
      if (!inSection) {
        startSectionFromPair(o, n);
      } else if (inHeader) {
        pairOld = o;
        pairNew = n;
      } else {
        startSectionFromPair(o, n);
      }
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (!inSection) throw new ParseError(i + 1);
      const m = HUNK_RE.exec(line);
      if (m === null) throw new ParseError(i + 1);
      finishHunkBody();
      curHunk = { a: Number(m[1]), body: [], oLines: [], nEntries: [] };
      inHeader = false;
      continue;
    }
    if (!inSection) continue;
    if (inHeader) {
      if (line.startsWith('--- ')) throw new ParseError(i + 2);
      if (line.startsWith('rename from ')) renameFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) renameTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) newFileMode = true;
      else if (line.startsWith('deleted file mode')) deletedFileMode = true;
      continue;
    }
    if (curHunk !== null) {
      if (
        line === '' ||
        line.startsWith(' ') ||
        line.startsWith('-') ||
        line.startsWith('+') ||
        line.startsWith('\\')
      ) {
        const kind: BodyKind = line === '' ? ' ' : (line[0] as BodyKind);
        curHunk.body.push({
          kind,
          text: line === '' ? '' : line.slice(1),
          raw: line,
        });
        continue;
      }
      finishHunkBody();
      continue;
    }
    // Outside a body: lines that are not part of a section header are ignored.
  }
  finishSection();
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

/** Whether a \ line follows the hunk's last context or + line. */
/**
 * Whether a `\` line follows the hunk's last context or `+` line.
 * A `\` line after a `-` line, or after nothing, does not count.
 */
function backslashAfterLastContent(h: Hunk): boolean {
  for (let i = h.body.length - 1; i >= 0; i--) {
    const bl = h.body[i];
    if (bl.kind === ' ' || bl.kind === '+') {
      const next = h.body[i + 1];
      return next !== undefined && next.kind === '\\';
    }
  }
  return false;
}

/** Apply a section's hunks, in order, to a file's lines and final break. */
function applyHunks(
  work: WorkFile,
  hunks: Hunk[],
  strict: boolean,
): { ok: boolean; code?: string } {
  let d = 0;
  for (const h of hunks) {
    const o = h.oLines;
    const n = h.nEntries;
    if (o.length === 0) {
      const insertPos = Math.max(0, Math.min(h.a + d, work.lines.length));
      const atEnd = insertPos === work.lines.length;
      const inserted = n.map((e) => e.text);
      work.lines = [
        ...work.lines.slice(0, insertPos),
        ...inserted,
        ...work.lines.slice(insertPos),
      ];
      if (atEnd) work.ends = !backslashAfterLastContent(h);
      d += n.length;
      continue;
    }
    const found = findFirstTier(work.lines, o, strict);
    if (found === null) return { ok: false, code: 'no-match' };
    const target = h.a - 1 + d;
    const best = nearestOccurrence(found.occ, target);
    const rep = buildReplacement(n, o, work.lines, best, found.tier);
    const atEnd = best + o.length === work.lines.length;
    work.lines = [
      ...work.lines.slice(0, best),
      ...rep,
      ...work.lines.slice(best + o.length),
    ];
    if (atEnd) work.ends = !backslashAfterLastContent(h);
    d += n.length - o.length;
  }
  return { ok: true };
}

function applyUnifiedSection(
  sec: UnifiedSection,
  tree: Tree,
  strict: boolean,
): EditOutcome {
  const oldPath = sec.oldPath;
  const newPath = sec.newPath;
  const isCreate = oldPath === '/dev/null' || sec.newFileMode;
  const isDelete = !isCreate && (newPath === '/dev/null' || sec.deletedFileMode);
  const isMove = !isCreate && !isDelete && oldPath !== newPath;
  for (const p of [oldPath, newPath]) {
    if (p === '/dev/null') continue;
    if (!isSafePath(p)) return failOutcome('unsafe', p);
  }
  if (isCreate) {
    if (tree.exists(newPath)) return failOutcome('exists', newPath);
    let lastPlus: { hunk: Hunk; idx: number } | null = null;
    const plusLines: string[] = [];
    for (const h of sec.hunks) {
      for (let i = 0; i < h.body.length; i++) {
        if (h.body[i].kind === '+') {
          plusLines.push(h.body[i].text);
          lastPlus = { hunk: h, idx: i };
        }
      }
    }
    let ends = true;
    if (lastPlus !== null) {
      const next = lastPlus.hunk.body[lastPlus.idx + 1];
      if (next !== undefined && next.kind === '\\') ends = false;
    }
    const text =
      plusLines.length === 0 ? '' : plusLines.join('\n') + (ends ? '\n' : '');
    return okOutcome([{ path: newPath, text }]);
  }
  if (isDelete) {
    if (!tree.exists(oldPath)) return failOutcome('missing', oldPath);
    return okOutcome([{ path: oldPath, text: null }]);
  }
  if (!tree.exists(oldPath)) return failOutcome('missing', oldPath);
  if (isMove && tree.exists(newPath)) return failOutcome('exists', newPath);
  const work = parseFileText(tree.get(oldPath) as string);
  const applied = applyHunks(work, sec.hunks, strict);
  if (!applied.ok) return failOutcome(applied.code as string, oldPath);
  const text = renderFileText(work);
  if (isMove) {
    return okOutcome(
      [
        { path: oldPath, text: null },
        { path: newPath, text },
      ],
      { old: oldPath, nw: newPath },
    );
  }
  return okOutcome([{ path: oldPath, text }]);
}

/* ---------------- SEARCH/REPLACE blocks (SPEC section 7) ---------------- */

interface SrBlock {
  path: string;
  oldLines: string[];
  newLines: string[];
}

function parseSearchReplace(lines: string[]): SrBlock[] {
  const blocks: SrBlock[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (stripTrail(lines[i]) !== '<<<<<<< SEARCH') continue;
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      const t = stripTrail(lines[j]);
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '<<<<<<< SEARCH' || t === '>>>>>>> REPLACE') break;
    }
    if (eq === -1) throw new ParseError(i + 1);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      const t = stripTrail(lines[j]);
      if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
      if (t === '<<<<<<< SEARCH') break;
    }
    if (rep === -1) throw new ParseError(i + 1);
    let path: string | null = null;
    // The path is the nearest non-blank, non-fence line before
    // SEARCH, after the previous block's REPLACE; with none, the
    // previous block's path; with neither, a parse error at SEARCH.
    for (let j = i - 1; j > prevEnd; j--) {
      const l = lines[j];
      if (isBlank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new ParseError(i + 1);
      path = prevPath;
    }
    blocks.push({
      path,
      oldLines: lines.slice(i + 1, eq),
      newLines: lines.slice(eq + 1, rep),
    });
    prevEnd = rep;
    prevPath = path;
    i = rep;
  }
  if (blocks.length === 0) throw new ParseError(1);
  return blocks;
}

function applySearchReplaceBlock(
  b: SrBlock,
  tree: Tree,
  strict: boolean,
): EditOutcome {
  if (!isSafePath(b.path)) return failOutcome('unsafe', b.path);
  if (b.oldLines.length === 0) {
    if (tree.exists(b.path)) return failOutcome('exists', b.path);
    const text =
      b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n';
    return okOutcome([{ path: b.path, text }]);
  }
  if (!tree.exists(b.path)) return failOutcome('missing', b.path);
  const work = parseFileText(tree.get(b.path) as string);
  const found = findFirstTier(work.lines, b.oldLines, strict);
  if (found === null) return failOutcome('no-match', b.path);
  if (found.occ.length !== 1) return failOutcome('ambiguous', b.path);
  const pos = found.occ[0];
  const nEntries: NEntry[] = b.newLines.map((t) => ({
    text: t,
    ctx: false,
    oIdx: -1,
  }));
  const rep = buildReplacement(nEntries, b.oldLines, work.lines, pos, found.tier);
  work.lines = [
    ...work.lines.slice(0, pos),
    ...rep,
    ...work.lines.slice(pos + b.oldLines.length),
  ];
  return okOutcome([{ path: b.path, text: renderFileText(work) }]);
}

/* ---------------- V4A patches (SPEC section 8) ---------------- */

interface V4aChunk {
  anchor: string | null;
  eof: boolean;
  body: string[];
  oLines: string[];
  nEntries: NEntry[];
}

type V4aSection =
  | { kind: 'add'; path: string; lines: string[] }
  | { kind: 'delete'; path: string }
  | {
      kind: 'update';
      path: string;
      moveTo: string | null;
      chunks: V4aChunk[];
    };

function parseV4a(lines: string[]): V4aSection[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1 || lines[first].trim() !== '*** Begin Patch') {
    throw new ParseError(first === -1 ? 1 : first + 1);
  }
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!isBlank(lines[i])) {
      last = i;
      break;
    }
  }
  if (last === -1 || lines[last].trim() !== '*** End Patch') {
    throw new ParseError(lines.length + 1);
  }

  interface RawSection {
    kind: 'add' | 'delete' | 'update';
    path: string;
    startLine: number;
    raw: Array<{ text: string; num: number }>;
  }

  const rawSections: RawSection[] = [];
  let pending: RawSection | null = null;
  const flush = (): void => {
    if (pending !== null) {
      // Blank lines at the end of a section (before the next section
      // or *** End Patch) are not part of it; a blank line before a
      // later @@ inside the section stays in the chunk.
      while (
        pending.raw.length > 0 &&
        isBlank(pending.raw[pending.raw.length - 1].text)
      ) {
        pending.raw.pop();
      }
      rawSections.push(pending);
      pending = null;
    }
  };
  for (let i = first + 1; i < last; i++) {
    const line = lines[i];
    if (isBlank(line)) {
      if (pending !== null) pending.raw.push({ text: line, num: i + 1 });
      continue;
    }
    if (line.startsWith('*** Add File: ')) {
      flush();
      pending = {
        kind: 'add',
        path: line.slice('*** Add File: '.length).trim(),
        startLine: i + 1,
        raw: [],
      };
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      flush();
      pending = {
        kind: 'delete',
        path: line.slice('*** Delete File: '.length).trim(),
        startLine: i + 1,
        raw: [],
      };
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      flush();
      pending = {
        kind: 'update',
        path: line.slice('*** Update File: '.length).trim(),
        startLine: i + 1,
        raw: [],
      };
      continue;
    }
    if (pending === null) throw new ParseError(i + 1);
    pending.raw.push({ text: line, num: i + 1 });
  }
  flush();

  const sections: V4aSection[] = [];
  for (const rs of rawSections) {
    if (rs.kind === 'add') {
      const fileLines: string[] = [];
      for (const rl of rs.raw) {
        if (rl.text.startsWith('+')) fileLines.push(rl.text.slice(1));
        else if (rl.text === '') fileLines.push('');
        else throw new ParseError(rl.num);
      }
      sections.push({ kind: 'add', path: rs.path, lines: fileLines });
      continue;
    }
    if (rs.kind === 'delete') {
      if (rs.raw.length > 0) throw new ParseError(rs.raw[0].num);
      sections.push({ kind: 'delete', path: rs.path });
      continue;
    }
    // update
    let pos = 0;
    let moveTo: string | null = null;
    if (
      pos < rs.raw.length &&
      rs.raw[pos].text.startsWith('*** Move to: ')
    ) {
      moveTo = rs.raw[pos].text.slice('*** Move to: '.length).trim();
      pos++;
    }
    const chunks: V4aChunk[] = [];
    let curChunk: V4aChunk | null = null;
    while (pos < rs.raw.length) {
      const rl = rs.raw[pos];
      const text = rl.text;
      if (text.startsWith('@@')) {
        curChunk = {
          anchor: text.slice(2).trim(),
          eof: false,
          body: [],
          oLines: [],
          nEntries: [],
        };
        chunks.push(curChunk);
        pos++;
        continue;
      }
      if (text.trim() === '*** End of File') {
        if (curChunk === null) throw new ParseError(rl.num);
        curChunk.eof = true;
        curChunk = null;
        pos++;
        continue;
      }
      if (
        text.startsWith(' ') ||
        text.startsWith('-') ||
        text.startsWith('+') ||
        text === ''
      ) {
        if (curChunk === null) {
          if (chunks.length !== 0) throw new ParseError(rl.num);
          curChunk = {
            anchor: null,
            eof: false,
            body: [],
            oLines: [],
            nEntries: [],
          };
          chunks.push(curChunk);
        }
        curChunk.body.push(text);
        pos++;
        continue;
      }
      throw new ParseError(rl.num);
    }
    if (chunks.length === 0 && moveTo === null) {
      throw new ParseError(rs.startLine);
    }
    for (const ch of chunks) {
      const body = ch.body.map((l) => ({
        kind: l === '' ? (' ' as BodyKind) : (l[0] as BodyKind),
        text: l === '' ? '' : l.slice(1),
      }));
      const split = splitBody(body);
      ch.oLines = split.oLines;
      ch.nEntries = split.nEntries;
    }
    sections.push({ kind: 'update', path: rs.path, moveTo, chunks });
  }
  if (sections.length === 0) throw new ParseError(1);
  return sections;
}

/** First line at or after `from` equal to the anchor at the first tier. */
function findAnchor(
  lines: string[],
  anchor: string,
  from: number,
  strict: boolean,
): number | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = tierKey(anchor, t);
    for (let i = from; i < lines.length; i++) {
      if (tierKey(lines[i], t) === key) return i;
    }
  }
  return null;
}

function applyV4aSection(
  sec: V4aSection,
  tree: Tree,
  strict: boolean,
): EditOutcome {
  if (sec.kind === 'add') {
    if (!isSafePath(sec.path)) return failOutcome('unsafe', sec.path);
    if (tree.exists(sec.path)) return failOutcome('exists', sec.path);
    const text =
      sec.lines.length === 0 ? '' : sec.lines.join('\n') + '\n';
    return okOutcome([{ path: sec.path, text }]);
  }
  if (sec.kind === 'delete') {
    if (!isSafePath(sec.path)) return failOutcome('unsafe', sec.path);
    if (!tree.exists(sec.path)) return failOutcome('missing', sec.path);
    return okOutcome([{ path: sec.path, text: null }]);
  }
  if (!isSafePath(sec.path)) return failOutcome('unsafe', sec.path);
  if (sec.moveTo !== null && !isSafePath(sec.moveTo)) {
    return failOutcome('unsafe', sec.moveTo);
  }
  if (!tree.exists(sec.path)) return failOutcome('missing', sec.path);
  if (sec.moveTo !== null && tree.exists(sec.moveTo)) {
    return failOutcome('exists', sec.moveTo);
  }
  const work = parseFileText(tree.get(sec.path) as string);
  let cursor = 0;
  for (const chunk of sec.chunks) {
    // The anchor is a landmark, not part of O: the cursor moves past
    // the first anchor line at or after it, and O is searched after that.
    if (chunk.anchor !== null && chunk.anchor !== '') {
      const found = findAnchor(work.lines, chunk.anchor, cursor, strict);
      if (found === null) return failOutcome('no-match', sec.path);
      cursor = found + 1;
    }
    const o = chunk.oLines;
    const n = chunk.nEntries;
    if (o.length === 0) {
      const ins = chunk.eof ? work.lines.length : cursor;
      work.lines = [
        ...work.lines.slice(0, ins),
        ...n.map((e) => e.text),
        ...work.lines.slice(ins),
      ];
      cursor = ins + n.length;
      continue;
    }
    let found: { tier: number; pos: number } | null = null;
    const tiers = strict ? [0] : [0, 1, 2];
    // A chunk takes the first occurrence at or after the cursor; an
    // EOF-anchored chunk only takes one ending at the file's last line.
    for (const t of tiers) {
      const occ = occurrences(work.lines, o, t).filter(
        (p) =>
          p >= cursor && (!chunk.eof || p + o.length === work.lines.length),
      );
      if (occ.length > 0) {
        found = { tier: t, pos: occ[0] };
        break;
      }
    }
    if (found === null) return failOutcome('no-match', sec.path);
    const rep = buildReplacement(n, o, work.lines, found.pos, found.tier);
    work.lines = [
      ...work.lines.slice(0, found.pos),
      ...rep,
      ...work.lines.slice(found.pos + o.length),
    ];
    cursor = found.pos + rep.length;
  }
  const text = renderFileText(work);
  if (sec.moveTo !== null) {
    return okOutcome(
      [
        { path: sec.path, text: null },
        { path: sec.moveTo, text },
      ],
      { old: sec.path, nw: sec.moveTo },
    );
  }
  return okOutcome([{ path: sec.path, text }]);
}

/* ---------------- JSON edits (SPEC section 9) ---------------- */

type JsonEdit =
  | { command: 'create'; path: string; file_text: string }
  | { command: 'str_replace'; path: string; old_str: string; new_str: string }
  | { command: 'insert'; path: string; insert_line: number; new_str: string };

function validateJsonEdit(v: unknown): JsonEdit | null {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.path !== 'string') return null;
  if (typeof o.command !== 'string') return null;
  if (o.command === 'create') {
    if (typeof o.file_text !== 'string') return null;
    return { command: 'create', path: o.path, file_text: o.file_text };
  }
  if (o.command === 'str_replace') {
    if (typeof o.old_str !== 'string' || o.old_str === '') return null;
    if (o.new_str !== undefined && typeof o.new_str !== 'string') return null;
    return {
      command: 'str_replace',
      path: o.path,
      old_str: o.old_str,
      new_str: o.new_str === undefined ? '' : (o.new_str as string),
    };
  }
  if (o.command === 'insert') {
    if (typeof o.insert_line !== 'number' || !Number.isInteger(o.insert_line)) {
      return null;
    }
    if (typeof o.new_str !== 'string') return null;
    return {
      command: 'insert',
      path: o.path,
      insert_line: o.insert_line,
      new_str: o.new_str,
    };
  }
  return null;
}

function parseJson(lines: string[], patchText: string): JsonEdit[] {
  let first = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!isBlank(lines[i])) {
      first = i;
      break;
    }
  }
  if (first === -1) throw new ParseError(1);
  const firstChar = lines[first].trimStart()[0];
  // `[` starts a whole-text array form (any fault is a parse error at
  // the line where the array starts); otherwise each non-blank line
  // is one JSON object (a fault is a parse error at that line).
  if (firstChar === '[') {
    let arr: unknown;
    try {
      arr = JSON.parse(patchText);
    } catch {
      throw new ParseError(first + 1);
    }
    if (!Array.isArray(arr)) throw new ParseError(first + 1);
    const edits: JsonEdit[] = [];
    for (const el of arr) {
      const e = validateJsonEdit(el);
      if (e === null) throw new ParseError(first + 1);
      edits.push(e);
    }
    if (edits.length === 0) throw new ParseError(1);
    return edits;
  }
  const edits: JsonEdit[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (isBlank(l)) continue;
    let obj: unknown;
    try {
      obj = JSON.parse(l);
    } catch {
      throw new ParseError(i + 1);
    }
    const e = validateJsonEdit(obj);
    if (e === null) throw new ParseError(i + 1);
    edits.push(e);
  }
  if (edits.length === 0) throw new ParseError(1);
  return edits;
}

function applyJsonEdit(e: JsonEdit, tree: Tree): EditOutcome {
  if (!isSafePath(e.path)) return failOutcome('unsafe', e.path);
  if (e.command === 'create') {
    if (tree.exists(e.path)) return failOutcome('exists', e.path);
    return okOutcome([{ path: e.path, text: e.file_text }]);
  }
  if (!tree.exists(e.path)) return failOutcome('missing', e.path);
  if (e.command === 'str_replace') {
    const origText = tree.get(e.path) as string;
    const wf = parseFileText(origText);
    let text = origText;
    let oldStr = e.old_str;
    let newStr = e.new_str;
    if (wf.br === '\r\n') {
      text = text.replace(/\r\n/g, '\n');
      oldStr = oldStr.replace(/\r\n/g, '\n');
      newStr = newStr.replace(/\r\n/g, '\n');
    }
    let count = 0;
    let firstIdx = -1;
    let idx = 0;
    // Step by one character, not by oldStr.length: overlapping
    // occurrences count toward the ambiguity check too.
    while (true) {
      const p = text.indexOf(oldStr, idx);
      if (p === -1) break;
      count++;
      if (firstIdx === -1) firstIdx = p;
      idx = p + 1;
      if (count > 1) break;
    }
    if (count === 0) return failOutcome('no-match', e.path);
    if (count > 1) return failOutcome('ambiguous', e.path);
    let result =
      text.slice(0, firstIdx) + newStr + text.slice(firstIdx + oldStr.length);
    if (wf.br === '\r\n') result = result.replace(/\n/g, '\r\n');
    return okOutcome([{ path: e.path, text: result }]);
  }
  // insert
  const origText = tree.get(e.path) as string;
  const wf = parseFileText(origText);
  if (e.insert_line < 0 || e.insert_line > wf.lines.length) {
    return failOutcome('no-match', e.path);
  }
  const newLines = splitValueLines(e.new_str);
  const lines = [
    ...wf.lines.slice(0, e.insert_line),
    ...newLines,
    ...wf.lines.slice(e.insert_line),
  ];
  const text = renderFileText({ lines, br: wf.br, ends: wf.ends });
  return okOutcome([{ path: e.path, text }]);
}

/* ---------------- format detection (SPEC section 4) ---------------- */

/**
 * Detection order matters: v4a first, then json, then search-replace,
 * then unified. A V4A body can hold a line starting with `--- `, and
 * a JSON file's text can hold `<<<<<<< SEARCH`; only the first rule
 * that fires decides the format.
 */
function detectFormat(lines: string[]): string | null {
  let firstNonBlank: string | undefined;
  for (const l of lines) {
    if (!isBlank(l)) {
      firstNonBlank = l;
      break;
    }
  }
  if (
    firstNonBlank !== undefined &&
    firstNonBlank.trim() === '*** Begin Patch'
  ) {
    return 'v4a';
  }
  if (firstNonBlank !== undefined) {
    const c = firstNonBlank.trimStart()[0];
    if (c === '[' || c === '{') return 'json';
  }
  for (const l of lines) {
    if (stripTrail(l) === '<<<<<<< SEARCH') return 'search-replace';
  }
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('diff --git ')) return 'unified';
    if (
      lines[i].startsWith('--- ') &&
      i + 1 < lines.length &&
      lines[i + 1].startsWith('+++ ')
    ) {
      return 'unified';
    }
  }
  return null;
}

/* ---------------- running the edits (SPEC section 10) ---------------- */

type Edit =
  | { format: 'unified'; section: UnifiedSection }
  | { format: 'search-replace'; block: SrBlock }
  | { format: 'v4a'; section: V4aSection }
  | { format: 'json'; edit: JsonEdit };

function parsePatch(
  fmt: string,
  lines: string[],
  patchText: string,
): Edit[] {
  if (fmt === 'unified') {
    return parseUnified(lines).map((section) => ({ format: 'unified' as const, section }));
  }
  if (fmt === 'search-replace') {
    return parseSearchReplace(lines).map((block) => ({
      format: 'search-replace' as const,
      block,
    }));
  }
  if (fmt === 'v4a') {
    return parseV4a(lines).map((section) => ({ format: 'v4a' as const, section }));
  }
  return parseJson(lines, patchText).map((edit) => ({
    format: 'json' as const,
    edit,
  }));
}

function applyEdit(edit: Edit, tree: Tree, strict: boolean): EditOutcome {
  if (edit.format === 'unified') {
    return applyUnifiedSection(edit.section, tree, strict);
  }
  if (edit.format === 'search-replace') {
    return applySearchReplaceBlock(edit.block, tree, strict);
  }
  if (edit.format === 'v4a') {
    return applyV4aSection(edit.section, tree, strict);
  }
  return applyJsonEdit(edit.edit, tree);
}

interface Change {
  kind: 'A' | 'D' | 'M' | 'R';
  path: string;
  oldPath?: string;
  sortKey: string;
}

/** The changed paths, in byte order of the paths (UTF-8); R lines sort by <new>. */
function computeChanges(
  tree: Tree,
  moves: Array<{ old: string; nw: string }>,
): Change[] {
  const changes: Change[] = [];
  const suppressed = new Set<string>();
  // A move is only an R when the old path existed before and not after
  // and the new path did not exist before and does after; otherwise
  // the pair falls back to ordinary D and A lines below.
  for (const m of moves) {
    const oBefore = tree.original(m.old);
    const oAfter = tree.get(m.old);
    const nBefore = tree.original(m.nw);
    const nAfter = tree.get(m.nw);
    if (
      oBefore !== null &&
      oAfter === null &&
      nBefore === null &&
      nAfter !== null
    ) {
      changes.push({ kind: 'R', path: m.nw, oldPath: m.old, sortKey: m.nw });
      suppressed.add(m.old);
      suppressed.add(m.nw);
    }
  }
  for (const p of tree.touched()) {
    if (suppressed.has(p)) continue;
    const before = tree.original(p);
    const after = tree.get(p);
    if (before === null && after !== null) {
      changes.push({ kind: 'A', path: p, sortKey: p });
    } else if (before !== null && after === null) {
      changes.push({ kind: 'D', path: p, sortKey: p });
    } else if (before !== null && after !== null && before !== after) {
      changes.push({ kind: 'M', path: p, sortKey: p });
    }
  }
  changes.sort((a, b) =>
    Buffer.compare(Buffer.from(a.sortKey, 'utf8'), Buffer.from(b.sortKey, 'utf8')),
  );
  return changes;
}

function writeChanges(tree: Tree, changes: Change[]): void {
  for (const ch of changes) {
    if (ch.kind === 'A' || ch.kind === 'M') {
      const text = tree.get(ch.path) as string;
      mkdirSync(dirname(ch.path), { recursive: true });
      writeFileSync(ch.path, text, 'utf8');
    } else if (ch.kind === 'D') {
      try {
        unlinkSync(ch.path);
      } catch {
        // Already gone.
      }
    } else {
      // A move writes the new path first, then removes the old one.
      const text = tree.get(ch.path) as string;
      mkdirSync(dirname(ch.path), { recursive: true });
      writeFileSync(ch.path, text, 'utf8');
      try {
        unlinkSync(ch.oldPath as string);
      } catch {
        // Already gone.
      }
    }
  }
}

/* ---------------- invocation (SPEC sections 1 and 2) ---------------- */

function exit2(line: string): void {
  process.stdout.write(line + '\n');
  process.exitCode = 2;
}

function main(): void {
  const args = process.argv.slice(2);
  let format: string | null = null;
  let check = false;
  let strict = false;
  let seenFormat = false;
  let seenCheck = false;
  let seenStrict = false;
  let endOpts = false;
  const positional: string[] = [];

  for (const a of args) {
    if (!endOpts && a === '--') {
      endOpts = true;
      continue;
    }
    if (!endOpts && a.startsWith('-') && a !== '-') {
      if (a === '--check') {
        if (seenCheck) return exit2('error: usage');
        seenCheck = true;
        check = true;
      } else if (a === '--strict') {
        if (seenStrict) return exit2('error: usage');
        seenStrict = true;
        strict = true;
      } else if (a.startsWith('--format=')) {
        if (seenFormat) return exit2('error: usage');
        seenFormat = true;
        const v = a.slice('--format='.length);
        if (
          v !== 'unified' &&
          v !== 'search-replace' &&
          v !== 'v4a' &&
          v !== 'json' &&
          v !== 'auto'
        ) {
          return exit2('error: usage');
        }
        format = v;
      } else {
        return exit2('error: usage');
      }
    } else {
      positional.push(a);
    }
  }
  if (positional.length > 1) return exit2('error: usage');
  const patchArg = positional.length === 1 ? positional[0] : null;

  let patchText: string;
  if (patchArg === null || patchArg === '-') {
    patchText = readFileSync(0, 'utf8');
  } else {
    try {
      patchText = readFileSync(patchArg, 'utf8');
    } catch {
      return exit2('error: no-patch');
    }
  }

  const lines = splitPatch(patchText);
  // Error precedence: usage (above, before the patch is read) wins over
  // no-patch, which wins over format, which wins over parse; and a
  // parse error is reported before any file is looked at.
  let fmt = format ?? 'auto';
  if (fmt === 'auto') {
    const detected = detectFormat(lines);
    if (detected === null) return exit2('error: format');
    fmt = detected;
  }

  let edits: Edit[];
  try {
    edits = parsePatch(fmt, lines, patchText);
  } catch (e) {
    if (e instanceof ParseError) return exit2(`error: parse ${e.line}`);
    throw e;
  }

  const tree = new Tree();
  const failures: Array<{ code: string; path: string }> = [];
  const moves: Array<{ old: string; nw: string }> = [];
  for (const edit of edits) {
    const outcome = applyEdit(edit, tree, strict);
    if (!outcome.ok) {
      failures.push({
        code: outcome.code as string,
        path: outcome.path as string,
      });
      continue;
    }
    for (const m of outcome.mutations as Mutation[]) {
      if (m.text === null) tree.del(m.path);
      else tree.set(m.path, m.text);
    }
    if (outcome.move) moves.push(outcome.move);
  }

  if (failures.length > 0) {
    // Atomic: the tree is only an in-memory overlay, so a failure
    // anywhere means nothing has been written anywhere.
    const outLines = failures.map((f) => `error: ${f.code} ${f.path}`);
    outLines.push(`failed: ${failures.length} of ${edits.length} edits`);
    process.stdout.write(outLines.join('\n') + '\n');
    process.exitCode = 1;
    return;
  }

  const changes = computeChanges(tree, moves);
  if (!check) writeChanges(tree, changes);
  const outLines: string[] = [];
  for (const ch of changes) {
    if (ch.kind === 'R') outLines.push(`R ${ch.oldPath} -> ${ch.path}`);
    else outLines.push(`${ch.kind} ${ch.path}`);
  }
  outLines.push(
    changes.length === 1 ? 'ok: 1 file' : `ok: ${changes.length} files`,
  );
  process.stdout.write(outLines.join('\n') + '\n');
  process.exitCode = 0;
}

const envUrl = process.env.MAKEFUN_ENV_URL;
if (envUrl !== undefined && envUrl !== '') {
  await runTrial(envUrl);
} else {
  main();
}
