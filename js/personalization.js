// =====================================================================
// 言の葉 / Kotonoha — パーソナライゼーション
// Step 24-1/4: 直近の学習履歴から weakness profile を集計
//
// データ源:
//   ・mistakes (kotonoha-daily / mistakes)
//   ・dailyTasks (kotonoha-daily / dailyTasks)  ← 完了履歴
//   ・SRS 状態 (kotonoha / srs)                 ← 単語進捗
//   ・TOEIC results (kotonoha-toeic / results)  ← 正答率 by part/score
//
// 出力:
//   profile = {
//     periodDays:   7,
//     totals:       { mistakeAdded, mistakesByPriority, tasksCompleted, tasksTotal, ... },
//     vocab:        { mastered, learning, dueCount },
//     toeic:        { listening: { answered, correct, accuracy }, reading: {...}, weakBands: [...] },
//     weakSources:  ['toeic-l', 'vocab', ...] 上位 3 つ,
//     strongSources:['ielts-w', ...] 下位,
//     suggestions:  [{ type, reason, magnitude }]  ← 適応的タスク調整に使用
//   }
// =====================================================================

import { openDailyDB } from './daily-settings.js';
import { priorityOf } from './mistakes.js';
import { getScorePrediction } from './toeic-score.js';
import { getStudyStats } from './vocabulary.js';

const DAY = 86400000;

// ---------- profile キャッシュ (kotonoha-daily / dailySettings) ----------
//   key='profileCache' に { profile, generatedAt } を保存
//   有効期限は 6 時間 (短いセッションでは再計算しない)

const CACHE_KEY = 'profileCache';
const CACHE_TTL = 6 * 3600 * 1000;

async function readCache() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const tx = idb.transaction('dailySettings', 'readonly');
    const req = tx.objectStore('dailySettings').get(CACHE_KEY);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
  });
}

async function writeCache(profile) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('dailySettings', 'readwrite');
    tx.objectStore('dailySettings').put({
      key: CACHE_KEY,
      profile,
      generatedAt: Date.now(),
    });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ---------- 集計 ----------

async function getRecentMistakes(days = 7) {
  const idb = await openDailyDB();
  const since = Date.now() - days * DAY;
  return new Promise((resolve) => {
    const all = [];
    const req = idb.transaction('mistakes', 'readonly').objectStore('mistakes').getAll();
    req.onsuccess = () => {
      const data = req.result ?? [];
      for (const m of data) {
        if ((m.lastWrongAt ?? m.firstWrongAt ?? 0) >= since) all.push(m);
      }
      resolve(all);
    };
    req.onerror = () => resolve([]);
  });
}

async function getRecentDailyTasks(days = 7) {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const since = Date.now() - days * DAY;
    const req = idb.transaction('dailyTasks', 'readonly').objectStore('dailyTasks').getAll();
    req.onsuccess = () => {
      const data = req.result ?? [];
      const recent = data.filter((d) => {
        const t = new Date(d.date + 'T00:00').getTime();
        return t >= since;
      });
      resolve(recent);
    };
    req.onerror = () => resolve([]);
  });
}

// ---------- 公開 API ----------

/**
 * profile を生成 (キャッシュがあれば使う)。force=true で強制再計算。
 */
export async function getProfile({ force = false, days = 7, lang = 'en', deck = 'daily' } = {}) {
  if (!force) {
    const cached = await readCache();
    if (cached?.profile && cached.generatedAt && Date.now() - cached.generatedAt < CACHE_TTL) {
      return cached.profile;
    }
  }

  const profile = await buildProfile({ days, lang, deck });
  await writeCache(profile);
  return profile;
}

