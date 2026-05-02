// =====================================================================
// 言の葉 / Kotonoha — SM-2 SRS アルゴリズム
// 参考: https://en.wikipedia.org/wiki/SuperMemo (SM-2)
//
// 3 段階評価 → SM-2 quality (0-5) へのマッピング:
//   難しい (HARD)   → 2 ... 失敗扱い、間隔リセット
//   普通   (NORMAL) → 4 ... 通常進行
//   簡単   (EASY)   → 5 ... ボーナス進行
// =====================================================================

export const QUALITY = Object.freeze({
  HARD:   2,
  NORMAL: 4,
  EASY:   5,
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export function newSrsState() {
  return {
    easeFactor:     2.5,
    interval:       0,
    repetitions:    0,
    lapses:         0,
    nextReviewDate: Date.now(),
    lastReviewedAt: null,
  };
}

/**
 * SM-2 を一回適用して新しい状態を返す（純粋関数）。
 */
export function applySrs(state, quality) {
  const s = state ?? newSrsState();
  let { easeFactor: ef, interval: iv, repetitions: rep, lapses: lap } = s;

  if (quality < 3) {
    rep = 0;
    iv  = 1;
    lap += 1;
  } else {
    if      (rep === 0) iv = 1;
    else if (rep === 1) iv = 6;
    else                iv = Math.round(iv * ef);
    rep += 1;
  }

  // EF 更新
  ef = ef + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (ef < 1.3) ef = 1.3;

  const now = Date.now();
  return {
    easeFactor:     +ef.toFixed(3),
    interval:       iv,
    repetitions:    rep,
    lapses:         lap,
    nextReviewDate: now + iv * MS_PER_DAY,
    lastReviewedAt: now,
  };
}

/**
 * 単語の学習ステータス分類。
 *   new      ... 未学習
 *   learning ... 学習中（連続正答 1-2 回）
 *   review   ... 復習段階（連続正答 3 回以上、interval < 21 日）
 *   mastered ... 習得済（interval >= 21 日）
 */
export function statusOf(state) {
  if (!state || state.repetitions === 0) return 'new';
  if (state.repetitions < 3)              return 'learning';
  if (state.interval >= 21)               return 'mastered';
  return 'review';
}

export function isDue(state, now = Date.now()) {
  if (!state) return true;
  return state.nextReviewDate <= now;
}
