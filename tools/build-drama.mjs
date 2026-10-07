// =====================================================================
// ドラマの台詞（data/dramas-vi.json）と単語リスト（data/_drama-vi-words.json）から
// 単語帳用のデータを作る。
//   data/vocabulary-vi-drama.json … 単語（例文はドラマの台詞から自動で取る）
//   data/situations-vi-drama.json … 単語カードの裏に出す「その場面の会話」
//
// 使い方: node tools/build-drama.mjs
// =====================================================================

import { readFileSync, writeFileSync } from 'node:fs';

const dramas = JSON.parse(readFileSync('data/dramas-vi.json', 'utf8'));
const words  = JSON.parse(readFileSync('data/_drama-vi-words.json', 'utf8'));

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hasWord = (text, word) =>
  new RegExp(`(?<![\\p{L}\\p{N}])${escRe(word)}(?![\\p{L}\\p{N}])`, 'iu').test(text);

const vocab = [];
const situations = {};
const seen = new Set();
let errors = 0;

words.forEach(([dramaId, word, reading, meaning, sceneId], i) => {
  const drama = dramas.find((d) => d.id === dramaId);
  const scene = drama?.scenes.find((s) => s.id === sceneId);
  if (!scene) { console.error(`シーンが見つかりません: ${word} (${sceneId})`); errors++; return; }
  if (seen.has(word)) { console.error(`同じ単語が2回あります: ${word}`); errors++; return; }
  seen.add(word);

  const idx = scene.lines.findIndex((l) => hasWord(l.vi, word));
  if (idx < 0) { console.error(`台詞に単語がありません: ${word} (${sceneId})`); errors++; return; }
  const line = scene.lines[idx];
  const id = `vd_${String(i + 1).padStart(3, '0')}`;

  vocab.push({
    id, word, reading, meaning,
    example: line.vi,
    exampleTranslation: line.ja,
    level: 'ドラマ',
    tags: ['drama', dramaId, sceneId],
    scene: sceneId,
  });

  // 前後の台詞を含めた短いやりとり（最大 3 行）
  const from = Math.max(0, idx - 1);
  const lines = scene.lines.slice(from, from + 3).map((l) => ({
    speaker: drama.characters[l.s]?.name ?? l.s,
    vi: l.vi,
    ja: l.ja,
  }));
  situations[id] = [{ scene: `${scene.title}（${scene.time}）`, lines }];
});

if (errors) { console.error(`${errors} 件のエラーがあります。ファイルは書き出しませんでした。`); process.exit(1); }

writeFileSync('data/vocabulary-vi-drama.json', '[\n' + vocab.map((v) => JSON.stringify(v)).join(',\n') + '\n]\n');
writeFileSync('data/situations-vi-drama.json', JSON.stringify(situations, null, 1) + '\n');
console.log(`単語 ${vocab.length} 語を書き出しました。`);
