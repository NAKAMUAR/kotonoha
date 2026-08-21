// =====================================================================
// 言の葉 / Kotonoha — SRS スケジューラ（FSRS-6 ベース）
//
// v2: SM-2 → FSRS-6 へ移行。
//
// 旧実装（SM-2, 1988）の限界:
//   ・忘却曲線を持たず「間隔 × ease」の乗算のみ。
//   ・復習が遅れた／早すぎた場合の情報を捨てていた。
//   ・3 段階評価では「思い出せなかった」と「苦しかったが思い出せた」を
//     区別できず、両者が同じラプス扱いになっていた。
//
// v2 で導入した学習科学上の仕組み:
//   1. FSRS-6 の DSR モデル（fsrs.js）
//   2. 4 段階評価（Again / Hard / Good / Easy）
//   3. 学習ステップ — 初回学習日は当日中に複数回想起させて定着させる
//   4. 再学習ステップ — 忘れた単語は当日中に立て直してから間隔を再開
//   5. リーチ検出 — 何度も忘れる単語を隔離して学習時間の浪費を防ぐ
//   6. 目標記憶率の可変化 — 学習者が復習量と保持率を選べる
// =====================================================================

import {
  RATING,
  RATING_LABELS,
  CARD_STATE,
  DEFAULT_CONFIG,
  DEFAULT_PARAMS,
  emptyMemory,
  nextMemoryState,
  scheduleInterval,
  previewIntervals,
  retrievability,
} from './fsrs.js';

export { RATING, RATING_LABELS, CARD_STATE, DEFAULT_CONFIG, DEFAULT_PARAMS, retrievability };

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_MIN = 60 * 1000;

// 学習ステップ（分）。初回学習日に当日中これだけ間隔をあけて再提示する。
// 短い間隔での反復（spaced practice）は、まとめて 3 回見る（massed practice）
// より初期定着が有意に良い。
export const LEARNING_STEPS   = [1, 10];
export const RELEARNING_STEPS = [10];

// この回数忘れた単語はリーチ（leech）として隔離候補にする。
export const LEECH_THRESHOLD = 8;

// 「習得済」とみなす間隔（日）。
export const MASTERED_INTERVAL = 21;

/**
 * 旧 3 段階 UI との互換用エイリアス。
 * 旧データや旧イベントハンドラから 2/4/5 が来ても壊れないようにする。
 * @deprecated RATING を使うこと
 */
export const QUALITY = Object.freeze({
  HARD:   RATING.HARD,
  NORMAL: RATING.GOOD,
  EASY:   RATING.EASY,
});

/** 旧 SM-2 の quality (0-5) を FSRS の 4 段階へ写像する。 */
export function normalizeRating(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return RATING.GOOD;
  if (n >= RATING.AGAIN && n <= RATING.EASY) return Math.round(n);
  if (n < 3) return RATING.AGAIN; // SM-2 の失敗域
  if (n === 3) return RATING.HARD;
  if (n === 4) return RATING.GOOD;
  return RATING.EASY;
}

// ---------------------------------------------------------------------
// 状態
// ---------------------------------------------------------------------

export function newSrsState() {
  return {
    stability:      0,
    difficulty:     0,
    state:          CARD_STATE.NEW,
    step:           0,        // 学習／再学習ステップの位置
    reps:           0,
    lapses:         0,
    leech:          false,
    scheduledDays:  0,        // 直近に割り当てた間隔（日）
    elapsedDays:    0,        // 直近復習時点での経過日数
    lastReviewedAt: null,
    nextReviewDate: Date.now(),
    version:        2,
  };
}

/**
 * v1（SM-2）の状態を FSRS のメモリ状態へ変換する。
 * 既存ユーザーの学習履歴を捨てずに引き継ぐための一度きりの変換。
 *
 *   ・interval（日）は「その日数を空けても思い出せていた」ことを意味するので
 *     安定度 S の近似値として使える。
 *   ・easeFactor は覚えやすさの指標なので、難易度 D へ反転して写像する。
 *     EF 2.5（易しい）→ D 3.5 / EF 1.3（難しい）→ D 10。
 */
