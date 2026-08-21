// =====================================================================
// 言の葉 / Kotonoha — FSRS パラメータ個人最適化
//
// 既定の 21 パラメータは「多数派の記憶」に合わせた汎用値でしかない。
// 実際の忘却の速さは人によっても教材によっても違うため、
// 自分の復習ログに合わせて係数を推定し直すと予測精度が上がる。
// 予測が当たるほど、同じ復習回数での取りこぼしが減る。
//
// 手法:
//   ・各単語の復習系列を FSRS で再生し、復習時点の想起率 R を予測する。
//   ・実際の結果（もう一度 = 失敗 / それ以外 = 成功）との
//     二値交差エントロピー（対数損失）を最小化する。
//   ・勾配は中心差分で近似し、Adam で更新する。
//     21 次元と小さく、ブラウザ内で完結させるには自動微分より簡単で堅い。
//
// 参考: https://github.com/open-spaced-repetition/fsrs-rs
// =====================================================================

import {
  RATING,
  DEFAULT_PARAMS,
  nextMemoryState,
  retrievability,
} from './fsrs.js';

// 最適化を許可する最小復習数。
// 合成データでの計測では、640 件では既定値を上回れず（棄却される）、
// 1600 件を超えると検証データ上でも安定して改善した。
export const MIN_REVIEWS = 1000;

// 学習に使う単語数の上限。21 パラメータ × 中心差分の反復なので
// 計算量が復習数に比例する。端末上で現実的な時間に収めるための上限。
export const MAX_TRAIN_WORDS = 1200;

// 採用に必要な対数損失の最小改善率（0.5%）。
const MIN_GAIN = 0.005;
// 較正誤差の許容悪化幅（10%）。検証データが小さいと階級の揺らぎが出るため。
const RMSE_TOLERANCE = 0.10;

/** 各パラメータの探索範囲。FSRS の式が破綻しない領域に制限する。 */
const BOUNDS = [
  [0.01, 40],  [0.01, 40],  [0.01, 40],  [0.01, 40],  // w0-3 初期安定度（評価別）
  [1.0, 10],   [0.001, 4],                            // w4-5 初期難易度
  [0.001, 4],  [0.001, 0.75],                         // w6-7 難易度の増減・平均回帰
  [0.0, 4.5],  [0.0, 0.8],   [0.001, 3.5],            // w8-10 想起成功時の安定度
  [0.001, 5],  [0.001, 0.25], [0.001, 0.9], [0.0, 4], // w11-14 忘却時の安定度
  [0.0, 1.0],  [1.0, 6.0],                            // w15-16 Hard 減衰 / Easy 加算
  [0.0, 2.0],  [0.0, 2.0],   [0.0, 0.8],              // w17-19 同日再学習
  [0.1, 0.8],                                         // w20 忘却曲線の decay
];

const clamp = (x, lo, hi) => Math.min(Math.max(x, lo), hi);

function clampParams(w) {
  return w.map((v, i) => {
    const [lo, hi] = BOUNDS[i];
    return Number.isFinite(v) ? clamp(v, lo, hi) : DEFAULT_PARAMS[i];
  });
}

// ---------------------------------------------------------------------
// 学習データの構築
// ---------------------------------------------------------------------

/**
 * 復習ログを単語ごとの時系列に組み直す。
 *
 * 各系列は先頭から FSRS を再生できる必要があるため、
 * 「初回の復習から途切れずに記録されている単語」だけを採用する。
 * v1 時代から使っていてログが途中から始まる単語は、初期状態が
 * 不明なので学習データにすると誤った係数を学んでしまう。
 *
 * @param {Array} logs reviewLog の全レコード
 * @returns {Array<{wordId:string, reviews:Array<{rating:number, elapsedDays:number}>}>}
 */
export function buildTrainingSet(logs) {
  const byWord = new Map();
  for (const l of logs) {
    if (!l || typeof l.rating !== 'number') continue;
    if (!byWord.has(l.wordId)) byWord.set(l.wordId, []);
    byWord.get(l.wordId).push(l);
  }

  const sequences = [];
  for (const [wordId, entries] of byWord) {
    entries.sort((a, b) => a.reviewedAt - b.reviewedAt);

    // 初回が「新規状態からの復習」でない系列は再生できないので捨てる
    if (entries[0].stateBefore !== 'new') continue;

    const reviews = entries.map((e) => ({
      rating:      clamp(Math.round(e.rating), RATING.AGAIN, RATING.EASY),
      elapsedDays: Math.max(0, Number(e.elapsedDays) || 0),
    }));
    if (reviews.length >= 2) sequences.push({ wordId, reviews });
  }
  return sequences;
}

export function countReviews(sequences) {
  // 初回復習は予測対象にならない（それ以前の記憶状態が無いため）
  return sequences.reduce((n, s) => n + s.reviews.length - 1, 0);
}

