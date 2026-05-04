// =====================================================================
// 言の葉 / Kotonoha — 自前 SVG チャート
// Step 25-2: 棒グラフ (日別) と横棒グラフ (正答率) を SVG inline で生成
//
// 外部ライブラリは使わない (オフライン優先)。
// 既存色トークン (CSS var --shu / --koke / --washi 等) を attribute で参照。
// =====================================================================

const SHU      = '#c5382b';
const KOKE     = '#5a7048';
const SUMI     = '#1a1612';
const SUMI_SOFT= '#7a6f63';
const WASHI_DARK = '#ebe5d3';

function escSvg(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

/**
 * 日別の縦棒グラフ。
 * data: [{ date: 'YYYY-MM-DD', min: number }]
 * options: { width=320, height=140, max=null, label='分' }
 * 戻り値: SVG 文字列
 */
export function renderDailyBar(data, { width = 320, height = 140, max = null, label = '分' } = {}) {
  if (!data?.length) {
    return `<div class="text-xs text-sumi-soft text-center py-6">データがありません</div>`;
  }
  const padTop = 14, padBottom = 24, padLeft = 24, padRight = 8;
  const innerW = width - padLeft - padRight;
  const innerH = height - padTop - padBottom;
  const barCount = data.length;
  const barGap = 4;
  const barW = Math.max(4, (innerW - barGap * (barCount - 1)) / barCount);
  const maxValue = max ?? Math.max(1, ...data.map((d) => d.min ?? 0));

  let bars = '';
  let labels = '';
  data.forEach((d, i) => {
    const v = d.min ?? 0;
    const h = (v / maxValue) * innerH;
    const x = padLeft + i * (barW + barGap);
    const y = padTop + (innerH - h);
    bars += `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${v > 0 ? SHU : WASHI_DARK}"/>`;
    if (v > 0) {
      bars += `<text x="${(x + barW / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" font-size="9" fill="${SUMI_SOFT}" font-family="Cormorant Garamond,serif">${v}</text>`;
    }
    // 軸ラベル: 末尾の月日のみ
    const md = d.date.slice(5).replace('-', '/');
    if (i === 0 || i === data.length - 1 || (data.length <= 7) || i % Math.ceil(data.length / 7) === 0) {
      labels += `<text x="${(x + barW / 2).toFixed(1)}" y="${(height - 8).toFixed(1)}" text-anchor="middle" font-size="9" fill="${SUMI_SOFT}" font-family="Cormorant Garamond,serif">${md}</text>`;
    }
  });

  // Y 軸目盛り (上限のみ)
  const yAxis = `<text x="${padLeft - 3}" y="${(padTop + 6).toFixed(1)}" text-anchor="end" font-size="9" fill="${SUMI_SOFT}" font-family="Cormorant Garamond,serif">${Math.round(maxValue)}${label}</text>`;
  // 0 線
  const zeroLine = `<line x1="${padLeft}" y1="${padTop + innerH}" x2="${width - padRight}" y2="${padTop + innerH}" stroke="${SUMI_SOFT}" stroke-opacity="0.2" stroke-width="0.5"/>`;

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="w-full h-auto">
    ${zeroLine}
    ${bars}
    ${labels}
    ${yAxis}
  </svg>`;
}

/**
 * 正答率の横棒グラフ。
 * data: [{ key, label, accuracy: 0-1, answered }]
 */
export function renderAccuracyBars(data, { width = 320, rowHeight = 22, label = '%' } = {}) {
  if (!data?.length) {
    return `<div class="text-xs text-sumi-soft text-center py-6">まだ正答率データがありません</div>`;
  }
  const padLeft = 80, padRight = 8, padY = 4;
  const labelGap = 4;
  const innerW = width - padLeft - padRight;
  const height = data.length * (rowHeight + padY) + padY;

  let rows = '';
  data.forEach((d, i) => {
    const y = padY + i * (rowHeight + padY);
    const pct = Math.max(0, Math.min(1, d.accuracy ?? 0));
    const w = innerW * pct;
    rows += `
      <text x="${padLeft - labelGap}" y="${(y + rowHeight / 2 + 3).toFixed(1)}" text-anchor="end" font-size="11" fill="${SUMI}" font-family="Shippori Mincho,serif">${escSvg(d.label)}</text>
      <rect x="${padLeft}" y="${y.toFixed(1)}" width="${innerW}" height="${rowHeight}" rx="3" fill="${WASHI_DARK}"/>
      <rect x="${padLeft}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${rowHeight}" rx="3" fill="${pct >= 0.7 ? KOKE : SHU}"/>
      <text x="${(padLeft + innerW - 4).toFixed(1)}" y="${(y + rowHeight / 2 + 3).toFixed(1)}" text-anchor="end" font-size="10" fill="${SUMI}" font-family="Cormorant Garamond,serif" font-weight="600">${Math.round(pct * 100)}${label}</text>
    `;
  });

  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" class="w-full h-auto">
    ${rows}
  </svg>`;
}

/**
 * レベル進捗 (現レベルから次レベルへの進捗をリング状で表現)
 * level: { level, label, totalMin, nextLevel, nextThreshold, progressToNext }
 */
export function renderLevelRing(level, { size = 90 } = {}) {
  if (!level) return '';
  const cx = size / 2, cy = size / 2;
  const r = size / 2 - 6;
  const C = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, level.progressToNext ?? 0));
  const dashLen = (C * pct).toFixed(1);
  const dashGap = (C - parseFloat(dashLen)).toFixed(1);

  return `<svg viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke="${WASHI_DARK}" stroke-width="6" fill="none"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" stroke="${SHU}" stroke-width="6" fill="none"
      stroke-linecap="round"
      stroke-dasharray="${dashLen} ${dashGap}"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="22" fill="${SUMI}" font-family="Shippori Mincho,serif" font-weight="600">${level.level}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" font-size="9" fill="${SUMI_SOFT}" font-family="Cormorant Garamond,serif" letter-spacing="0.1em">LV</text>
  </svg>`;
}
