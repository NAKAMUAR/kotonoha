// =====================================================================
// 言の葉 / Kotonoha — FSRS-6 SRS アルゴリズム
// 参考: https://github.com/open-spaced-repetition/py-fsrs (FSRS-6, 21 パラメータ)
//
// SM-2（1987 年）の後継として、Anki 等でも採用されている記憶モデル。
// 各単語について
//   stability  (S) ... 記憶の安定度。「思い出せる確率が 90% まで下がる日数」
//   difficulty (D) ... 単語の難しさ (1〜10)
// を持ち、復習のたびに更新して「忘れかける直前」に次回復習日を設定する。
//
// 4 段階評価（FSRS の Rating）:
//   忘れた (AGAIN) → 1 ... 思い出せなかった
//   難しい (HARD)  → 2 ... 思い出せたが苦労した
//   普通   (GOOD)  → 3 ... 少し考えて思い出せた
//   簡単   (EASY)  → 4 ... すぐに思い出せた
// =====================================================================

export const QUALITY = Object.freeze({
  AGAIN:  1,
  HARD:   2,
  NORMAL: 3,
  EASY:   4,
});

export const ALGORITHM = 'fsrs-6';

// FSRS-6 既定パラメータ（py-fsrs DEFAULT_PARAMETERS）
const W = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

const DESIRED_RETENTION = 0.9;   // 復習時点で 90% 思い出せる間隔を狙う
const MAXIMUM_INTERVAL  = 36500; // 日
const STABILITY_MIN     = 0.001;
const RELEARN_MINUTES   = 10;    // 「忘れた」単語は 10 分後に再出題

const DECAY  = -W[20];
const FACTOR = 0.9 ** (1 / DECAY) - 1;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));
const clampD = (d) => clamp(d, 1, 10);
const clampS = (s) => Math.max(s, STABILITY_MIN);

export function newSrsState() {
  return {
    algorithm:      ALGORITHM,
    stability:      null,
    difficulty:     null,
    interval:       0,
    repetitions:    0,   // 連続正答回数（「忘れた」で 0 に戻る）
    reviewCount:    0,   // 通算の復習回数
    lapses:         0,
    lastRating:     null,
    nextReviewDate: Date.now(),
    lastReviewedAt: null,
  };
}

// ---------- FSRS の各式 ----------

function initialStability(g) {
  return clampS(W[g - 1]);
}

function initialDifficulty(g) {
  return W[4] - Math.exp(W[5] * (g - 1)) + 1;
}

function nextDifficulty(d, g) {
  const delta  = -W[6] * (g - 3);
  const damped = d + (10 - d) * delta / 9;                       // 線形ダンピング
  return clampD(W[7] * initialDifficulty(QUALITY.EASY) + (1 - W[7]) * damped); // 平均回帰
}

export function retrievability(elapsedDays, s) {
  return (1 + FACTOR * Math.max(0, elapsedDays) / s) ** DECAY;
}

function recallStability(d, s, r, g) {
  const hardPenalty = g === QUALITY.HARD ? W[15] : 1;
  const easyBonus   = g === QUALITY.EASY ? W[16] : 1;
  return s * (
    1 + Math.exp(W[8]) * (11 - d) * s ** -W[9] *
    (Math.exp((1 - r) * W[10]) - 1) * hardPenalty * easyBonus
  );
}

function forgetStability(d, s, r) {
  const longTerm  = W[11] * d ** -W[12] * ((s + 1) ** W[13] - 1) * Math.exp((1 - r) * W[14]);
  const shortTerm = s / Math.exp(W[17] * W[18]);
  return Math.min(longTerm, shortTerm);
}

function shortTermStability(s, g) {
  let inc = Math.exp(W[17] * (g - 3 + W[18])) * s ** -W[19];
  if (g >= QUALITY.NORMAL) inc = Math.max(inc, 1);
  return s * inc;
}

function nextIntervalDays(s) {
  const iv = (s / FACTOR) * (DESIRED_RETENTION ** (1 / DECAY) - 1);
  return clamp(Math.round(iv), 1, MAXIMUM_INTERVAL);
}

// ---------- 旧 SM-2 データからの移行 ----------