export function migrateFromSm2(old) {
  const base = newSrsState();
  if (!old) return base;
  if (old.version >= 2) return { ...base, ...old };

  const interval = Number(old.interval) || 0;
  const ef       = Number(old.easeFactor) || 2.5;
  const reps     = Number(old.repetitions) || 0;
  const lapses   = Number(old.lapses) || 0;

  const stability  = reps === 0 ? 0 : Math.max(interval, 0.5);
  const efRatio    = Math.min(Math.max((ef - 1.3) / (2.5 - 1.3), 0), 1);
  const difficulty = reps === 0 ? 0 : +(10 - efRatio * 6.5).toFixed(3);

  let state = CARD_STATE.NEW;
  if (reps > 0) state = reps < 2 ? CARD_STATE.LEARNING : CARD_STATE.REVIEW;

  return {
    ...base,
    stability:      +stability.toFixed(4),
    difficulty,
    state,
    step:           state === CARD_STATE.LEARNING ? Math.min(reps, LEARNING_STEPS.length - 1) : 0,
    reps,
    lapses,
    leech:          lapses >= LEECH_THRESHOLD,
    scheduledDays:  interval,
    lastReviewedAt: old.lastReviewedAt ?? null,
    nextReviewDate: old.nextReviewDate ?? Date.now(),
    version:        2,
  };
}

/** 保存済み状態を必ず v2 形式で取り出す。 */
export function ensureState(state) {
  if (!state) return newSrsState();
  if (state.version >= 2) return state;
  return migrateFromSm2(state);
}

// ---------------------------------------------------------------------
// スケジューリング
// ---------------------------------------------------------------------

function elapsedDaysOf(state, now) {
  if (!state.lastReviewedAt) return 0;
  return Math.max(0, (now - state.lastReviewedAt) / MS_PER_DAY);
}

/**
 * 1 回の評価を適用して次の状態を返す（純粋関数）。
 *
 * 学習フェーズごとの扱い:
 *   NEW / LEARNING … 学習ステップを進める。最後のステップを通過して初めて
 *                    日単位の復習へ「卒業」する。Easy は即卒業。
 *   REVIEW         … Again ならラプスとして再学習ステップへ落とす。
 *                    それ以外は FSRS の算出間隔をそのまま採用。
 *   RELEARNING     … 再学習ステップを通過したら復習へ復帰。
 *
 * @param {object} rawState 現在の SRS 状態（v1 でも可）
 * @param {number} rating   RATING の値（1-4）
 * @param {object} config   目標記憶率などの設定
 * @param {number} now      現在時刻（テスト用に注入可能）
 */
export function applyReview(rawState, rating, config = DEFAULT_CONFIG, now = Date.now()) {
  const state = ensureState(rawState);
  const grade = normalizeRating(rating);
  const cfg   = { ...DEFAULT_CONFIG, ...config };

  const elapsed = elapsedDaysOf(state, now);
  const memory  = state.stability > 0
    ? { stability: state.stability, difficulty: state.difficulty }
    : emptyMemory();

  // 記憶状態は、どのフェーズでも必ず更新する（学習ステップ中の反応も情報）
  const nextMemory = nextMemoryState(memory, grade, elapsed, cfg.params);

  const wasReview = state.state === CARD_STATE.REVIEW;
  const isLapse   = wasReview && grade === RATING.AGAIN;

  let phase = state.state;
  let step  = state.step;
  let dueMs;
  let scheduledDays = 0;

  if (phase === CARD_STATE.NEW || phase === CARD_STATE.LEARNING) {
    const result = advanceSteps(LEARNING_STEPS, step, grade);
    if (result.graduated) {
      phase = CARD_STATE.REVIEW;
      step  = 0;
      scheduledDays = scheduleInterval(nextMemory, cfg);
      dueMs = scheduledDays * MS_PER_DAY;
    } else {
      phase = CARD_STATE.LEARNING;
      step  = result.step;
      dueMs = LEARNING_STEPS[step] * MS_PER_MIN;
    }
  } else if (phase === CARD_STATE.RELEARNING) {
    const result = advanceSteps(RELEARNING_STEPS, step, grade);
    if (result.graduated) {
      phase = CARD_STATE.REVIEW;
      step  = 0;
      scheduledDays = scheduleInterval(nextMemory, cfg);
      dueMs = scheduledDays * MS_PER_DAY;
    } else {
      step  = result.step;
      dueMs = RELEARNING_STEPS[step] * MS_PER_MIN;
    }
  } else if (isLapse) {
    // 忘れた単語をいきなり数日後に回しても定着しない。
    // まず当日中に再学習ステップで立て直す。
    phase = CARD_STATE.RELEARNING;
    step  = 0;
    dueMs = RELEARNING_STEPS[0] * MS_PER_MIN;
  } else {
    scheduledDays = scheduleInterval(nextMemory, cfg);
    dueMs = scheduledDays * MS_PER_DAY;
  }

  const lapses = state.lapses + (isLapse ? 1 : 0);

  return {
    stability:      +nextMemory.stability.toFixed(4),
    difficulty:     +nextMemory.difficulty.toFixed(4),
    state:          phase,
    step,
    reps:           state.reps + 1,
    lapses,
    leech:          lapses >= LEECH_THRESHOLD,
    scheduledDays,
    elapsedDays:    +elapsed.toFixed(4),
    lastReviewedAt: now,
    nextReviewDate: now + dueMs,
    version:        2,
  };
}

