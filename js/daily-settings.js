// =====================================================================
// 言の葉 / Kotonoha — デイリー設定モジュール
// Step 22-5: コース・言語モード設定
//
// データ:
//   ・IndexedDB:  kotonoha-daily / dailySettings (key='current')
//   ・Firestore:  users/{uid}/dailySettings/current
//
// 言語モード:
//   ・rotate ... 日替わり (rotation 配列を曜日で循環)
//   ・pick   ... 毎セッション選択 (lastPicked を記憶)
//   ・fixed  ... 常に fixedLanguage
// =====================================================================

import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { auth, db } from './firebase-init.js';

// ---------- IndexedDB ----------

const DB_NAME    = 'kotonoha-daily';
const DB_VERSION = 3;             // v1: settings+tasks / v2: mistakes / v3: badges 追加
const STORE_SETTINGS = 'dailySettings';
const STORE_TASKS    = 'dailyTasks';
const STORE_MISTAKES = 'mistakes';
const STORE_BADGES   = 'badges';

let dbPromise = null;

export function openDailyDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      // v1: settings + tasks
      if (!idb.objectStoreNames.contains(STORE_SETTINGS)) {
        idb.createObjectStore(STORE_SETTINGS, { keyPath: 'key' });
      }
      if (!idb.objectStoreNames.contains(STORE_TASKS)) {
        idb.createObjectStore(STORE_TASKS, { keyPath: 'date' });
      }
      // v2: mistakes
      if (!idb.objectStoreNames.contains(STORE_MISTAKES)) {
        const m = idb.createObjectStore(STORE_MISTAKES, { keyPath: 'id' });
        m.createIndex('source',       'source',       { unique: false });
        m.createIndex('language',     'language',     { unique: false });
        m.createIndex('priority',     'priority',     { unique: false });
        m.createIndex('lastWrongAt',  'lastWrongAt',  { unique: false });
        m.createIndex('refKey',       'refKey',       { unique: true  });
      }
      // v3: badges (id 単位で保存。獲得済のみエントリあり)
      if (!idb.objectStoreNames.contains(STORE_BADGES)) {
        idb.createObjectStore(STORE_BADGES, { keyPath: 'id' });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function idbGet(storeName, key) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(storeName, 'readonly').objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(storeName, value) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ---------- 既定値 ----------

export const COURSES = Object.freeze({
  short:    { id: 'short',    label: '短',  minutes: 15, kanji: '短', subtitle: '15 分' },
  standard: { id: 'standard', label: '中',  minutes: 30, kanji: '中', subtitle: '30 分' },
  long:     { id: 'long',     label: '長',  minutes: 60, kanji: '長', subtitle: '60 分' },
});

export const LANGUAGE_MODES = Object.freeze({
  rotate: { id: 'rotate', label: '日替り' },
  pick:   { id: 'pick',   label: '選択' },
  fixed:  { id: 'fixed',  label: '固定' },
});

const DEFAULT_SETTINGS = Object.freeze({
  key:           'current',
  defaultCourse: 'standard',
  languageMode:  'pick',
  fixedLanguage: 'en',
  rotation:      ['en', 'vi'],
  lastPicked:    'en',
  notifyTime:    '21:00',
  weeklyGoalMin: 180,
  updatedAt:     null,
});

// ---------- 取得・保存 ----------

export async function loadSettings() {
  const local = await idbGet(STORE_SETTINGS, 'current');
  if (local) return { ...DEFAULT_SETTINGS, ...local };
  return { ...DEFAULT_SETTINGS };
}

export async function saveSettings(partial) {
  const current = await loadSettings();
  const merged  = { ...current, ...partial, key: 'current', updatedAt: Date.now() };
  await idbPut(STORE_SETTINGS, merged);
  syncSettingsToFirestore(merged).catch((err) => {
    console.warn('Firestore dailySettings sync failed:', err);
  });
  return merged;
}

async function syncSettingsToFirestore(settings) {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(
    doc(db, 'users', user.uid, 'dailySettings', 'current'),
    settings,
    { merge: true }
  );
}

/**
 * ログイン直後に Firestore から IDB へ pull (Firestore が真実)
 */
export async function pullSettingsFromFirestore() {
  const user = auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(db, 'users', user.uid, 'dailySettings', 'current'));
  if (!snap.exists()) return null;
  const data = { ...DEFAULT_SETTINGS, ...snap.data(), key: 'current' };
  await idbPut(STORE_SETTINGS, data);
  return data;
}

// ---------- 言語決定ロジック ----------

/**
 * settings + 日付 から「今日使う言語」を決定する。
 *   rotate: rotation[dayIndex % rotation.length]
 *   pick:   settings.lastPicked（呼び出し側が pickLanguage() で更新）
 *   fixed:  settings.fixedLanguage
 *
 * @param {object} settings  loadSettings() の戻り値
 * @param {Date}   today     既定: 現在
 * @returns {'en' | 'vi'}
 */
export function decideLanguage(settings, today = new Date()) {
  const mode = settings.languageMode ?? 'pick';
  if (mode === 'fixed') {
    return settings.fixedLanguage ?? 'en';
  }
  if (mode === 'rotate') {
    const rotation = settings.rotation?.length ? settings.rotation : ['en', 'vi'];
    // 1970-01-01 からの日数
    const dayIndex = Math.floor(today.getTime() / 86400000);
    return rotation[dayIndex % rotation.length];
  }
  // pick
  return settings.lastPicked ?? 'en';
}

/**
 * pick モードで選択された言語を記憶
 */
export async function pickLanguage(lang) {
  return await saveSettings({ lastPicked: lang });
}
