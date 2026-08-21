// =====================================================================
// 言の葉 / Kotonoha — 単語帳モジュール
// v2: FSRS-6 + 学習負荷制御 + インターリービング + 復習ログ
//
// データの流れ:
//   ・マスター単語: data/vocabulary-{lang}.json → IndexedDB (cache)
//   ・SRS 状態:    Firestore users/{uid}/srs/{wordId} ⇔ IndexedDB
//   ・復習ログ:    IndexedDB reviewLog（将来の FSRS パラメータ最適化用）
//   ・学習設定:    IndexedDB settings ⇔ Firestore users/{uid}/settings/study
// =====================================================================

import {
  collection,
  doc,
  getDoc,
  getDocs,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { auth, db } from './firebase-init.js';
import {
  applyReview,
  isDue,
  statusOf,
  newSrsState,
  ensureState,
  previewFor,
  currentRetrievability,
  formatInterval,
  normalizeRating,
  RATING,
  RATING_LABELS,
  CARD_STATE,
  DEFAULT_CONFIG,
  QUALITY,
} from './srs.js';

export { RATING, RATING_LABELS, CARD_STATE, QUALITY, formatInterval, statusOf };

// ---------- IndexedDB セットアップ ----------

const DB_NAME        = 'kotonoha';
const DB_VERSION     = 2; // v2: reviewLog / settings ストアを追加
const STORE_VOCAB    = 'vocabulary';
const STORE_SRS      = 'srs';
const STORE_LOG      = 'reviewLog';
const STORE_SETTINGS = 'settings';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_VOCAB)) {
        const s = idb.createObjectStore(STORE_VOCAB, { keyPath: 'id' });
        s.createIndex('lang', 'lang', { unique: false });
      }
      if (!idb.objectStoreNames.contains(STORE_SRS)) {
        const s = idb.createObjectStore(STORE_SRS, { keyPath: 'wordId' });
        s.createIndex('nextReviewDate', 'nextReviewDate', { unique: false });
      }
      // 復習ログ: いつ・何を・どう評価したかの生データ。
      // FSRS はこのログから個人最適化パラメータを学習できる。
      if (!idb.objectStoreNames.contains(STORE_LOG)) {
        const s = idb.createObjectStore(STORE_LOG, { keyPath: 'id', autoIncrement: true });
        s.createIndex('reviewedAt', 'reviewedAt', { unique: false });
        s.createIndex('wordId', 'wordId', { unique: false });
      }
      if (!idb.objectStoreNames.contains(STORE_SETTINGS)) {
        idb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function idbGetAll(storeName) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(storeName, 'readonly').objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbGet(storeName, key) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function idbBulkPut(storeName, values) {
  if (!values.length) return;
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    for (const v of values) store.put(v);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/** 指定インデックスの範囲クエリ（復習ログの当日集計に使う）。 */
async function idbGetByRange(storeName, indexName, range) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const req = idb
      .transaction(storeName, 'readonly')
      .objectStore(storeName)
      .index(indexName)
      .getAll(range);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

// ---------- 学習設定 ----------

const SETTINGS_KEY = 'study';

// 1 日あたりの上限。上限を設けることが重要な理由:
//   ・新規を無制限に入れると数日後の復習が雪崩式に膨れ上がり、
//     結局こなしきれず全体が崩壊する（SRS 挫折の最大要因）。
//   ・毎日の負荷を一定に保つと、長期の継続率が大きく上がる。
export const DEFAULT_SETTINGS = Object.freeze({
  desiredRetention: 0.90, // 目標記憶率
  newPerDay:        20,   // 1 日の新規単語上限
  reviewPerDay:     150,  // 1 日の復習上限
  interleave:       true, // 新規と復習を混ぜて出題する
  burySiblings:     true, // リーチ単語を通常キューから外す
});

let settingsCache = null;

export async function getSettings() {
  if (settingsCache) return settingsCache;
  const stored = await idbGet(STORE_SETTINGS, SETTINGS_KEY);
  settingsCache = { ...DEFAULT_SETTINGS, ...(stored?.value ?? {}) };
  return settingsCache;
}

export async function updateSettings(patch) {
  const next = { ...(await getSettings()), ...patch };
  settingsCache = next;
  await idbPut(STORE_SETTINGS, { key: SETTINGS_KEY, value: next });

  const user = auth.currentUser;
  if (user) {
    setDoc(doc(db, 'users', user.uid, 'settings', SETTINGS_KEY), next, { merge: true })
      .catch((err) => console.warn('settings sync failed:', err));
  }
  return next;
}

export async function pullSettingsFromFirestore() {
  const user = auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(db, 'users', user.uid, 'settings', SETTINGS_KEY));
  if (!snap.exists()) return null;
  settingsCache = { ...DEFAULT_SETTINGS, ...snap.data() };
  await idbPut(STORE_SETTINGS, { key: SETTINGS_KEY, value: settingsCache });
  return settingsCache;
}

/** FSRS に渡す設定へ変換。 */
async function fsrsConfig() {
  const s = await getSettings();
  return { ...DEFAULT_CONFIG, desiredRetention: s.desiredRetention };
}

// ---------- デッキ定義 ----------

export const DECKS = Object.freeze({
  daily:  { id: 'daily',  label: '日常会話',         languages: ['en', 'vi'], file: (lang) => `./data/vocabulary-${lang}.json` },
  toeic:  { id: 'toeic',  label: 'TOEIC',            languages: ['en'],       file: ()     => `./data/vocabulary-toeic.json` },
  ielts:  { id: 'ielts',  label: 'IELTS',            languages: ['en'],       file: ()     => `./data/vocabulary-ielts.json` },
  vi3kyu: { id: 'vi3kyu', label: 'ベトナム語検定3級', languages: ['vi'],       file: ()     => `./data/vocabulary-vi-3kyu.json` },
});

export function getDeck(deckId) { return DECKS[deckId] ?? DECKS.daily; }

// ---------- マスター単語データのロード ----------

const cacheLoaded = new Set(); // 'deck:lang' → loaded once

function cacheKey(deck, lang) { return `${deck}:${lang}`; }

export async function loadVocabulary(lang, deck = 'daily') {
  const key = cacheKey(deck, lang);
  if (cacheLoaded.has(key)) return;

  const all      = await idbGetAll(STORE_VOCAB);
  const existing = all.filter((w) => (w.deck ?? 'daily') === deck && w.lang === lang);

  if (existing.length === 0) {
    try {
      const url = getDeck(deck).file(lang);
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const words = await res.json();
      const stamped = words.map((w) => ({ ...w, lang, deck }));
      await idbBulkPut(STORE_VOCAB, stamped);
    } catch (err) {
      console.error(`vocab fetch failed for ${deck}/${lang}:`, err);
    }
  }

  cacheLoaded.add(key);
}

export async function getVocabulary(lang, deck = 'daily') {
  await loadVocabulary(lang, deck);
  const all = await idbGetAll(STORE_VOCAB);
  return all.filter((w) => (w.deck ?? 'daily') === deck && w.lang === lang);
}

// ---------- SRS 状態 ----------

export async function getSrsState(wordId) {
  const raw = await idbGet(STORE_SRS, wordId);
  return raw ? ensureState(raw) : undefined;
}

export async function getAllSrsStates() {
  const all = await idbGetAll(STORE_SRS);
  // 旧 SM-2 レコードは読み出し時に FSRS 形式へ変換する（遅延マイグレーション）
  return all.map((s) => ({ wordId: s.wordId, ...ensureState(s) }));
}

/**
 * 1 語を評価して SRS 状態を更新する。
 *
 * @param {string} wordId
 * @param {number} rating RATING.AGAIN | HARD | GOOD | EASY（旧 0-5 も受付）
 */
export async function rateWord(wordId, rating) {
  const grade   = normalizeRating(rating);
  const config  = await fsrsConfig();
  const current = (await getSrsState(wordId)) ?? { wordId, ...newSrsState() };
  const before  = ensureState(current);
  const now     = Date.now();

  const updated = { wordId, ...applyReview(before, grade, config, now) };
  await idbPut(STORE_SRS, updated);

  // 復習ログを残す。FSRS の個人最適化にはこの生ログが必要。
  await appendReviewLog({
    wordId,
    rating:          grade,
    reviewedAt:      now,
    elapsedDays:     updated.elapsedDays,
    scheduledDays:   updated.scheduledDays,
    stateBefore:     before.state,
    stateAfter:      updated.state,
    stabilityAfter:  updated.stability,
    difficultyAfter: updated.difficulty,
  });

  // Firestore 同期（best-effort）
  syncSrsToFirestore(wordId, updated).catch((err) => {
    console.warn('Firestore SRS sync failed for', wordId, err);
  });

  return updated;
}

/** 評価前に、4 つのボタンそれぞれの次回間隔を求める。 */
export async function previewWord(wordId) {
  const config = await fsrsConfig();
  const state  = (await getSrsState(wordId)) ?? newSrsState();
  return previewFor(state, config);
}

async function syncSrsToFirestore(wordId, srsState) {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(
    doc(db, 'users', user.uid, 'srs', wordId),
    srsState,
    { merge: true }
  );
}

/**
 * ログイン直後などに呼んで Firestore → IDB を上書き取り込み。
 * 旧形式のドキュメントはここで FSRS 形式へ変換して保存し直す。
 */
export async function pullSrsFromFirestore() {
  const user = auth.currentUser;
  if (!user) return 0;

  const snap = await getDocs(collection(db, 'users', user.uid, 'srs'));
  const all = [];
  snap.forEach((d) => all.push({ wordId: d.id, ...ensureState(d.data()) }));
  await idbBulkPut(STORE_SRS, all);
  return all.length;
}

// ---------- 復習ログ ----------

async function appendReviewLog(entry) {
  try {
    await idbPut(STORE_LOG, entry);
  } catch (err) {
    console.warn('review log append failed:', err);
  }
}

function startOfToday(now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** 本日すでにこなした学習量。上限判定と進捗表示に使う。 */
export async function getTodayCounts(now = Date.now()) {
  const from = startOfToday(now);
  let logs = [];
  try {
    logs = await idbGetByRange(STORE_LOG, 'reviewedAt', IDBKeyRange.lowerBound(from));
  } catch {
    return { newDone: 0, reviewDone: 0, total: 0, again: 0, accuracy: null };
  }

  let newDone = 0, reviewDone = 0, again = 0;
  const seenNew = new Set();
  for (const l of logs) {
    if (l.stateBefore === CARD_STATE.NEW) {
      // 同じ新規単語を学習ステップで複数回やっても 1 語として数える
      if (!seenNew.has(l.wordId)) { seenNew.add(l.wordId); newDone += 1; }
    } else if (l.stateBefore === CARD_STATE.REVIEW) {
      reviewDone += 1;
    }
    if (l.rating === RATING.AGAIN) again += 1;
  }

  const total = logs.length;
  return {
    newDone,
    reviewDone,
    total,
    again,
    // 当日の正答率。目標記憶率と比べて設定を見直す材料になる。
    accuracy: total > 0 ? +(1 - again / total).toFixed(3) : null,
  };
}

export async function getReviewLog(limit = 0) {
  const all = await idbGetAll(STORE_LOG);
  all.sort((a, b) => a.reviewedAt - b.reviewedAt);
  return limit > 0 ? all.slice(-limit) : all;
}

// ---------- 学習キュー ----------

/** 評価後、そのカードを同一セッション内で再提示すべきか。 */
export function shouldRequeue(state, now = Date.now()) {
  if (!state) return false;
  const s = ensureState(state);
  if (s.state !== CARD_STATE.LEARNING && s.state !== CARD_STATE.RELEARNING) return false;
  // 当日中に再提示する対象（数分後に期日が来るもの）
  return s.nextReviewDate - now < 24 * 60 * 60 * 1000;
}

/** 配列を Fisher-Yates でシャッフル。 */
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 2 つの列を均等に混ぜる（インターリービング）。
 * 新規だけ／復習だけを連続で出すブロック学習より、種類を混ぜたほうが
 * 長期保持が良いことが繰り返し確認されている（interleaving effect）。
 */
function interleave(primary, secondary) {
  if (!secondary.length) return primary;
  if (!primary.length) return secondary;

  const out = [];
  const gap = primary.length / secondary.length;
  let si = 0;
  for (let i = 0; i < primary.length; i++) {
    out.push(primary[i]);
    while (si < secondary.length && si * gap <= i) {
      out.push(secondary[si]);
      si += 1;
    }
  }
  while (si < secondary.length) out.push(secondary[si++]);
  return out;
}

/**
 * 学習キューを構築する。
 *
 * v1 からの変更点:
 *   1. 期日超過の復習を「想起率が低い順」に並べる。
 *      日付順では、間隔 2 日の 1 日遅れと間隔 100 日の 1 日遅れが
 *      同じ緊急度になってしまう。想起率順なら本当に忘れかけている
 *      単語から救える。
 *   2. 1 日の新規／復習上限を適用する。
 *   3. 新規を復習の中に散らす（インターリービング）。
 *   4. リーチ単語を通常キューから外す。
 *
 * filter: 'all' | 'learning' | 'review' | 'mastered' | 'leech'
 */
export async function buildQueue(lang, filter = 'all', deck = 'daily') {
  const [vocab, states, settings, config, today] = await Promise.all([
    getVocabulary(lang, deck),
    getAllSrsStates(),
    getSettings(),
    fsrsConfig(),
    getTodayCounts(),
  ]);

  const map = new Map(states.map((s) => [s.wordId, s]));
  const now = Date.now();

  const enriched = vocab.map((w) => {
    const srs = map.get(w.id) ?? null;
    return {
      ...w,
      srs,
      status:         statusOf(srs),
      due:            isDue(srs, now),
      leech:          Boolean(srs?.leech),
      retrievability: srs ? currentRetrievability(srs, config, now) : 0,
    };
  });

  // --- フィルタ指定時は上限も混合もかけず、素直にその集合を返す ---
  if (filter === 'leech') {
    return enriched.filter((e) => e.leech).sort((a, b) => (b.srs?.lapses ?? 0) - (a.srs?.lapses ?? 0));
  }
  if (filter === 'mastered') {
    return enriched
      .filter((e) => e.status === 'mastered')
      .sort((a, b) => (b.srs?.stability ?? 0) - (a.srs?.stability ?? 0));
  }
  if (filter === 'learning') {
    return enriched
      .filter((e) => e.status === 'learning' && e.due)
      .sort((a, b) => (a.srs?.nextReviewDate ?? 0) - (b.srs?.nextReviewDate ?? 0));
  }

  const skipLeech = (e) => !(settings.burySiblings && e.leech);

  // 当日ステップ中のカードは上限に関係なく最優先（学習途中の放置を防ぐ）
  const learningDue = enriched
    .filter((e) => e.status === 'learning' && e.due)
    .sort((a, b) => (a.srs?.nextReviewDate ?? 0) - (b.srs?.nextReviewDate ?? 0));

  // 期日の来た復習：想起率の低い順 = 忘れかけている順
  let reviewDue = enriched
    .filter((e) => e.due && (e.status === 'review' || e.status === 'mastered') && skipLeech(e))
    .sort((a, b) => a.retrievability - b.retrievability);

  if (filter === 'review') return [...learningDue, ...reviewDue];

  const reviewBudget = Math.max(0, settings.reviewPerDay - today.reviewDone);
  reviewDue = reviewDue.slice(0, reviewBudget);

  // 新規：上限まで。順序はランダム（出題順の丸暗記を防ぐ）
  const newBudget = Math.max(0, settings.newPerDay - today.newDone);
  const newCards = newBudget > 0
    ? shuffle(enriched.filter((e) => e.status === 'new' && skipLeech(e))).slice(0, newBudget)
    : [];

  const scheduled = settings.interleave
    ? interleave(reviewDue, newCards)
    : [...reviewDue, ...newCards];

  return [...learningDue, ...scheduled];
}

/**
 * ログアウト時に呼んで、ローカル SRS データをクリア
 * （マスター単語データは保持 — 次のユーザーが使い回せる）
 */
export async function clearLocalSrs() {
  const idb = await openDB();
  settingsCache = null;
  return new Promise((resolve, reject) => {
    const tx = idb.transaction([STORE_SRS, STORE_LOG, STORE_SETTINGS], 'readwrite');
    tx.objectStore(STORE_SRS).clear();
    tx.objectStore(STORE_LOG).clear();
    tx.objectStore(STORE_SETTINGS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function getStudyStats(lang, deck = 'daily') {
  const [vocab, states, settings, config, today] = await Promise.all([
    getVocabulary(lang, deck),
    getAllSrsStates(),
    getSettings(),
    fsrsConfig(),
    getTodayCounts(),
  ]);

  const map = new Map(states.map((s) => [s.wordId, s]));
  const now = Date.now();

  const stats = {
    total: vocab.length,
    new: 0, learning: 0, review: 0, mastered: 0,
    dueCount: 0,   // 期日が来ている総数
    todayCount: 0, // 上限適用後の「今日やる数」
    leeches: 0,
    avgStability: 0,
    avgDifficulty: 0,
    today,
    settings,
  };

  let sumS = 0, sumD = 0, seen = 0;
  let dueNew = 0, dueReview = 0, dueLearning = 0;

  for (const w of vocab) {
    const s = map.get(w.id);
    const status = statusOf(s);
    stats[status] += 1;

    if (s?.leech) stats.leeches += 1;
    if (s?.stability > 0) { sumS += s.stability; sumD += s.difficulty; seen += 1; }

    if (isDue(s, now)) {
      stats.dueCount += 1;
      if (status === 'new') dueNew += 1;
      else if (status === 'learning') dueLearning += 1;
      else dueReview += 1;
    }
  }

  stats.avgStability  = seen ? +(sumS / seen).toFixed(1) : 0;
  stats.avgDifficulty = seen ? +(sumD / seen).toFixed(1) : 0;

  // ホーム画面には「上限を反映した実際の今日の量」を出す。
  // 期日総数をそのまま見せると数千件になり、やる気を折るだけになる。
  stats.todayCount =
    dueLearning +
    Math.min(dueReview, Math.max(0, settings.reviewPerDay - today.reviewDone)) +
    Math.min(dueNew,   Math.max(0, settings.newPerDay - today.newDone));

  return stats;
}

/**
 * 今後 N 日間の復習予定数。学習負荷を可視化して、
 * 新規上限を上げすぎていないか学習者が判断できるようにする。
 */
export async function getForecast(lang, deck = 'daily', days = 14) {
  const [vocab, states] = await Promise.all([getVocabulary(lang, deck), getAllSrsStates()]);
  const map = new Map(states.map((s) => [s.wordId, s]));
  const start = startOfToday();
  const buckets = new Array(days).fill(0);

  for (const w of vocab) {
    const s = map.get(w.id);
    if (!s || s.reps === 0) continue;
    const idx = Math.floor((s.nextReviewDate - start) / (24 * 60 * 60 * 1000));
    if (idx >= 0 && idx < days) buckets[idx] += 1;
    else if (idx < 0) buckets[0] += 1; // 期日超過は今日に積む
  }
  return buckets;
}