/**
 * SM-2 形式（easeFactor / interval）の状態を FSRS 形式に変換する。
 * 間隔 ≒ 安定度、易しさ係数 → 難しさ（2.5 → 5、1.3 → 10）で近似。
 * 次回復習日はそのまま引き継ぐので、移行直後に予定が変わることはない。
 */
export function migrateState(state) {
  if (!state) return null;
  if (state.algorithm === ALGORITHM && state.stability != null) return state;

  const reviewed = !!state.lastReviewedAt || (state.repetitions ?? 0) > 0 || (state.lapses ?? 0) > 0;
  if (!reviewed) return { ...state, ...newSrsState(), nextReviewDate: state.nextReviewDate ?? Date.now() };

  const ef = state.easeFactor ?? 2.5;
  return {
    ...state,
    algorithm:   ALGORITHM,
    stability:   clampS(Math.max(state.interval ?? 1, 1)),
    difficulty:  clampD(5 + (2.5 - ef) * (5 / 1.2)),
    reviewCount: state.reviewCount ?? (state.repetitions ?? 0) + (state.lapses ?? 0),
    lastRating:  state.lastRating ?? null,
  };
}

/**
 * FSRS を一回適用して新しい状態を返す（純粋関数）。
 * rating: QUALITY.AGAIN / HARD / NORMAL / EASY
 */
export function applySrs(state, rating, now = Date.now()) {
  const g = clamp(Math.round(rating), 1, 4);
  const s0 = migrateState(state) ?? newSrsState();

  let stability;
  let difficulty;

  if (s0.stability == null || !s0.lastReviewedAt) {
    // 初回
    stability  = initialStability(g);
    difficulty = clampD(initialDifficulty(g));
  } else {
    const elapsed = (now - s0.lastReviewedAt) / MS_PER_DAY;
    if (elapsed < 1) {
      // 同じ日のうちの再復習
      stability = shortTermStability(s0.stability, g);
    } else {
      const r = retrievability(Math.floor(elapsed), s0.stability);
      stability = g === QUALITY.AGAIN
        ? forgetStability(s0.difficulty, s0.stability, r)
        : recallStability(s0.difficulty, s0.stability, r, g);
    }
    difficulty = nextDifficulty(s0.difficulty, g);
  }
  stability = clampS(stability);

  const failed   = g === QUALITY.AGAIN;
  const interval = failed ? 0 : nextIntervalDays(stability);
  const nextReviewDate = failed
    ? now + RELEARN_MINUTES * 60 * 1000
    : now + interval * MS_PER_DAY;

  return {
    algorithm:      ALGORITHM,
    stability:      +stability.toFixed(4),
    difficulty:     +difficulty.toFixed(4),
    interval,
    repetitions:    failed ? 0 : (s0.repetitions ?? 0) + 1,
    reviewCount:    (s0.reviewCount ?? 0) + 1,
    lapses:         (s0.lapses ?? 0) + (failed && s0.lastReviewedAt ? 1 : 0),
    lastRating:     g,
    nextReviewDate,
    lastReviewedAt: now,
  };
}

/**
 * 各評価を押した場合の次回間隔（日数、0 = 10 分後）をプレビューする。
 */
export function previewIntervals(state, now = Date.now()) {
  const out = {};
  for (const g of [QUALITY.AGAIN, QUALITY.HARD, QUALITY.NORMAL, QUALITY.EASY]) {
    out[g] = applySrs(state, g, now).interval;
  }
  return out;
}

/**
 * 単語の学習ステータス分類。
 *   new      ... 未学習（一度も復習していない）
 *   learning ... 学習中（連続正答 0-2 回）
 *   review   ... 復習段階（連続正答 3 回以上、interval < 21 日）
 *   mastered ... 習得済（interval >= 21 日）
 */
export function statusOf(state) {
  if (!state || (!state.lastReviewedAt && !(state.repetitions > 0))) return 'new';
  if (state.interval >= 21)  return 'mastered';
  if (state.repetitions < 3) return 'learning';
  return 'review';
}

export function isDue(state, now = Date.now()) {
  if (!state) return true;
  return state.nextReviewDate <= now;
}
