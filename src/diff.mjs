/** 极简行级 diff（LCS），用于落盘前展示 before/after。 */
export function lineDiff(before, after) {
  const a = before.split('\n'), b = after.split('\n');
  const m = a.length, n = b.length;
  // LCS 长度表；配置文件规模很小，O(mn) 完全够用
  const L = Array.from({ length: m + 1 }, () => new Uint32Array(n + 1));
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);

  const out = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) { out.push([' ', a[i]]); i++; j++; }
    else if (L[i + 1][j] >= L[i][j + 1]) { out.push(['-', a[i]]); i++; }
    else { out.push(['+', b[j]]); j++; }
  }
  while (i < m) out.push(['-', a[i++]]);
  while (j < n) out.push(['+', b[j++]]);
  return out;
}

/** 折叠连续的未变更行，只保留变更点周围 context 行。 */
export function collapse(rows, context = 2) {
  const keep = new Array(rows.length).fill(false);
  rows.forEach((r, i) => {
    if (r[0] === ' ') return;
    for (let k = Math.max(0, i - context); k <= Math.min(rows.length - 1, i + context); k++) keep[k] = true;
  });
  const out = []; let skipped = 0;
  rows.forEach((r, i) => {
    if (keep[i]) { if (skipped) { out.push(['~', `… 未变更 ${skipped} 行 …`]); skipped = 0; } out.push(r); }
    else skipped++;
  });
  if (skipped) out.push(['~', `… 未变更 ${skipped} 行 …`]);
  return out;
}

export function hasChanges(rows) { return rows.some((r) => r[0] !== ' '); }
