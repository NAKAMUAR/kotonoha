// =====================================================================
// 言の葉 / Kotonoha — 間違いプール (mistakes)
// Step 23-1/2/5: 自動記録 + 3 段階優先度 + 既存機能フック
//
// データ:
//   ・IndexedDB:  kotonoha-daily / mistakes (keyPath: id, unique index 'refKey')
//   ・Firestore:  users/{uid}/mistakes/{id}
//
// refKey は (source + ':' + refId) で一意。
// 同じ問題で間違えると新規追加せず occurrences をインクリメント。
// =====================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
  deleteDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { auth, db } from './firebase-init.js';
import { openDailyDB } from './daily-settings.js';
import { applySrs, newSrsState, QUALITY } from './srs.js';

const STORE = 'mistakes';

// ---------- IndexedDB ----------

async function idbGet(id) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGetByRefKey(refKey) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const idx = idb.transaction(STORE, 'readonly').objectStore(STORE).index('refKey');
    const req = idx.get(refKey);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGetAll() {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(value) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function idbBulkPut(values) {
  if (!values.length) return;
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    const s  = tx.objectStore(STORE);
    for (const v of values) s.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function idbDelete(id) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ---------- 優先度判定 ----------

const DAY = 86400000;

export const PRIORITY = Object.freeze({
  CRITICAL: 'critical',  // 最重要
  REVIEW:   'review',    // 要復習
  CAUTION:  'caution',   // 注意
});

export const PRIORITY_LABELS = Object.freeze({
  critical: '最重要',
  review:   '要復習',
  caution:  '注意',
});

const PRIORITY_ORDER = { critical: 0, review: 1, caution: 2 };

/**
 * 間違いの優先度を自動算出。
 *   critical: occurrences>=3 OR (==2 かつ直近 7 日以内)
 *   review:   occurrences==2 OR 直近 14 日以内
 *   caution:  それ以外
 */
export function priorityOf(mistake, now = Date.now()) {
  const occ    = mistake.occurrences ?? 1;
  const recent = mistake.lastWrongAt ?? mistake.firstWrongAt ?? now;
  const within7  = recent > now - 7  * DAY;
  const within14 = recent > now - 14 * DAY;

  if (occ >= 3) return 'critical';
  if (occ === 2 && within7) return 'critical';
  if (occ === 2) return 'review';
  if (within14) return 'review';
  return 'caution';
}

// ---------- 記録 ----------

/**
 * 間違いを記録 (既存の refKey なら occurrences インクリメント)。
 * 戻り値は最終的な mistake オブジェクト。
 *
 * @param {object} args
 *   @prop {string} source     'vocab' | 'toeic-l' | 'toeic-r' | 'ielts-w' | 'ielts-s' | 'scenario'
 *   @prop {string} refId      該当問題の一意 ID (questionId / wordId 等)
 *   @prop {string} language   'en' | 'vi'
 *   @prop {object} snapshot   { question, correct, yourAnswer, explanation, tags }
 */
export async function recordMistake({ source, refId, language = 'en', snapshot = {} }) {
  if (!source || !refId) return null;

  const refKey = `${source}:${refId}`;
  const existing = await idbGetByRefKey(refKey);
  const now = Date.now();

  let mistake;
  if (existing) {
    mistake = {
      ...existing,
      occurrences:  (existing.occurrences ?? 1) + 1,
      lastWrongAt:  now,
      resolvedAt:   null,
      reviewedAt:   existing.reviewedAt ?? null,
      streakRight:  0,                 // 連続正答カウンタをリセット
      snapshot:     { ...existing.snapshot, ...snapshot },
      srs:          applySrs(existing.srs ?? newSrsState(), QUALITY.HARD),
    };
  } else {
    mistake = {
      id:           `m-${now}-${Math.random().toString(36).slice(2, 8)}`,
      refKey,
      source,
      refId,
      language,
      snapshot,
      occurrences:  1,
      streakRight:  0,
      firstWrongAt: now,
      lastWrongAt:  now,
      reviewedAt:   null,
      resolvedAt:   null,
      srs:          applySrs(newSrsState(), QUALITY.HARD),
    };
  }

  mistake.priority = priorityOf(mistake, now);

  await idbPut(mistake);
  syncMistakeToFirestore(mistake).catch((err) => {
    console.warn('Firestore mistake sync failed:', err);
  });
  return mistake;
}

/**
 * レビュー結果を記録。
 *   correct=true なら streakRight を +1、2 連続で resolved にして DB から削除。
 *   correct=false なら occurrences をインクリメント・streakRight=0・優先度再計算。
 */
export async function markReviewed(id, correct) {
  const m = await idbGet(id);
  if (!m) return null;
  const now = Date.now();

  const quality = correct ? QUALITY.NORMAL : QUALITY.HARD;
  const newSrs  = applySrs(m.srs ?? newSrsState(), quality);

  if (correct) {
    const streak = (m.streakRight ?? 0) + 1;
    if (streak >= 2) {
      // resolved → IDB から削除、Firestore からも削除、累計カウンタ +1
      await idbDelete(id);
      deleteMistakeFromFirestore(id).catch((err) => {
        console.warn('Firestore mistake delete failed:', err);
      });
      // 累計 resolved カウンタを増分 (バッジ判定用) — dynamic import で循環回避
      import('./badges.js').then(({ incrementResolvedCount }) => {
        incrementResolvedCount().catch(() => {});
      }).catch(() => {});
      return { ...m, resolvedAt: now, streakRight: streak, srs: newSrs };
    }
    const updated = { ...m, streakRight: streak, reviewedAt: now, srs: newSrs };
    updated.priority = priorityOf(updated, now);
    await idbPut(updated);
    syncMistakeToFirestore(updated).catch(() => {});
    return updated;
  }

  // 不正解: もう一度間違えたとして occurrences を増やす
  const updated = {
    ...m,
    occurrences:  (m.occurrences ?? 1) + 1,
    streakRight:  0,
    lastWrongAt:  now,
    reviewedAt:   now,
    srs:          newSrs,
  };
  updated.priority = priorityOf(updated, now);
  await idbPut(updated);
  syncMistakeToFirestore(updated).catch(() => {});
  return updated;
}

// ---------- 取得 ----------

/**
 * フィルタつきで mistakes を取得。優先度順にソート。
 * @param {object} opts
 *   @prop {string} priority  'all' | 'critical' | 'review' | 'caution'
 *   @prop {string} source    'all' | 'vocab' | 'toeic-l' | 'toeic-r' | ...
 *   @prop {string} language  'all' | 'en' | 'vi'
 *   @prop {number} limit
 */
export async function getMistakes({ priority = 'all', source = 'all', language = 'all', limit = 0 } = {}) {
  const all = await idbGetAll();
  const now = Date.now();

  const filtered = all.filter((m) => {
    // 優先度はリアルタイムで再評価 (保存時から日数が経って降格してる場合に追従)
    const p = priorityOf(m, now);
    if (priority !== 'all' && p !== priority) return false;
    if (source   !== 'all' && m.source !== source) return false;
    if (language !== 'all' && m.language !== language) return false;
    return true;
  }).map((m) => ({ ...m, priority: priorityOf(m, now) }));

  filtered.sort((a, b) => {
    const ap = PRIORITY_ORDER[a.priority] ?? 9;
    const bp = PRIORITY_ORDER[b.priority] ?? 9;
    if (ap !== bp) return ap - bp;
    return (b.lastWrongAt ?? 0) - (a.lastWrongAt ?? 0);
  });

  return limit > 0 ? filtered.slice(0, limit) : filtered;
}

/**
 * 件数集計 (バッジ・統計用)
 */
export async function getMistakeCounts() {
  const all = await idbGetAll();
  const now = Date.now();
  const counts = { all: all.length, critical: 0, review: 0, caution: 0 };
  for (const m of all) {
    const p = priorityOf(m, now);
    counts[p] = (counts[p] ?? 0) + 1;
  }
  return counts;
}

// ---------- Firestore 同期 ----------

async function syncMistakeToFirestore(mistake) {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(
    doc(db, 'users', user.uid, 'mistakes', mistake.id),
    mistake,
    { merge: true }
  );
}

async function deleteMistakeFromFirestore(id) {
  const user = auth.currentUser;
  if (!user) return;
  await deleteDoc(doc(db, 'users', user.uid, 'mistakes', id));
}

/**
 * ログイン直後に Firestore → IDB へ pull (上書き)
 */
export async function pullMistakesFromFirestore() {
  const user = auth.currentUser;
  if (!user) return 0;
  const snap = await getDocs(collection(db, 'users', user.uid, 'mistakes'));
  const all = [];
  snap.forEach((d) => all.push({ ...d.data(), id: d.id }));
  await idbBulkPut(all);
  return all.length;
}