// ---------------------------------------------------------------------
// 損失
// ---------------------------------------------------------------------

const EPS = 1e-7;

/**
 * 対数損失と較正指標をまとめて計算する。
 *
 * logLoss … 小さいほど予測が当たっている
 * rmse    … 予測確率を階級に分けた較正誤差。Anki の "RMSE(bins)" 相当。
 *           「90% と言ったときに本当に 90% 当たるか」を測る。
 */
export function evaluate(params, sequences) {
  const w = clampParams(params);
  let loss = 0;
  let n = 0;

  // 較正用の階級（予測確率 0.0-0.1, 0.1-0.2, ... の 10 段階）
  const binPred = new Array(10).fill(0);
  const binReal = new Array(10).fill(0);
  const binCnt  = new Array(10).fill(0);

  for (const seq of sequences) {
    let memory = null;
    for (let i = 0; i < seq.reviews.length; i++) {
      const { rating, elapsedDays } = seq.reviews[i];

      if (memory) {
        // 予測: この時点で思い出せる確率
        const p = clamp(retrievability(elapsedDays, memory.stability, w), EPS, 1 - EPS);
        const y = rating === RATING.AGAIN ? 0 : 1;

        loss += -(y * Math.log(p) + (1 - y) * Math.log(1 - p));
        n += 1;

        const b = Math.min(9, Math.floor(p * 10));
        binPred[b] += p;
        binReal[b] += y;
        binCnt[b]  += 1;
      }

      memory = nextMemoryState(memory, rating, elapsedDays, w);
    }
  }

  if (n === 0) return { logLoss: Infinity, rmse: Infinity, count: 0 };

  let se = 0, tot = 0;
  for (let b = 0; b < 10; b++) {
    if (!binCnt[b]) continue;
    const diff = binPred[b] / binCnt[b] - binReal[b] / binCnt[b];
    se  += diff * diff * binCnt[b];
    tot += binCnt[b];
  }

  return {
    logLoss: loss / n,
    rmse:    Math.sqrt(se / tot),
    count:   n,
  };
}

function lossOf(params, sequences) {
  return evaluate(params, sequences).logLoss;
}

// ---------------------------------------------------------------------
// 最適化（Adam + 中心差分）
// ---------------------------------------------------------------------

const DEFAULT_OPTS = Object.freeze({
  iterations:   120,
  learningRate: 0.02,  // 正規化空間での歩幅
  beta1:        0.9,
  beta2:        0.999,
  epsilon:      1e-8,
  h:            1e-4,  // 数値微分の刻み幅
  patience:     20,    // これだけ改善しなければ打ち切る
  minLr:        1e-4,
});

/**
 * 復習ログから個人パラメータを推定する。
 *
 * validation を渡すと、採否の判断だけをそちらで行う（過学習の検出）。
 * 学習に使ったデータで良くなるのは当たり前なので、
 * 「見ていないデータでも当たるか」を採用条件にする。
 *
 * @param {Array} sequences  学習に使う系列
 * @param {object} options   validation を含む設定
 * @param {(p:{iteration:number,total:number,logLoss:number}) => void} onProgress
 * @returns {{params:number[], improved:boolean, before:object, after:object, iterations:number}}
 */
