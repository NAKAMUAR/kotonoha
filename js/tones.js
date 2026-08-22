// =====================================================================
// 言の葉 / Kotonoha — ベトナム語 6 声調
//
// ベトナム語の声調は綴りで完全に決まる（発音記号を別途用意する必要がない）。
// Unicode の結合文字へ分解すれば、既存の語彙データ 300 語すべてから
// 声調を機械的に取り出せる。手作業のアノテーションは不要。
//
//   ́  U+0301 acute       → sắc   (高く上昇)
//   ̀  U+0300 grave       → huyền (低く下降)
//   ̉  U+0309 hook above  → hỏi   (下降してから上昇)
//   ̃  U+0303 tilde       → ngã   (上昇＋声門の途切れ)
//   ̣  U+0323 dot below   → nặng  (低く短く詰まる)
//   （なし）              → ngang (中くらいで平坦)
//
// 注意: â ê ô ă ơ ư が持つ ̂ ̆ ̛ は母音の種類を表す記号であって
// 声調記号ではない。ここでは上記 5 つだけを声調として扱う。
// =====================================================================

export const TONE_MARKS = Object.freeze({
  '́': 'sac',
  '̀': 'huyen',
  '̉': 'hoi',
  '̃': 'nga',
  '̣': 'nang',
});

/**
 * 6 声調の定義。
 *
 * contour は「半音スケールに正規化した F0 の目標形」。
 * 発話内平均を 0 とした相対値なので、声の高さに関係なく使える。
 * 値はベトナム語（ハノイ方言）の記述音声学で一般に示される
 * 輪郭を、半音スケールへ写したもの。
 *
 * glottal は声門閉鎖の期待値（0-1）。
 */
export const TONES = Object.freeze({
  ngang: {
    id: 'ngang', label: 'ngang', mark: '（記号なし）', example: 'ma',
    jp: '平らに保つ', description: '中くらいの高さで、上げも下げもせず平坦に伸ばします。',
    contour: [0.4, 0.5, 0.5, 0.4, 0.3, 0.2], glottal: 0.05,
  },
  huyen: {
    id: 'huyen', label: 'huyền', mark: '̀ (à)', example: 'mà',
    jp: '低く下降', description: '低めの高さから始め、さらにゆっくり下げていきます。',
    contour: [-1.5, -2.5, -3.5, -4.5, -5.5, -6.5], glottal: 0.05,
  },
  sac: {
    id: 'sac', label: 'sắc', mark: '́ (á)', example: 'má',
    jp: '高く上昇', description: '中くらいから始め、はっきりと上げきります。',
    contour: [0.0, 1.0, 2.5, 4.5, 6.5, 8.0], glottal: 0.10,
  },
  nang: {
    id: 'nang', label: 'nặng', mark: '̣ (ạ)', example: 'mạ',
    jp: '低く詰まる', description: '低く短く発音し、最後を喉で止めるように切ります。',
    contour: [-1.5, -3.0, -4.5, -6.0, -7.0, -7.5], glottal: 0.65,
  },
  hoi: {
    id: 'hoi', label: 'hỏi', mark: '̉ (ả)', example: 'mả',
    jp: '下げてから上げる', description: 'いったん下げてから、また少し上げ戻します。谷を作る意識で。',
    contour: [-0.5, -2.0, -3.5, -3.5, -2.0, -0.5], glottal: 0.15,
  },
  nga: {
    id: 'nga', label: 'ngã', mark: '̃ (ã)', example: 'mã',
    jp: '途切れて上昇', description: '上げる途中で声を一瞬詰まらせ、そのあと高く上げます。',
    contour: [0.0, -1.0, -1.5, 2.0, 5.0, 7.0], glottal: 0.60,
  },
});

export const TONE_IDS = Object.freeze(Object.keys(TONES));

// 照合用テンプレート。TONES.contour は「低い/高い」が直感的に分かる
// 記述用の値なので声調ごとに平均が違う。単独音節の録音からは絶対的な
// 高さを復元できない（話者の基準音がわからない）ため、比較の際は
// 両辺とも平均 0・等長の形状ベクトルへそろえる。
let shapeCache = null;

export function toneShapes(toShape) {
  if (shapeCache) return shapeCache;
  shapeCache = {};
  for (const id of TONE_IDS) shapeCache[id] = toShape(TONES[id].contour);
  return shapeCache;
}

/**
 * ベトナム語の音節（または語）から声調 ID を取り出す。
 * 複数音節なら音節ごとの配列を返す。
 */
export function tonesOf(text) {
  if (!text) return [];
  return String(text)
    .split(/\s+/)
    .filter(Boolean)
    .map((syllable) => toneOfSyllable(syllable));
}

/** 1 音節の声調を返す。声調記号が無ければ ngang。 */
export function toneOfSyllable(syllable) {
  const decomposed = String(syllable).normalize('NFD');
  for (const ch of decomposed) {
    const tone = TONE_MARKS[ch];
    if (tone) return tone;
  }
  return 'ngang';
}

/** 声調記号を取り除いた綴りを返す（同綴り異声調の比較に使う）。 */
export function stripTone(text) {
  return String(text)
    .normalize('NFD')
    .split('')
    .filter((ch) => !TONE_MARKS[ch])
    .join('')
    .normalize('NFC');
}

/** ベトナム語らしい文字が含まれているか（声調練習の対象判定用）。 */
export function looksVietnamese(text) {
  return /[ăâđêôơưĂÂĐÊÔƠƯ]/.test(text) ||
         Object.keys(TONE_MARKS).some((m) => String(text).normalize('NFD').includes(m));
}