async function buildProfile({ days, lang, deck }) {
  const now = Date.now();

  const mistakes = await getRecentMistakes(days);
  const tasksDays = await getRecentDailyTasks(days);

  // mistakes by source / priority
  const mistakesBySource = {};
  const mistakesByPriority = { critical: 0, review: 0, caution: 0 };
  for (const m of mistakes) {
    mistakesBySource[m.source] = (mistakesBySource[m.source] ?? 0) + 1;
    const p = priorityOf(m, now);
    mistakesByPriority[p] = (mistakesByPriority[p] ?? 0) + 1;
  }

  // タスク完了率
  let tasksTotal = 0;
  let tasksCompleted = 0;
  let minutesCompleted = 0;
  let minutesTotal = 0;
  for (const day of tasksDays) {
    for (const t of (day.tasks ?? [])) {
      tasksTotal += 1;
      minutesTotal += t.estimatedMin ?? 0;
      if (t.completed) {
        tasksCompleted += 1;
        minutesCompleted += t.estimatedMin ?? 0;
      }
    }
  }

  // 単語学習状況 (in best-effort)
  let vocabStats = { total: 0, new: 0, learning: 0, review: 0, mastered: 0, dueCount: 0 };
  try {
    vocabStats = await getStudyStats(lang, deck);
  } catch (err) { /* ignore */ }

  // TOEIC スコア予測
  let toeic = null;
  try {
    toeic = await getScorePrediction();
  } catch (err) { /* ignore */ }

  // 弱点ソース判定 (mistake 件数が多い順 + 完了率の低い type 加味)
  const sourcesRanked = Object.entries(mistakesBySource)
    .sort((a, b) => b[1] - a[1])
    .map(([src, count]) => ({ src, count }));

  const weakSources   = sourcesRanked.slice(0, 3).map((x) => x.src);
  const strongSources = sourcesRanked.slice(-2).map((x) => x.src).filter((s) => !weakSources.includes(s));

  // 適応的タスク調整の提案
  const suggestions = [];
  for (const w of weakSources) {
    suggestions.push({ src: w, action: 'boost', factor: 1.5, reason: `直近 ${days} 日で間違いが多い` });
  }
  for (const s of strongSources) {
    suggestions.push({ src: s, action: 'reduce', factor: 0.7, reason: `直近 ${days} 日で間違いが少ない` });
  }

  // weak TOEIC bands
  const weakBands = [];
  if (toeic) {
    for (const section of ['listening', 'reading']) {
      const bands = toeic[section]?.byBand ?? {};
      for (const [band, b] of Object.entries(bands)) {
        if (b.answered >= 3 && b.accuracy !== null && b.accuracy < 0.6) {
          weakBands.push({ section, band, accuracy: +(b.accuracy.toFixed(2)) });
        }
      }
    }
  }

  return {
    periodDays: days,
    generatedAt: now,
    totals: {
      mistakesAdded:    mistakes.length,
      mistakesByPriority,
      tasksCompleted,
      tasksTotal,
      taskCompletionRate: tasksTotal ? +(tasksCompleted / tasksTotal).toFixed(2) : null,
      minutesCompleted,
      minutesTotal,
    },
    mistakesBySource,
    weakSources,
    strongSources,
    weakBands,
    vocab: vocabStats,
    toeic: toeic ? {
      listening: { answered: toeic.listening.answered, correct: toeic.listening.correct, score: toeic.listening.score },
      reading:   { answered: toeic.reading.answered,   correct: toeic.reading.correct,   score: toeic.reading.score },
      total: toeic.total,
    } : null,
    suggestions,
  };
}

/**
 * profile.suggestions に基づいて preset (タスクテンプレ) を調整。
 * 元の preset = [{ type, units }]、戻り値も同じ形。
 */
export function adaptPreset(preset, profile) {
  if (!profile?.suggestions?.length) return preset;

  const factor = {};
  for (const s of profile.suggestions) {
    factor[s.src] = (factor[s.src] ?? 1) * (s.factor ?? 1);
  }

  return preset.map((item) => {
    const f = factor[item.type];
    if (!f) return item;
    const adjusted = Math.max(1, Math.round(item.units * f));
    return { ...item, units: adjusted, _adapted: true };
  });
}
