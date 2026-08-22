// =====================================================================
// 言の葉 / Kotonoha — 発音練習（ベトナム語の声調）
//
// 端末内で完結する。外部 API も課金も発生しない:
//   録音 → F0 追跡 → 正規化 → お手本と DTW 比較 → 採点
//
// 採点結果は FSRS に載せる。声調ごとに苦手さが違うので、
// 単語と同じように「忘れかけた声調」が優先的に再出題される。
// =====================================================================

import { analyze, toShape, resample, dtw } from './pitch.js';
import { TONES, TONE_IDS, classifyTone, scorePronunciation, toneOfSyllable } from './tones.js';
import { rateWord, getSrsState } from './vocabulary.js';
import { statusOf, isDue, RATING } from './srs.js';

export { TONES, TONE_IDS, RATING };

let setsCache = null;

export async function loadToneSets() {
  if (setsCache) return setsCache;
  try {
    const res = await fetch('./data/vi-tones.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    setsCache = await res.json();
  } catch (err) {
    console.error('tone sets load failed:', err);
    setsCache = [];
  }
  return setsCache;
}

export async function getToneSet(setId) {
  const all = await loadToneSets();
  return all.find((s) => s.id === setId) ?? all[0] ?? null;
}

/**
 * 発音練習の項目 ID。単語帳の SRS と同じストアを使うため、
 * 衝突しないよう接頭辞を付ける。
 */
export function itemId(setId, word) {
  return `pron:${setId}:${word}`;
}

/**
 * 練習キューを組む。
 * 期日が来たもの → 未学習 の順に並べ、同じ声調が続かないよう散らす。
 */
export async function buildToneQueue(setId) {
  const set = await getToneSet(setId);
  if (!set) return [];

  const now = Date.now();
  const enriched = await Promise.all(
    set.items.map(async (item) => {
      const id  = itemId(set.id, item.word);
      const srs = await getSrsState(id);
      return {
        ...item,
        id,
        setId: set.id,
        // データ側の tone は綴りから機械的に検証できる。食い違えば綴りを優先。
        tone: toneOfSyllable(item.word) ?? item.tone,
        srs,
        status: statusOf(srs),
        due: isDue(srs, now),
      };
    })
  );

  const due = enriched.filter((e) => e.due);
  const rest = enriched.filter((e) => !e.due);
  return [...spreadTones(due), ...rest];
}

/** 同じ声調が連続しないよう並べ替える（連続すると耳がリセットされない）。 */
function spreadTones(items) {
  const byTone = new Map();
  for (const it of items) {
    if (!byTone.has(it.tone)) byTone.set(it.tone, []);
    byTone.get(it.tone).push(it);
  }
  const out = [];
  let remaining = items.length;
  while (remaining > 0) {
    for (const list of byTone.values()) {
      if (list.length) { out.push(list.shift()); remaining--; }
    }
  }
  return out;
}

/**
 * 録音を評価する。
 *
 * @param {Float32Array} samples
 * @param {number} sampleRate 端末の実サンプルレート（iPhone は 48000）
 * @param {string} targetTone 目標の声調 ID
 */
export function evaluateRecording(samples, sampleRate, targetTone) {
  const analysis = analyze(samples, sampleRate);
  const result = scorePronunciation(targetTone, analysis, { toShape, resample, dtw });
  return { analysis, result };
}

/** 判定の見た目上の区分。 */
export function verdictOf(result) {
  if (!result?.ok) return { key: 'miss', label: '判定できず' };
  if (result.matched && result.score >= 80) return { key: 'good', label: 'よい発音' };
  if (result.matched)                        return { key: 'near', label: 'おしい' };
  return { key: 'miss', label: `${TONES[result.heardAs]?.label ?? '別の声調'} に聞こえます` };
}

/**
 * 点数から FSRS の評価を推定する（学習者が自己申告しなかった場合の既定値）。
 * 自己申告があればそちらを優先する — 機械の判定より本人の手応えのほうが
 * 記憶状態をよく表すため。
 */
export function suggestedRating(result) {
  if (!result?.ok || !result.matched) return RATING.AGAIN;
  if (result.score >= 90) return RATING.EASY;
  if (result.score >= 75) return RATING.GOOD;
  return RATING.HARD;
}

/** 評価を SRS に記録する。 */
export async function recordToneAttempt(id, rating) {
  return rateWord(id, rating);
}

/**
 * SVG のパス文字列に変換する。
 * 半音の値域を上下反転して（高い音ほど上へ）描く。
 */
export function contourToPath(shape, { width = 300, height = 110, range = 8 } = {}) {
  if (!shape?.length) return '';
  const mid = height / 2;
  const step = width / (shape.length - 1 || 1);
  return shape
    .map((v, i) => {
      const clamped = Math.max(-range, Math.min(range, v));
      const y = mid - (clamped / range) * (mid - 10);
      return `${i === 0 ? 'M' : 'L'}${(i * step).toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
