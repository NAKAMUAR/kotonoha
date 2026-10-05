// =====================================================================
// 言の葉 / Kotonoha — 単語帳モジュール
// Step 3: IndexedDB（オフラインキャッシュ）+ Firestore（同期）+ FSRS
//
// データの流れ:
//   ・マスター単語: data/vocabulary-{lang}.json → IndexedDB (cache)
//   ・SRS 状態:    Firestore users/{uid}/srs/{wordId} ⇔ IndexedDB
//   ・マイノート:  自分で登録した単語・文。Firestore users/{uid}/notes/{id} ⇔ IndexedDB
//                  （公開されるアプリのデータには入らず、本人のアカウントにだけ保存）
// =====================================================================

import {
  collection,
  doc,
  getDocs,
  setDoc,
  deleteDoc,
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

async function idbDelete(storeName, key) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
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
  daily:  { id: 'daily',  label: '日常会話',         languages: ['en', 'vi'], file: (lang) => `./data/vocabulary-${lang}.json`,
            situations: (lang) => `./data/situations-${lang}.json` },
  toeic:  { id: 'toeic',  label: 'TOEIC',            languages: ['en'],       file: ()     => `./data/vocabulary-toeic.json` },
  ielts:  { id: 'ielts',  label: 'IELTS',            languages: ['en'],       file: ()     => `./data/vocabulary-ielts.json` },
  vipre6kyu: { id: 'vipre6kyu', label: 'ベトナム語検定準6級', languages: ['vi'], file: () => `./data/vocabulary-vi-pre6kyu.json` },
  vi5kyu: { id: 'vi5kyu', label: 'ベトナム語検定5級', languages: ['vi'],       file: ()     => `./data/vocabulary-vi-5kyu.json` },
  vi4kyu: { id: 'vi4kyu', label: 'ベトナム語検定4級', languages: ['vi'],       file: ()     => `./data/vocabulary-vi-4kyu.json` },
  vi3kyu: { id: 'vi3kyu', label: 'ベトナム語検定3級', languages: ['vi'],       file: ()     => `./data/vocabulary-vi-3kyu.json`,
            situations: () => './data/situations-vi3kyu.json' },
  vi2kyu: { id: 'vi2kyu', label: 'ベトナム語検定2級', languages: ['vi'],       file: ()     => `./data/vocabulary-vi-2kyu.json` },
  vi1kyu: { id: 'vi1kyu', label: 'ベトナム語検定1級', languages: ['vi'],       file: ()     => `./data/vocabulary-vi-1kyu.json` },
  phrasal: { id: 'phrasal', label: '句動詞（イメージ）', languages: ['en'],     file: ()     => `./data/vocabulary-phrasal.json`,
             situations: () => './data/situations-phrasal.json' },
  // 自分で登録した単語・文（ファイルではなく Firestore / IndexedDB から読む）
  mynote: { id: 'mynote', label: 'マイノート', languages: ['vi', 'en'], custom: true, file: () => null },
});

export function getDeck(deckId) { return DECKS[deckId] ?? DECKS.daily; }

// ---------- マスター単語データのロード ----------

const cacheLoaded = new Set(); // 'deck:lang' → loaded once

function cacheKey(deck, lang) { return `${deck}:${lang}`; }