export function optimize(sequences, options = {}, onProgress = null) {
  const opts = { ...DEFAULT_OPTS, ...options };
  const start = clampParams(options.initialParams ?? DEFAULT_PARAMS);
  const holdout = options.validation?.length ? options.validation : null;

  const before = evaluate(DEFAULT_PARAMS, holdout ?? sequences);
  if (!Number.isFinite(before.logLoss) || before.count === 0) {
    return { params: [...DEFAULT_PARAMS], improved: false, before, after: before, iterations: 0 };
  }

  const n = start.length;

  // パラメータごとに値域が 0.001〜40 と桁違いなので、[0,1] へ正規化して
  // 探索する。そうしないと値域の広い係数だけが暴れて収束しない。
  const toZ = (w) => w.map((v, i) => (v - BOUNDS[i][0]) / (BOUNDS[i][1] - BOUNDS[i][0]));
  const toW = (z) => z.map((v, i) => {
    const [lo, hi] = BOUNDS[i];
    return clamp(lo + v * (hi - lo), lo, hi);
  });

  let z  = toZ(start);
  const m = new Array(n).fill(0);
  const v = new Array(n).fill(0);

  let lr       = opts.learningRate;
  let best     = start.slice();
  let bestLoss = lossOf(start, sequences);
  let prevLoss = bestLoss;
  let stale    = 0;
  let done     = 0;

  for (let t = 1; t <= opts.iterations; t++) {
    done = t;
    const wNow = toW(z);

    // 正規化空間での中心差分
    const grad = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      const up = z.slice(); up[i] = clamp(z[i] + opts.h, 0, 1);
      const dn = z.slice(); dn[i] = clamp(z[i] - opts.h, 0, 1);
      const span = up[i] - dn[i];
      if (span === 0) continue;
      grad[i] = (lossOf(toW(up), sequences) - lossOf(toW(dn), sequences)) / span;
    }

    // Adam 更新
    const zNext = z.slice();
    for (let i = 0; i < n; i++) {
      m[i] = opts.beta1 * m[i] + (1 - opts.beta1) * grad[i];
      v[i] = opts.beta2 * v[i] + (1 - opts.beta2) * grad[i] * grad[i];
      const mHat = m[i] / (1 - Math.pow(opts.beta1, t));
      const vHat = v[i] / (1 - Math.pow(opts.beta2, t));
      zNext[i] = clamp(z[i] - lr * mHat / (Math.sqrt(vHat) + opts.epsilon), 0, 1);
    }

    const wNext = toW(zNext);
    const cur   = lossOf(wNext, sequences);

    if (cur > prevLoss) {
      // 行き過ぎた。歩幅を詰めて、いま最良の点からやり直す。
      lr = Math.max(lr * 0.6, opts.minLr);
      z = toZ(best);
      stale += 1;
    } else {
      z = zNext;
      prevLoss = cur;
      if (cur < bestLoss - 1e-6) { bestLoss = cur; best = wNext.slice(); stale = 0; }
      else stale += 1;
    }

    onProgress?.({ iteration: t, total: opts.iterations, logLoss: Math.min(cur, bestLoss) });

    if (stale >= opts.patience || lr <= opts.minLr) break; // 収束したので早期終了
  }

  void 0;
  // 採否は検証データ（学習に使っていない単語）で判断する
  const after = evaluate(best, holdout ?? sequences);

  // 採用条件は 2 つとも満たすこと:
  //   1. 対数損失が意味のある幅（0.5% 以上）改善している。
  //      ノイズ程度の差で係数を入れ替えても得はない。
  //   2. 較正誤差（RMSE）が悪化していない。
  //      logLoss だけ見ると「予測日付の当たり具合」が落ちる係数を
  //      拾ってしまうことがある。復習日の信頼性が実用上は重要なので、
  //      そこが崩れる最適化は採用しない。
  const lossOk = after.logLoss < before.logLoss * (1 - MIN_GAIN);
  const rmseOk = after.rmse <= before.rmse * (1 + RMSE_TOLERANCE);
  const improved = lossOk && rmseOk;

  return {
    params:     improved ? best.map((x) => +x.toFixed(4)) : [...DEFAULT_PARAMS],
    improved,
    // 不採用の理由。UI で「なぜ変わらなかったか」を説明するために使う。
    rejectedFor: improved ? null : (!lossOk ? 'no-gain' : 'calibration'),
    before,
    after,
    iterations: done,
  };
}

/**
 * ログ配列を受け取って最適化まで一気に行う入口。
 * データ不足の場合は理由付きで返す。
 */
export function optimizeFromLogs(logs, options = {}, onProgress = null) {
  const sequences = buildTrainingSet(logs);
  const reviews   = countReviews(sequences);

  if (reviews < MIN_REVIEWS) {
    return {
      ok:       false,
      reason:   'insufficient-data',
      reviews,
      required: MIN_REVIEWS,
    };
  }

  // 単語単位で 8:2 に分割する。同じ単語の復習が学習側と検証側に
  // またがると情報が漏れて、過学習を見逃してしまう。
  const { train, valid } = splitByWord(sequences, 0.2);

  // 学習側が大きすぎる場合は間引く。単語 ID のハッシュ順に等間隔で
  // 取るので、新しい単語だけに偏らず、実行するたびに同じ部分集合になる。
  const trainUsed = subsample(train, MAX_TRAIN_WORDS);

  const result = optimize(trainUsed, { ...options, validation: valid }, onProgress);
  return {
    ok: true,
    reviews,
    trainReviews: countReviews(trainUsed),
    validReviews: countReviews(valid),
    ...result,
  };
}

/** 単語数が上限を超える場合に、決定的に等間隔で間引く。 */
function subsample(sequences, max) {
  if (sequences.length <= max) return sequences;
  const sorted = sequences.slice().sort((a, b) => hashWord(a.wordId) - hashWord(b.wordId));
  const stride = sorted.length / max;
  const out = [];
  for (let i = 0; out.length < max && Math.floor(i) < sorted.length; i += stride) {
    out.push(sorted[Math.floor(i)]);
  }
  return out;
}

function hashWord(id) {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** wordId のハッシュで決定的に分割する（実行ごとに結果が揺れないように）。 */
function splitByWord(sequences, validRatio) {
  const train = [], valid = [];
  for (const seq of sequences) {
    const bucket = (hashWord(seq.wordId) % 1000) / 1000;
    (bucket < validRatio ? valid : train).push(seq);
  }
  // 検証側が空になった場合は分割せず、学習データで評価する
  return valid.length === 0 ? { train: sequences, valid: [] } : { train, valid };
}
