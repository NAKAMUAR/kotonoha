// =====================================================================
// 言の葉 / Kotonoha — 学習進捗（連続学習日数・完了シナリオ）
//
// Firestore users/{uid}.progress に保存:
//   streak, lastStudyDate ('YYYY-MM-DD', 端末のローカル日付),
//   completedScenarioIds[], completedScenarios
// =====================================================================

export function localDateKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function yesterdayKey(now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() - 1);
  return localDateKey(d);
}

/**
 * 表示用の連続学習日数。最後の学習が「昨日」より前なら途切れているので 0。
 */
export function effectiveStreak(progress, now = new Date()) {
  const last = progress?.lastStudyDate;
  if (!last) return 0;
  if (last === localDateKey(now) || last === yesterdayKey(now)) return progress.streak ?? 0;
  return 0;
}

/**
 * 今日学習したときの新しい streak / lastStudyDate。今日すでに記録済みなら null。
 */
export function nextStreak(progress, now = new Date()) {
  const today = localDateKey(now);
  const last  = progress?.lastStudyDate;
  if (last === today) return null;
  const streak = last === yesterdayKey(now) ? (progress?.streak ?? 0) + 1 : 1;
  return { streak, lastStudyDate: today };
}

/**
 * シナリオを完了済みに追加した progress の差分。追加済みなら null。
 */
export function withCompletedScenario(progress, scenarioId) {
  const ids = new Set(progress?.completedScenarioIds ?? []);
  if (ids.has(scenarioId)) return null;
  ids.add(scenarioId);
  return { completedScenarioIds: [...ids], completedScenarios: ids.size };
}
