// Line-level comparison of two stored plan texts for `plan-state --compare`.
//
// Deliberately dependency-free and self-contained: the plugin ships zero
// runtime dependencies and `plan-state` must keep working outside a git
// repository, so neither a diff package nor `git diff --no-index` is an
// option. The scope is plan text only - this is not a general diff utility.

// Per-side caps. Stored plans are bounded only by the 32 MiB `plan-store`
// input limit, so both preflights run before any allocation-scale work: the
// char cap is O(1) and also bounds the single-huge-line case the line cap
// cannot see, and the line count never allocates a split array.
export const MAX_COMPARE_PLAN_LINES = 2000;
export const MAX_COMPARE_PLAN_CHARS = 1_000_000;

const DIFF_CONTEXT_LINES = 3;

export interface PlanTextDiff {
  identical: boolean;
  suppressed: boolean;
  // Unified-style hunks joined with '\n' and no trailing newline; '' when the
  // texts are identical or the comparison was suppressed.
  diff: string;
}

type DiffOpKind = ' ' | '-' | '+';

interface DiffEntry {
  kind: DiffOpKind;
  text: string;
}

interface DiffOp extends DiffEntry {
  // Zero-based positions the op occupies in each side once the ops are
  // ordered; a removal keeps the b position it sits after, and vice versa.
  aIndex: number;
  bIndex: number;
}

// Counts effective lines, not '\n' delimiters: one terminal newline is
// discounted so 'a\n' is one line, while an unterminated 'a\nb' is two. Runs
// without allocating and stops as soon as the cap is passed.
function exceedsLineCap(text: string): boolean {
  const end = text.endsWith('\n') ? text.length - 1 : text.length;
  if (end <= 0) {
    return false;
  }

  let lines = 1;
  let index = text.indexOf('\n');
  while (index !== -1 && index < end) {
    lines += 1;
    if (lines > MAX_COMPARE_PLAN_LINES) {
      return true;
    }
    index = text.indexOf('\n', index + 1);
  }
  return false;
}

// An empty side must become zero lines, never [''] as String.prototype.split
// returns: the spurious empty line turns a pure insertion into an empty-line
// replacement.
function splitPlanLines(text: string): string[] {
  const body = text.endsWith('\n') ? text.slice(0, -1) : text;
  return body === '' ? [] : body.split('\n');
}

function withLineNumbers(entries: DiffEntry[]): DiffOp[] {
  const ops: DiffOp[] = [];
  let aLine = 0;
  let bLine = 0;
  for (const entry of entries) {
    ops.push({ ...entry, aIndex: aLine, bIndex: bLine });
    if (entry.kind !== '+') {
      aLine += 1;
    }
    if (entry.kind !== '-') {
      bLine += 1;
    }
  }
  return ops;
}

function buildDiffOps(aLines: string[], bLines: string[]): DiffOp[] {
  const n = aLines.length;
  const m = bLines.length;
  const width = m + 1;
  // table[i * width + j] is the LCS length of aLines[i..] and bLines[j..]. The
  // trailing row and column stay zero, so the forward walk below can read one
  // cell past the current position without bounds checks.
  const table = new Int32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] =
        aLines[i] === bLines[j]
          ? table[(i + 1) * width + j + 1]! + 1
          : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }

  const entries: DiffEntry[] = [];
  let removals: string[] = [];
  let additions: string[] = [];
  // Removals always precede additions inside a change run, so a replacement
  // reads as `-old` then `+new` regardless of the walk's tie-breaking.
  const flush = (): void => {
    for (const text of removals) {
      entries.push({ kind: '-', text });
    }
    for (const text of additions) {
      entries.push({ kind: '+', text });
    }
    removals = [];
    additions = [];
  };

  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && aLines[i] === bLines[j]) {
      flush();
      entries.push({ kind: ' ', text: aLines[i]! });
      i += 1;
      j += 1;
      continue;
    }

    if (i === n || (j < m && table[i * width + j + 1]! >= table[(i + 1) * width + j]!)) {
      additions.push(bLines[j]!);
      j += 1;
      continue;
    }

    removals.push(aLines[i]!);
    i += 1;
  }
  flush();

  return withLineNumbers(entries);
}

// Unlike git, the header always prints `start,count`; a zero count uses the
// preceding line number, so an insertion into an empty side reads `-0,0`.
function renderHunk(ops: DiffOp[], firstChange: number, lastChange: number): string[] {
  const start = Math.max(0, firstChange - DIFF_CONTEXT_LINES);
  const end = Math.min(ops.length - 1, lastChange + DIFF_CONTEXT_LINES);

  let aCount = 0;
  let bCount = 0;
  const body: string[] = [];
  for (let index = start; index <= end; index += 1) {
    const op = ops[index]!;
    if (op.kind !== '+') {
      aCount += 1;
    }
    if (op.kind !== '-') {
      bCount += 1;
    }
    body.push(`${op.kind}${op.text}`);
  }

  const first = ops[start]!;
  const aStart = aCount === 0 ? first.aIndex : first.aIndex + 1;
  const bStart = bCount === 0 ? first.bIndex : first.bIndex + 1;
  return [`@@ -${aStart},${aCount} +${bStart},${bCount} @@`, ...body];
}

function renderHunks(ops: DiffOp[]): string[] {
  const changes: number[] = [];
  for (const [index, op] of ops.entries()) {
    if (op.kind !== ' ') {
      changes.push(index);
    }
  }
  if (changes.length === 0) {
    return [];
  }

  const lines: string[] = [];
  let groupStart = changes[0]!;
  let groupEnd = groupStart;
  for (const index of changes.slice(1)) {
    // Change runs whose unchanged gap still fits both context windows share a
    // hunk; a wider gap starts a new one.
    if (index - groupEnd - 1 <= DIFF_CONTEXT_LINES * 2) {
      groupEnd = index;
      continue;
    }
    lines.push(...renderHunk(ops, groupStart, groupEnd));
    groupStart = index;
    groupEnd = index;
  }
  lines.push(...renderHunk(ops, groupStart, groupEnd));
  return lines;
}

export function diffPlanTexts(aText: string, bText: string): PlanTextDiff {
  if (aText === bText) {
    return { identical: true, suppressed: false, diff: '' };
  }
  if (aText.length > MAX_COMPARE_PLAN_CHARS || bText.length > MAX_COMPARE_PLAN_CHARS) {
    return { identical: false, suppressed: true, diff: '' };
  }
  if (exceedsLineCap(aText) || exceedsLineCap(bText)) {
    return { identical: false, suppressed: true, diff: '' };
  }

  const hunks = renderHunks(buildDiffOps(splitPlanLines(aText), splitPlanLines(bText)));
  if (hunks.length === 0) {
    // The texts differed only by a trailing newline.
    return { identical: true, suppressed: false, diff: '' };
  }
  return { identical: false, suppressed: false, diff: hunks.join('\n') };
}