// ---------------------------------------------------------------------
// 採点
// ---------------------------------------------------------------------

// 輪郭距離と声門閉鎖差の重み。合成音声での検証では、声門の重みを
// 上げると nặng/ngã の取り違えが解消した。
const W_GLOTTAL = 1.6;

// 目標と違う声調に聞こえた場合の上限点。
const UNMATCHED_MAX_SCORE = 45;

/**
 * 解析結果がどの声調に最も近いかを判定する。
 *
 * @param {{contour:number[], glottal:number}} analysis pitch.analyze の結果
 * @param {(c:number[], p:number)=>number[]} resample  pitch.resample
 * @param {(a:number[], b:number[])=>number} dtw       pitch.dtw
 */
export function classifyTone(analysis, toShape, dtw) {
  const shape = analysis?.shape ?? (analysis?.contour ? toShape(analysis.contour) : null);
  if (!shape) return null;

  const templates = toneShapes(toShape);
  const scores = TONE_IDS.map((id) => {
    const tone = TONES[id];
    const distance =
      dtw(shape, templates[id]) +
      W_GLOTTAL * Math.abs((analysis.glottal ?? 0) - tone.glottal);
    return { id, distance };
  }).sort((a, b) => a.distance - b.distance);

  return {
    best:     scores[0].id,
    distance: scores[0].distance,
    ranking:  scores,
    // 1 位と 2 位の差。小さいほど「どっちつかず」の発音。
    margin:   scores[1].distance - scores[0].distance,
  };
}

/** 距離を 0-100 点へ写す。3.0 以上離れたら 0 点。 */
export function distanceToScore(distance) {
  if (!Number.isFinite(distance)) return 0;
  return Math.round(Math.max(0, Math.min(100, 100 * (1 - distance / 3.0))));
}

/**
 * 目標の声調に対して発音を採点し、日本語の助言を返す。
 *
 * @param {string} targetId  目標の声調 ID
 * @param {object} analysis  pitch.analyze の結果
 * @param {object} helpers   { resample, dtw }
 */
export function scorePronunciation(targetId, analysis, { toShape, resample, dtw }) {
  const target = TONES[targetId];
  if (!target) return { ok: false, reason: 'unknown-tone' };

  if (!analysis?.ok) {
    return {
      ok: false,
      reason: 'no-voice',
      advice: '声が検出できませんでした。マイクに近づいて、母音を少し長めに伸ばしてみてください。',
    };
  }

  const shape = analysis.shape ?? toShape(analysis.contour);
  const distance = dtw(shape, toneShapes(toShape)[targetId]);
  const glottalGap = (analysis.glottal ?? 0) - target.glottal;
  const total = distance + W_GLOTTAL * Math.abs(glottalGap);

  const classified = classifyTone(analysis, toShape, dtw);
  const matched = classified?.best === targetId;

  // 別の声調に聞こえる発音は、ベトナム語では別の単語になってしまう。
  // 輪郭が惜しくても高得点にはしない。
  const raw = distanceToScore(total);
  const score = matched ? raw : Math.min(raw, UNMATCHED_MAX_SCORE);

  return {
    ok: true,
    score,
    matched,
    heardAs:    classified?.best ?? null,
    margin:     classified?.margin ?? 0,
    distance:   total,
    userShape:     shape,
    targetShape:   toneShapes(toShape)[targetId],
    targetContour: target.contour,
    glottal:    analysis.glottal,
    advice:     buildAdvice(targetId, analysis, classified, glottalGap, shape),
  };
}

/**
 * 具体的な直し方を日本語で返す。
 * 「もう一度」だけでは学習者は何を変えればよいか分からないため、
 * ずれの方向（上げ足りない／途切れていない等）まで言語化する。
 */
function buildAdvice(targetId, analysis, classified, glottalGap, shape) {
  const target = TONES[targetId];
  const heard  = classified?.best;

  if (heard === targetId) {
    if (classified.margin < 0.25) {
      return `${target.label} と聞こえましたが、${TONES[classified.ranking[1].id].label} との差が小さいです。${target.description}`;
    }
    return `${target.label} として聞き取れました。`;
  }

  // 声門閉鎖の不足・過剰は最優先で指摘する（nặng / ngã の要）
  if (target.glottal > 0.4 && glottalGap < -0.25) {
    return `声の途切れ（喉の詰め）が足りません。${target.label} は${target.description}`;
  }
  if (target.glottal < 0.2 && glottalGap > 0.35) {
    return `途中で声が途切れています。${target.label} は最後まで声を切らずに出します。`;
  }

  // 輪郭の向きのずれを言語化する
  const userSlope   = shape[shape.length - 1] - shape[0];
  const targetSlope = target.contour[target.contour.length - 1] - target.contour[0];

  if (targetSlope > 2 && userSlope < targetSlope - 1.5) {
    return `上がりきっていません。${target.label} は${target.description}`;
  }
  if (targetSlope < -2 && userSlope > targetSlope + 1.5) {
    return `下がりきっていません。${target.label} は${target.description}`;
  }
  if (Math.abs(targetSlope) < 1.5 && Math.abs(userSlope) > 2.5) {
    return `高さが動きすぎています。${target.label} は${target.description}`;
  }

  const heardLabel = heard ? TONES[heard].label : '別の声調';
  return `${heardLabel} に近く聞こえました。${target.label} は${target.description}`;
}