/** 学習ステップ内での遷移を決める。 */
function advanceSteps(steps, currentStep, grade) {
  switch (grade) {
    case RATING.AGAIN:
      return { graduated: false, step: 0 };            // 最初のステップへ戻す
    case RATING.HARD:
      return { graduated: false, step: currentStep };  // 同じステップを繰り返す
    case RATING.EASY:
      return { graduated: true, step: 0 };             // 即卒業
    case RATING.GOOD:
    default: {
      const next = currentStep + 1;
      return next >= steps.length
        ? { graduated: true, step: 0 }
        : { graduated: false, step: next };
    }
  }
}

/** 旧 API 名。既存の呼び出し元との互換のため残す。 */
export const applySrs = applyReview;

// ---------------------------------------------------------------------
// 問い合わせ
// ---------------------------------------------------------------------

/**
 * 表示用の学習ステータス。
 *   new      … 未学習
 *   learning … 学習中／再学習中（当日ステップ）
 *   review   … 復習段階
 *   mastered … 習得済（間隔 21 日以上）
 */
export function statusOf(rawState) {
  if (!rawState) return 'new';
  const s = ensureState(rawState);
  if (s.reps === 0 || s.state === CARD_STATE.NEW) return 'new';
  if (s.state === CARD_STATE.LEARNING || s.state === CARD_STATE.RELEARNING) return 'learning';
  if (s.scheduledDays >= MASTERED_INTERVAL) return 'mastered';
  return 'review';
}

export function isDue(rawState, now = Date.now()) {
  if (!rawState) return true;
  return ensureState(rawState).nextReviewDate <= now;
}

/**
 * 今この瞬間の想起率。復習キューの優先度付けに使う。
 * 「最も忘れかけている単語から先に出す」ことで、同じ復習回数でも
 * 取りこぼしを減らせる。
 */
export function currentRetrievability(rawState, config = DEFAULT_CONFIG, now = Date.now()) {
  if (!rawState) return 0;
  const s = ensureState(rawState);
  if (!(s.stability > 0)) return 0;
  return retrievability(elapsedDaysOf(s, now), s.stability, config.params ?? DEFAULT_PARAMS);
}

/**
 * 4 段階それぞれを押したときの次回間隔（日）。
 * ボタン上に表示して、学習者が自分の記憶を見積もれるようにする。
 */
export function previewFor(rawState, config = DEFAULT_CONFIG, now = Date.now()) {
  const state = ensureState(rawState);
  const cfg   = { ...DEFAULT_CONFIG, ...config };
  const memory = state.stability > 0
    ? { stability: state.stability, difficulty: state.difficulty }
    : emptyMemory();

  const inLearning =
    state.state === CARD_STATE.NEW ||
    state.state === CARD_STATE.LEARNING ||
    state.state === CARD_STATE.RELEARNING;

  const daily = previewIntervals(memory, elapsedDaysOf(state, now), cfg);

  if (!inLearning) {
    return {
      [RATING.AGAIN]: RELEARNING_STEPS[0] / 1440, // ラプスは当日再学習
      [RATING.HARD]:  daily[RATING.HARD],
      [RATING.GOOD]:  daily[RATING.GOOD],
      [RATING.EASY]:  daily[RATING.EASY],
    };
  }

  const steps = state.state === CARD_STATE.RELEARNING ? RELEARNING_STEPS : LEARNING_STEPS;
  const stepMinutes = (i) => steps[Math.min(i, steps.length - 1)] / 1440;
  const nextStep = state.step + 1;

  return {
    [RATING.AGAIN]: stepMinutes(0),
    [RATING.HARD]:  stepMinutes(state.step),
    [RATING.GOOD]:  nextStep >= steps.length ? daily[RATING.GOOD] : stepMinutes(nextStep),
    [RATING.EASY]:  daily[RATING.EASY],
  };
}

/** 間隔（日、小数可）を日本語ラベルにする。 */
export function formatInterval(days) {
  if (!Number.isFinite(days) || days <= 0) return '—';
  if (days < 1 / 24) return `${Math.max(1, Math.round(days * 1440))}分`;
  if (days < 1)      return `${Math.round(days * 24)}時間`;
  if (days < 30)     return `${Math.round(days)}日`;
  if (days < 365)    return `${(days / 30).toFixed(1)}ヶ月`;
  return `${(days / 365).toFixed(1)}年`;
}
