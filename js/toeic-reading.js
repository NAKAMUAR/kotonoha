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
  return all.filter((q) => q.part === part);
}
