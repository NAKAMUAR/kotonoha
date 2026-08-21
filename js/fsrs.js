// =====================================================================
// 言の葉 / Kotonoha — FSRS-6 (Free Spaced Repetition Scheduler)
//
// SM-2（1988年）に代わる現行世代の間隔反復アルゴリズム。
// Anki 24.11 以降の既定スケジューラでもあり、同じ復習回数で
// SM-2 より高い記憶保持率、または同じ保持率をより少ない復習回数で
// 達成できることが大規模データセットで示されている。
//
// DSR モデル（3 変数で記憶を表現）:
//   D … Difficulty     難易度 (1–10)。その単語の覚えにくさ。
//   S … Stability      安定度 (日)。想起率が 90% まで落ちるまでの日数。
//   R … Retrievability 想起率 (0–1)。今この瞬間に思い出せる確率。
//
// SM-2 との本質的な違い:
//   ・SM-2 は「間隔 × 係数」の乗算だけで、忘却曲線を持たない。
//   ・FSRS は経過日数から R を推定し、「R が目標記憶率まで落ちる日」を
//     復習日とする。復習が遅れた場合もその情報を学習に取り込む
//     （遅れた復習は記憶をより強化する = spacing effect の定量化）。
//
// 参考: https://github.com/open-spaced-repetition/fsrs4anki/wiki
// =====================================================================

/** 4 段階評価。FSRS は 4 段階を前提に係数が最適化されている。 */
export const RATING = Object.freeze({
  AGAIN: 1, // 思い出せなかった（ラプス）
  HARD:  2, // 思い出せたが苦しかった
  GOOD:  3, // 普通に思い出せた
  EASY:  4, // 即座に思い出せた
});

export const RATING_LABELS = Object.freeze({
  1: 'もう一度',
  2: '難しい',
  3: '普通',
  4: '簡単',
});

/** カードの学習フェーズ。 */
export const CARD_STATE = Object.freeze({
  NEW:        'new',
  LEARNING:   'learning',   // 初回学習中（日をまたがない短期ステップ）
  REVIEW:     'review',     // 通常の日単位復習
  RELEARNING: 'relearning', // ラプス後の立て直し中
});

// FSRS-6 の既定パラメータ（21 個）。
// 数十億件の復習ログから最適化された汎用初期値。ユーザー個人の
// ログが十分たまれば optimizer で置き換えられる想定で、
// 外部から差し替え可能な形にしている。
export const DEFAULT_PARAMS = Object.freeze([
  0.2172, 1.1771, 3.2602, 16.1507, 7.0114, 0.5700, 2.0966, 0.0069,
  1.5261, 0.1120, 1.0178, 1.8490, 0.1133, 0.3127, 2.2934, 0.2191,
  3.0004, 0.7536, 0.3332, 0.1437, 0.2000,
]);

export const DEFAULT_CONFIG = Object.freeze({
  params:            DEFAULT_PARAMS,
  desiredRetention:  0.90,  // 目標記憶率。上げるほど復習が増え、下げるほど減る。
  maximumInterval:   365,   // 上限（日）。長すぎる間隔は学習実感を失うため 1 年で頭打ち。
  enableFuzz:        true,  // 間隔に ±5% 程度の揺らぎを与え、復習日の団子化を防ぐ
});

const MIN_STABILITY = 0.001;
const MAX_DIFFICULTY = 10;
const MIN_DIFFICULTY = 1;

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

// ---------------------------------------------------------------------
// 忘却曲線
// ---------------------------------------------------------------------

/** decay 項。FSRS-6 では w[20] で曲線の形自体を学習する。 */
function decayOf(w) {
  return -w[20];
}

function factorOf(w) {
  const decay = decayOf(w);
  return Math.pow(0.9, 1 / decay) - 1;
}

/**
 * 想起率 R(t, S)。べき関数型の忘却曲線。
 * 指数関数型より実データへの当てはまりが良いことが知られている。
 *
 * @param {number} elapsedDays 前回復習からの経過日数
 * @param {number} stability   安定度 S（日）
 */
export function retrievability(elapsedDays, stability, w = DEFAULT_PARAMS) {
  if (!(stability > 0)) return 0;
  const t = Math.max(0, elapsedDays);
  return Math.pow(1 + factorOf(w) * (t / stability), decayOf(w));
}

/**
 * 目標記憶率 r まで想起率が落ちる日数 = 次回復習までの間隔。
 * retrievability() の逆関数。
 */
export function intervalForRetention(stability, desiredRetention, w = DEFAULT_PARAMS) {
  const decay = decayOf(w);
  return (stability / factorOf(w)) * (Math.pow(desiredRetention, 1 / decay) - 1);
}

// ---------------------------------------------------------------------
// 初期メモリ状態
// ---------------------------------------------------------------------

function initialStability(w, grade) {
  return Math.max(w[grade - 1], MIN_STABILITY);
}

function initialDifficulty(w, grade) {
  return clamp(w[4] - Math.exp(w[5] * (grade - 1)) + 1, MIN_DIFFICULTY, MAX_DIFFICULTY);
}

// ---------------------------------------------------------------------
// メモリ状態の更新
// ---------------------------------------------------------------------