export async function loadVocabulary(lang, deck = 'daily') {
  const key = cacheKey(deck, lang);
  if (cacheLoaded.has(key)) return;
  if (getDeck(deck).custom) {
    await syncNotesOnce();
    cacheLoaded.add(key);
    return;
  }

  const all      = await idbGetAll(STORE_VOCAB);
  const existing = all.filter((w) => (w.deck ?? 'daily') === deck && w.lang === lang);

  // セッションごとに 1 回、マスターデータと突き合わせる。
  // 単語が追加・変更されていれば IndexedDB に反映（学習記録は別ストアなので消えない）。
  try {
    const url = getDeck(deck).file(lang);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const words = await res.json();
    const known = new Set(existing.map((w) => w.id));
    if (words.length !== existing.length || words.some((w) => !known.has(w.id))) {
      const stamped = words.map((w) => ({ ...w, lang, deck }));
      await idbBulkPut(STORE_VOCAB, stamped);
    }
  } catch (err) {
    if (existing.length === 0) console.error(`vocab fetch failed for ${deck}/${lang}:`, err);
    else console.warn(`vocab refresh skipped for ${deck}/${lang} (using cache):`, err);
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

// ---------- マイノート（自分で登録した単語・文） ----------

export const NOTE_DECK = 'mynote';
let notesSynced = false;

const notesCol = (uid) => collection(db, 'users', uid, 'notes');
// Firestore は undefined を保存できないので取り除く
const clean = (o) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
const noteForCloud = (n) => clean({ ...n, synced: undefined });

/** ログイン直後・最初に開いたときに 1 回、Firestore と端末のノートを突き合わせる */
async function syncNotesOnce() {
  if (notesSynced) return;
  const user = auth.currentUser;
  if (!user) return;
  try {
    const snap = await getDocs(notesCol(user.uid));
    const remote = new Map();
    snap.forEach((d) => remote.set(d.id, { ...d.data(), id: d.id, deck: NOTE_DECK }));
    const local = (await idbGetAll(STORE_VOCAB)).filter((w) => w.deck === NOTE_DECK);
    for (const n of local) {
      if (remote.has(n.id)) continue;
      if (n.synced === false) {
        // 前回同期できなかったノートは、もう一度送る
        try { await setDoc(doc(db, 'users', user.uid, 'notes', n.id), noteForCloud(n)); remote.set(n.id, { ...n, synced: true }); }
        catch { remote.set(n.id, n); }
      } else {
        await idbDelete(STORE_VOCAB, n.id);   // ほかの端末で削除されたもの
      }
    }
    await idbBulkPut(STORE_VOCAB, [...remote.values()].map((n) => ({ ...n, synced: n.synced ?? true })));
    notesSynced = true;
  } catch (err) {
    console.warn('notes sync failed (using local):', err);
  }
}

export async function getNotes() {
  await syncNotesOnce();
  const all = await idbGetAll(STORE_VOCAB);
  return all.filter((w) => w.deck === NOTE_DECK).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}

/**
 * ノートを登録・更新する。戻り値 { note, synced }（synced=false は端末にだけ保存できた）
 *   note: { id?, lang, kind: 'word'|'sentence', word, meaning, reading?, example?, exampleTranslation?, source?, memo? }
 */
export async function saveNote(input) {
  const now = Date.now();
  const prev = input.id ? await idbGet(STORE_VOCAB, input.id) : null;
  const note = clean({
    id: input.id || `note_${now.toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    deck: NOTE_DECK,
    lang: input.lang,
    kind: input.kind,
    word: input.word.trim(),
    meaning: input.meaning.trim(),
    reading: input.reading?.trim() || undefined,
    example: input.example?.trim() || undefined,
    exampleTranslation: input.exampleTranslation?.trim() || undefined,
    source: input.source?.trim() || undefined,
    memo: input.memo?.trim() || undefined,
    level: '',
    tags: ['mynote', input.kind],
    createdAt: prev?.createdAt ?? now,
    updatedAt: now,
  });
  let synced = false;
  const user = auth.currentUser;
  if (user) {
    try { await setDoc(doc(db, 'users', user.uid, 'notes', note.id), note); synced = true; }
    catch (err) { console.warn('note sync failed:', err); }
  }
  await idbPut(STORE_VOCAB, { ...note, synced });
  return { note, synced };
}

export async function deleteNote(id) {
  await idbDelete(STORE_VOCAB, id);
  await idbDelete(STORE_SRS, id).catch(() => {});
  const user = auth.currentUser;
  if (!user) return;
  await Promise.all([
    deleteDoc(doc(db, 'users', user.uid, 'notes', id)),
    deleteDoc(doc(db, 'users', user.uid, 'srs', id)),
  ]).catch((err) => console.warn('note delete sync failed:', err));
}

/**
 * ログアウト時に呼んで、ローカル SRS データをクリア
 * （マスター単語データは保持 — 次のユーザーが使い回せる）
 */
export async function clearLocalSrs() {
  // マイノートは個人のデータなので、ログアウト時に端末から消す（次にログインした人に見えないように）
  const notes = (await idbGetAll(STORE_VOCAB)).filter((w) => w.deck === NOTE_DECK);
  for (const n of notes) await idbDelete(STORE_VOCAB, n.id);
  notesSynced = false;
  for (const k of [...cacheLoaded]) if (k.startsWith(`${NOTE_DECK}:`)) cacheLoaded.delete(k);
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_SRS, 'readwrite');
    tx.objectStore(STORE_SRS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/** マイノートを登録・削除したあと、単語帳の読み込みをやり直す */
export function invalidateNotesCache() {
  for (const k of [...cacheLoaded]) if (k.startsWith(`${NOTE_DECK}:`)) cacheLoaded.delete(k);
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

/**
 * 学習プラン用：今日そのデッキで何語学習したか。
 *   reviewedToday ... 今日 1 回以上評価した語数（新しい語・復習の両方）
 *   reviewDue     ... 一度学習済みで、復習の期限が来ている語数
 *   newLeft       ... まだ一度も学習していない語数
 */
export async function getTodayActivity(lang, deck = 'daily') {
  const vocab  = await getVocabulary(lang, deck);
  const states = await getAllSrsStates();
  const map    = new Map(states.map((s) => [s.wordId, s]));
  const now    = Date.now();
  const start  = new Date(); start.setHours(0, 0, 0, 0);
  const out = { total: vocab.length, reviewedToday: 0, reviewDue: 0, newLeft: 0 };
  for (const w of vocab) {
    const s = map.get(w.id);
    if ((s?.lastReviewedAt ?? 0) >= start.getTime()) out.reviewedToday += 1;
    if (statusOf(s) === 'new') out.newLeft += 1;
    else if (isDue(s, now)) out.reviewDue += 1;
  }
  return out;
}

// ---------- ホーム画面の進捗 ----------

// ホームに表示するデッキ（deck, lang）
export const PROGRESS_DECKS = Object.freeze([
  { deck: 'daily',  lang: 'en', label: '日常会話 単語（英語）' },
  { deck: 'phrasal', lang: 'en', label: '句動詞（イメージで覚える）' },
  { deck: 'daily',  lang: 'vi', label: '日常会話 単語（ベトナム語）' },
  { deck: 'toeic',  lang: 'en', label: 'TOEIC 単語' },
  { deck: 'vipre6kyu', lang: 'vi', label: 'ベトナム語検定準6級 単語' },
  { deck: 'vi5kyu', lang: 'vi', label: 'ベトナム語検定5級 単語' },
  { deck: 'vi4kyu', lang: 'vi', label: 'ベトナム語検定4級 単語' },
  { deck: 'vi3kyu', lang: 'vi', label: 'ベトナム語検定3級 単語' },
  { deck: 'vi2kyu', lang: 'vi', label: 'ベトナム語検定2級 単語' },
  { deck: 'vi1kyu', lang: 'vi', label: 'ベトナム語検定1級 単語' },
  { deck: 'mynote', lang: 'vi', label: 'マイノート（ベトナム語）' },
  { deck: 'mynote', lang: 'en', label: 'マイノート（英語）' },
]);

/**
 * 全デッキの進捗をまとめて返す。
 *   { 'daily:en': { total, started, learned }, ... }
 *   started ... 1 回以上学習した語数
 *   learned ... 定着した語数（復習段階 + 習得済）
 */
export async function getAllDeckProgress() {
  for (const { deck, lang } of PROGRESS_DECKS) {
    await loadVocabulary(lang, deck);
  }
  const vocab  = await idbGetAll(STORE_VOCAB);
  const states = await getAllSrsStates();
  const map    = new Map(states.map((s) => [s.wordId, s]));

  const result = {};
  for (const { deck, lang } of PROGRESS_DECKS) result[cacheKey(deck, lang)] = { total: 0, started: 0, learned: 0 };

  for (const w of vocab) {
    const r = result[cacheKey(w.deck ?? 'daily', w.lang)];
    if (!r) continue;
    r.total += 1;
    const st = statusOf(map.get(w.id));
    if (st !== 'new') r.started += 1;
    if (st === 'review' || st === 'mastered') r.learned += 1;
  }
  return result;
}

/** 全デッキ合計の「習得単語」数（復習段階 + 習得済） */
export async function getLearnedWordCount() {
  const states = await getAllSrsStates();
  return states.filter((s) => {
    const st = statusOf(s);
    return st === 'review' || st === 'mastered';
  }).length;
}
