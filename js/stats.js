// =====================================================================
// 言の葉 / Kotonoha — 統計集計
// Step 25-1: 期間別集計 / 連続日数 / レベル算出
//
// データ源:
//   ・dailyTasks (kotonoha-daily / dailyTasks)        ← 完了履歴・分数
//   ・mistakes   (kotonoha-daily / mistakes)          ← 間違い件数
//   ・SRS        (kotonoha / srs)                     ← 単語進捗
//   ・TOEIC      (kotonoha-toeic / results)           ← 正答率
// =====================================================================

import { openDailyDB } from './daily-settings.js';
import { todayKey } from './daily-tasks.js';
import { getStudyStats, getAllSrsStates } from './vocabulary.js';
import { getScorePrediction } from './toeic-score.js';
import { statusOf } from './srs.js';

const DAY = 86400000;

// ---------- 内部ヘルパ ----------

async function getAllDailyDocs() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const req = idb.transaction('dailyTasks', 'readonly').objectStore('dailyTasks').getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => resolve([]);
  });
}

async function getAllMistakes() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const req = idb.transaction('mistakes', 'readonly').objectStore('mistakes').getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => resolve([]);
  });
}

function dateKeyOf(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function parseDateKey(s) {
  return new Date(s + 'T00:00');
}

// ---------- 連続学習日数 ----------

/**
 * dailyTasks 記録を見て、本日 (or 昨日) から逆算した最大連続日数を返す。
 * 「学習した日」= completedMin > 0 もしくは tasks に completed=true が 1 つ以上。
 */
export async function calculateStreak(today = new Date()) {
  const docs = await getAllDailyDocs();
  const completedDays = new Set();
  for (const d of docs) {
    const min = d.completedMin ?? 0;
    const anyCompleted = (d.tasks ?? []).some((t) => t.completed);
    if (min > 0 || anyCompleted) completedDays.add(d.date);
  }

  // 本日が未学習なら昨日から逆算 (本日にまだ完了タスクが無いだけで連続が途切れた扱いはしない)
  const todayStr = dateKeyOf(today);
  let cursor = new Date(today);
  if (!completedDays.has(todayStr)) {
    cursor = new Date(today.getTime() - DAY);
  }
  let streak = 0;
  while (completedDays.has(dateKeyOf(cursor))) {
    streak += 1;
    cursor = new Date(cursor.getTime() - DAY);
  }
  return streak;
}

// ---------- 期間別集計 ----------

/**
 * period = 'week' (直近 7 日) | 'month' (直近 30 日) | 'all'
 *
 * 戻り値:
 *   {
 *     period, startDate, endDate, daysActive, totalMin,
 *     byCategory: { vocab, scenario, 'toeic-l', 'toeic-r', 'ielts-w', grammar },
 *     dailyMin: [{ date, min }]    ← 棒グラフ用 (period 範囲全日分、ゼロも含む)
 *     accuracy: { overall, vocab, toeic },
 *     mistakesAdded, mistakesResolved
 *   }
 */
export async function getStatsForPeriod(period = 'week', today = new Date()) {
  const docs = await getAllDailyDocs();
  let days, startDate;
  if (period === 'week') days = 7;
  else if (period === 'month') days = 30;
  else days = null;     // all

  startDate = days ? new Date(today.getTime() - (days - 1) * DAY) : null;

  const inRange = (s) => {
    if (!startDate) return true;
    const d = parseDateKey(s);
    return d >= startDate && d <= today;
  };

  const filteredDocs = docs.filter((d) => inRange(d.date));

  const byCategory = {};
  let totalMin = 0;
  let daysActive = 0;
  for (const d of filteredDocs) {
    const min = d.completedMin ?? 0;
    if (min > 0) daysActive += 1;
    totalMin += min;
    for (const t of (d.tasks ?? [])) {
      if (!t.completed) continue;
      byCategory[t.type] = (byCategory[t.type] ?? 0) + (t.estimatedMin ?? 0);
    }
  }

  // 期間が固定 (week/month) なら、ゼロ埋めで日別配列を作る
  let dailyMin = [];
  if (days) {
    const docMap = new Map(filteredDocs.map((d) => [d.date, d.completedMin ?? 0]));
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * DAY);
      const k = dateKeyOf(d);
      dailyMin.push({ date: k, min: docMap.get(k) ?? 0 });
    }
  }

  // mistakes 集計 (期間内に追加 / 既に削除済 = resolved とみなす)
  const mistakes = await getAllMistakes();
  let mistakesAdded = 0;
  for (const m of mistakes) {
    const t = m.firstWrongAt ?? 0;
    if (!days || t >= startDate.getTime()) mistakesAdded += 1;
  }

  return {
    period,
    startDate: startDate ? dateKeyOf(startDate) : (filteredDocs[0]?.date ?? todayKey(today)),
    endDate:   dateKeyOf(today),
    daysActive,
    totalMin,
    byCategory,
    dailyMin,
    mistakesAdded,
  };
}

// ---------- レベル算出 ----------