function nextDifficulty(w, difficulty, grade) {
  // 評価に応じた線形の増減。damping で D が端に張り付くのを防ぐ。
  const delta   = -w[6] * (grade - 3);
  const damped  = difficulty + delta * ((10 - difficulty) / 9);
  // 平均回帰。長期的に「簡単」が続いた単語が D=1 に固着しないようにする。
  const reverted = w[7] * initialDifficulty(w, RATING.EASY) + (1 - w[7]) * damped;
  return clamp(reverted, MIN_DIFFICULTY, MAX_DIFFICULTY);
}

/** 想起に成功したときの安定度。R が低いほど伸びが大きい = 間隔効果。 */
function stabilityAfterRecall(w, difficulty, stability, r, grade) {
  const hardPenalty = grade === RATING.HARD ? w[15] : 1;
  const easyBonus   = grade === RATING.EASY ? w[16] : 1;
  const growth =
    1 +
    Math.exp(w[8]) *
      (11 - difficulty) *
      Math.pow(stability, -w[9]) *
      (Math.exp(w[10] * (1 - r)) - 1) *
      hardPenalty *
      easyBonus;
  return stability * growth;
}

/** 忘却したときの安定度。ゼロには戻らず、過去の学習分が残る。 */
function stabilityAfterForget(w, difficulty, stability, r) {
  const long =
    w[11] *
    Math.pow(difficulty, -w[12]) *
    (Math.pow(stability + 1, w[13]) - 1) *
    Math.exp(w[14] * (1 - r));
  // 同日中の再学習分。ラプス直後の安定度が元の S を超えないよう抑える。
  const short = stability / Math.exp(w[17] * w[18]);
  return Math.min(long, short);
}

/** 同日内の再学習（学習ステップ中）の安定度更新。 */
function stabilityShortTerm(w, stability, grade) {
  const sinc = Math.exp(w[17] * (grade - 3 + w[18])) * Math.pow(stability, -w[19]);
  const bounded = grade >= RATING.GOOD ? Math.max(sinc, 1) : sinc;
  return stability * bounded;
}

// ---------------------------------------------------------------------
// 公開 API
// ---------------------------------------------------------------------

/** まだ一度も学習していないカードのメモリ状態。 */
export function emptyMemory() {
  return { stability: 0, difficulty: 0 };
}

/**
 * 1 回の復習を反映した新しいメモリ状態を返す（純粋関数）。
 *
 * @param {{stability:number,difficulty:number}|null} memory 現在の記憶状態
 * @param {number} grade       RATING の値（1-4）
 * @param {number} elapsedDays 前回復習からの経過日数（初回は 0）
 * @param {number[]} w         FSRS パラメータ
 */
export function nextMemoryState(memory, grade, elapsedDays, w = DEFAULT_PARAMS) {
  const g = clamp(Math.round(grade), RATING.AGAIN, RATING.EASY);

  // 初回学習：パラメータから直接 S・D を決める
  if (!memory || !(memory.stability > 0)) {
    return {
      stability:  clamp(initialStability(w, g), MIN_STABILITY, 36500),
      difficulty: initialDifficulty(w, g),
    };
  }

  const { stability: s, difficulty: d } = memory;
  const difficulty = nextDifficulty(w, d, g);

  // 同日中の再復習は経過日数からは何も学べないため、短期式を使う
  let stability;
  if (elapsedDays < 1) {
    stability = stabilityShortTerm(w, s, g);
  } else {
    const r = retrievability(elapsedDays, s, w);
    stability = g === RATING.AGAIN
      ? stabilityAfterForget(w, difficulty, s, r)
      : stabilityAfterRecall(w, difficulty, s, r, g);
  }

  return {
    stability:  clamp(stability, MIN_STABILITY, 36500),
    difficulty,
  };
}

/**
 * 間隔の揺らぎ（fuzz）。同じ日に大量のカードが集中するのを防ぐ。
 * 決定的にしたい場合は seed を渡す。
 */
export function applyFuzz(interval, seed = null) {
  if (interval < 2.5) return interval;
  const ratio = interval < 7 ? 0.15 : interval < 20 ? 0.10 : 0.05;
  const delta = interval * ratio;
  const rand  = seed === null ? Math.random() : mulberry32(seed)();
  return interval + delta * (rand * 2 - 1);
}

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * メモリ状態から次回間隔（日）を求める。
 * 1 日未満（＝当日中にもう一度やるべき）の場合は 1 未満の小数を返す。
 */
export function scheduleInterval(memory, config = DEFAULT_CONFIG) {
  const w = config.params ?? DEFAULT_PARAMS;
  const raw = intervalForRetention(memory.stability, config.desiredRetention, w);
  if (raw < 1) return Math.max(raw, 1 / 1440); // 最短 1 分
  const fuzzed = config.enableFuzz ? applyFuzz(raw) : raw;
  return clamp(Math.round(fuzzed), 1, config.maximumInterval ?? 365);
}

/**
 * 4 つの評価それぞれについて次回間隔を先読みする。
 * 学習者に「今どれを押すと次はいつか」を提示するために使う
 * （メタ認知支援 — 自分の記憶状態を見積もる力が学習効率を上げる）。
 */
export function previewIntervals(memory, elapsedDays, config = DEFAULT_CONFIG) {
  const w = config.params ?? DEFAULT_PARAMS;
  const out = {};
  for (const g of [RATING.AGAIN, RATING.HARD, RATING.GOOD, RATING.EASY]) {
    const next = nextMemoryState(memory, g, elapsedDays, w);
    // プレビューは fuzz なし（毎回表示が変わると混乱するため）
    out[g] = scheduleInterval(next, { ...config, enableFuzz: false });
  }
  return out;
}
