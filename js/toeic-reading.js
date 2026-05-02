// =====================================================================
// 言の葉 / Kotonoha — TOEIC Reading モジュール
// Step 11: Part 5-7 のリーディング演習
// =====================================================================

let readingCache = null;

export async function loadReading() {
  if (readingCache) return readingCache;
  try {
    const res = await fetch('./data/toeic-reading.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    readingCache = await res.json();
  } catch (err) {
    console.error('reading load failed:', err);
    readingCache = [];
  }
  return readingCache;
}

export async function getReadingByPart(part) {
  const all = await loadReading();
  const records = all.filter((q) => q.part === part);

  // Part 6/7 は親レコードの中に複数の問題を持つ → 学習画面では問題単位で進めるため flatten。
  if (part === 6 || part === 7) {
    const flat = [];
    for (const r of records) {
      const subs = r.blanks ?? r.questions ?? [];
      subs.forEach((sq, i) => {
        flat.push({
          ...sq,
          part: r.part,
          parentId: r.id,
          passage: r.passage,
          passageType: r.passageType,
          passageTypeJa: r.passageTypeJa,
          subIndex: i,
          totalSub: subs.length,
          tags: r.tags,
          level: r.level,
        });
      });
    }
    return flat;
  }

  return records;
}
