// =====================================================================
// 言の葉 / Kotonoha — 単語帳モジュール
// Step 3: IndexedDB（オフラインキャッシュ）+ Firestore（同期）+ SM-2
//
// データの流れ:
//   ・マスター単語: data/vocabulary-{lang}.json → IndexedDB (cache)
//   ・SRS 状態:    Firestore users/{uid}/srs/{wordId} ⇔ IndexedDB
// =====================================================================

import {
  collection,
  doc,
  getDocs,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { auth, db } from './firebase-init.js';
import { applySrs, isDue, statusOf, newSrsState, QUALITY } from './srs.js';

export { QUALITY };

// ---------- IndexedDB セットアップ ----------

const DB_NAME       = 'kotonoha';
const DB_VERSION    = 1;
const STORE_VOCAB   = 'vocabulary';
const STORE_SRS     = 'srs';

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

// ---------- デッキ定義 ----------
// 'daily' は既存（en/vi）、'toeic'/'ielts' は英語のみ

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
  return await idbGet(STORE_SRS, wordId);
}

export async function getAllSrsStates() {
  return await idbGetAll(STORE_SRS);
}

export async function rateWord(wordId, quality) {
  const current = (await getSrsState(wordId)) ?? { wordId, ...newSrsState() };
  const updated = { wordId, ...applySrs(current, quality) };
  await idbPut(STORE_SRS, updated);

  // Firestore 同期（best-effort）
  syncSrsToFirestore(wordId, updated).catch((err) => {
    console.warn('Firestore SRS sync failed for', wordId, err);
  });

  return updated;
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
 */
export async function pullSrsFromFirestore() {
  const user = auth.currentUser;
  if (!user) return 0;

  const snap = await getDocs(collection(db, 'users', user.uid, 'srs'));
  const all = [];
  snap.forEach((d) => all.push({ wordId: d.id, ...d.data() }));
  await idbBulkPut(STORE_SRS, all);
  return all.length;
}

// ---------- 学習キュー ----------

/**
 * 復習対象 + 未学習の単語を、優先度順で返す。
 *   1. 期日超過の review  (古い順)
 *   2. learning           (期日順)
 *   3. new (未学習)
 *
 * filter: 'all' | 'learning' | 'review' | 'mastered'
 */
export async function buildQueue(lang, filter = 'all', deck = 'daily') {
  const vocab  = await getVocabulary(lang, deck);
  const states = await getAllSrsStates();
  const map    = new Map(states.map((s) => [s.wordId, s]));
  const now    = Date.now();

  const enriched = vocab.map((w) => {
    const srs = map.get(w.id) ?? null;
    return { ...w, srs, status: statusOf(srs), due: isDue(srs, now) };
  });

  let pool;
  switch (filter) {
    case 'learning':
      pool = enriched.filter((e) => e.status === 'learning' || e.status === 'new');
      break;
    case 'review':
      pool = enriched.filter((e) => e.status === 'review' && e.due);
      break;
    case 'mastered':
      pool = enriched.filter((e) => e.status === 'mastered');
      break;
    case 'all':
    default:
      pool = enriched.filter((e) => e.due || e.status === 'new');
      break;
  }

  // 優先度ソート
  return pool.sort((a, b) => {
    const order = { review: 0, learning: 1, new: 2, mastered: 3 };
    if (order[a.status] !== order[b.status]) {
      return order[a.status] - order[b.status];
    }
    const aT = a.srs?.nextReviewDate ?? 0;
    const bT = b.srs?.nextReviewDate ?? 0;
    return aT - bT;
  });
}

/**
 * ログアウト時に呼んで、ローカル SRS データをクリア
 * （マスター単語データは保持 — 次のユーザーが使い回せる）
 */
export async function clearLocalSrs() {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_SRS, 'readwrite');
    tx.objectStore(STORE_SRS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function getStudyStats(lang, deck = 'daily') {
  const vocab  = await getVocabulary(lang, deck);
  const states = await getAllSrsStates();
  const map    = new Map(states.map((s) => [s.wordId, s]));
  const now    = Date.now();

  const stats = { total: vocab.length, new: 0, learning: 0, review: 0, mastered: 0, dueCount: 0 };
  for (const w of vocab) {
    const s = map.get(w.id);
    stats[statusOf(s)] += 1;
    if (isDue(s, now)) stats.dueCount += 1;
  }
  return stats;
}