const LEVEL_THRESHOLDS = [
  { level: 1,  totalMin: 0,    label: '初学' },
  { level: 2,  totalMin: 30,   label: '入門' },
  { level: 3,  totalMin: 120,  label: '初級' },
  { level: 4,  totalMin: 300,  label: '中級' },
  { level: 5,  totalMin: 600,  label: '上級' },
  { level: 6,  totalMin: 1200, label: '達人' },
  { level: 7,  totalMin: 2400, label: '師範' },
  { level: 8,  totalMin: 4800, label: '名人' },
];

export function levelFromMinutes(totalMin) {
  let cur = LEVEL_THRESHOLDS[0];
  let next = LEVEL_THRESHOLDS[1];
  for (let i = 0; i < LEVEL_THRESHOLDS.length; i++) {
    if (totalMin >= LEVEL_THRESHOLDS[i].totalMin) {
      cur = LEVEL_THRESHOLDS[i];
      next = LEVEL_THRESHOLDS[i + 1] ?? null;
    }
  }
  const progress = next ? Math.min(1, (totalMin - cur.totalMin) / (next.totalMin - cur.totalMin)) : 1;
  return {
    level:    cur.level,
    label:    cur.label,
    totalMin,
    nextLevel: next?.level ?? null,
    nextLabel: next?.label ?? null,
    nextThreshold: next?.totalMin ?? null,
    progressToNext: +(progress.toFixed(3)),
  };
}

// ---------- 全体サマリ ----------

/**
 * stats 画面の最上段に表示するサマリ。
 * { streak, level, totalMin, daysActive, mastered, byDeck }
 */
export async function getCumulativeSummary(today = new Date()) {
  const docs = await getAllDailyDocs();
  let totalMin = 0;
  const activeDays = new Set();
  for (const d of docs) {
    totalMin += (d.completedMin ?? 0);
    if ((d.completedMin ?? 0) > 0) activeDays.add(d.date);
  }

  const streak = await calculateStreak(today);
  const level  = levelFromMinutes(totalMin);

  // mastered word counts (deck ごと、SRS 状態から判定)
  const states = await getAllSrsStates();
  const masteredIds = new Set(states.filter((s) => statusOf(s) === 'mastered').map((s) => s.wordId));

  // word ID prefix で deck を推定 (例: 'toeic-' なら toeic, 'vi3kyu-' なら vi3kyu)
  const byDeck = { daily: 0, toeic: 0, vi3kyu: 0, ielts: 0, other: 0 };
  for (const id of masteredIds) {
    if (id.startsWith('toeic-'))   byDeck.toeic   += 1;
    else if (id.startsWith('vi3kyu-')) byDeck.vi3kyu += 1;
    else if (id.startsWith('ielts-'))  byDeck.ielts  += 1;
    else if (id.startsWith('w-') || id.startsWith('vi-')) byDeck.daily += 1;
    else byDeck.other += 1;
  }
  const totalMastered = masteredIds.size;

  // TOEIC スコア
  let toeic = null;
  try { toeic = await getScorePrediction(); } catch { /* */ }

  return {
    streak,
    level,
    totalMin,
    daysActive: activeDays.size,
    mastered:   totalMastered,
    byDeck,
    toeic: toeic ? {
      total: toeic.total ?? 0,
      listening: toeic.listening?.score ?? null,
      reading:   toeic.reading?.score   ?? null,
      answered:  toeic.totalAnswered ?? 0,
    } : null,
  };
}

// ---------- 正答率 ----------

/**
 * カテゴリ別正答率。
 * 戻り値: [{ key, label, accuracy: 0-1, answered }]
 */
export async function getAccuracyByCategory() {
  const out = [];
  // TOEIC L+R (toeic-score の集計を再利用)
  let toeic = null;
  try { toeic = await getScorePrediction(); } catch { /* */ }
  if (toeic) {
    if (toeic.listening?.answered > 0) {
      out.push({ key: 'toeic-l', label: 'TOEIC L', accuracy: toeic.listening.correct / toeic.listening.answered, answered: toeic.listening.answered });
    }
    if (toeic.reading?.answered > 0) {
      out.push({ key: 'toeic-r', label: 'TOEIC R', accuracy: toeic.reading.correct / toeic.reading.answered, answered: toeic.reading.answered });
    }
  }
  // 単語: 「習得」割合 (total に対する mastered の比率)
  try {
    const stats = await getStudyStats('en', 'daily');
    if (stats.total > 0) {
      out.push({ key: 'vocab', label: '日常単語', accuracy: stats.mastered / stats.total, answered: stats.mastered + stats.review + stats.learning });
    }
  } catch { /* */ }
  try {
    const stats = await getStudyStats('en', 'toeic');
    if (stats.total > 0) {
      out.push({ key: 'vocab-toeic', label: 'TOEIC 単語', accuracy: stats.mastered / stats.total, answered: stats.mastered + stats.review + stats.learning });
    }
  } catch { /* */ }
  try {
    const stats = await getStudyStats('vi', 'vi3kyu');
    if (stats.total > 0) {
      out.push({ key: 'vocab-vi3kyu', label: 'ベトナム語 3 級', accuracy: stats.mastered / stats.total, answered: stats.mastered + stats.review + stats.learning });
    }
  } catch { /* */ }

  return out;
}
