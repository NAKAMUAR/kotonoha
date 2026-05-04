// =====================================================================
// 言の葉 / Kotonoha — バッジシステム
// Step 25-3: 獲得判定 + IDB/Firestore 同期
//
// データ:
//   ・定義  : data/badges.json
//   ・獲得済: kotonoha-daily / badges (id 単位)
//   ・同期  : users/{uid}/badges/{id}
// =====================================================================

import {
  collection,
  doc,
  getDocs,
  setDoc,
} from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';

import { auth, db } from './firebase-init.js';
import { openDailyDB } from './daily-settings.js';
import { getCumulativeSummary } from './stats.js';

const STORE = 'badges';

// ---------- 定義キャッシュ ----------

let _defs = null;
async function loadDefs() {
  if (_defs) return _defs;
  try {
    const res = await fetch('./data/badges.json');
    _defs = await res.json();
  } catch (err) {
    console.error('badges.json fetch failed:', err);
    _defs = [];
  }
  return _defs;
}

// ---------- IDB ----------

async function idbGetAll() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const req = idb.transaction(STORE, 'readonly').objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => resolve([]);
  });
}

async function idbGet(id) {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const req = idb.transaction(STORE, 'readonly').objectStore(STORE).get(id);
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => resolve(null);
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

// ---------- Firestore 同期 ----------

async function syncBadgeToFirestore(badge) {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(
    doc(db, 'users', user.uid, 'badges', badge.id),
    badge,
    { merge: true }
  );
}

export async function pullBadgesFromFirestore() {
  const user = auth.currentUser;
  if (!user) return 0;
  const snap = await getDocs(collection(db, 'users', user.uid, 'badges'));
  const all = [];
  snap.forEach((d) => all.push({ ...d.data(), id: d.id }));
  await idbBulkPut(all);
  return all.length;
}

// ---------- 公開 API ----------

/**
 * 全定義 + 獲得済情報をマージして返す。
 * 戻り値: [{ ...def, earnedAt: number|null, earned: bool }]
 */
export async function getAllBadgesWithStatus() {
  const defs   = await loadDefs();
  const earned = await idbGetAll();
  const earnedMap = new Map(earned.map((b) => [b.id, b]));

  return defs.map((def) => {
    const e = earnedMap.get(def.id);
    return {
      ...def,
      earned:   !!e,
      earnedAt: e?.earnedAt ?? null,
    };
  });
}

export async function getEarnedBadges() {
  const all = await idbGetAll();
  return all.sort((a, b) => (b.earnedAt ?? 0) - (a.earnedAt ?? 0));
}

/**
 * 全バッジ条件をチェックし、新規獲得分を保存して返す。
 * 戻り値: 新規獲得した badge 配列 (空ならなし)
 */
export async function checkAndAwardBadges() {
  const defs = await loadDefs();
  if (!defs.length) return [];

  const earned = await idbGetAll();
  const earnedSet = new Set(earned.map((b) => b.id));

  // 必要な統計をまとめて取得
  const summary = await getCumulativeSummary();
  const streak  = summary.streak;
  const totalMastered = summary.mastered;
  const toeicTotal = summary.toeic?.total ?? 0;

  // deck 別 mastered (vi3kyu 用)
  const byDeck = summary.byDeck ?? {};

  // mistakes resolved 数: 累計の delete 件数を取りたいが、削除済は IDB に残らないため
  // alternative: occurrences が 1 以上で resolvedAt がある履歴を別途記録するか、
  // 簡易には「累計 mistakes 件数 - 現在の active 件数」で代替する。
  // 今回はシンプルに、ProfileFirestore に resolvedCount を増分する仕組みを別途実装するまでは
  // 現実的な代替として「Firestore 側に過去存在した badges のうち resolvedTotal が貯まる」とはせず、
  // ローカルの badge 判定だけサポート。本番では `mistakesResolved` プロファイル値が必要。
  const mistakesResolved = await readResolvedCount();

  // IELTS Writing の投稿数: dailyTasks 完了履歴から ielts-w 完了数で代用
  const ieltsWriteCount = await readIeltsWriteCount();

  const now = Date.now();
  const newlyEarned = [];

  for (const def of defs) {
    if (earnedSet.has(def.id)) continue;
    if (matchCondition(def.condition, { streak, totalMastered, toeicTotal, byDeck, mistakesResolved, ieltsWriteCount })) {
      const badge = {
        id:        def.id,
        name:      def.name,
        kanji:     def.kanji,
        category:  def.category,
        level:     def.level,
        earnedAt:  now,
      };
      await idbPut(badge);
      syncBadgeToFirestore(badge).catch(() => {});
      newlyEarned.push(badge);
    }
  }

  return newlyEarned;
}

function matchCondition(c, ctx) {
  if (!c) return false;
  switch (c.type) {
    case 'streak':            return ctx.streak           >= (c.min ?? 0);
    case 'vocabMastered':     return ctx.totalMastered    >= (c.min ?? 0);
    case 'toeicTotal':        return ctx.toeicTotal       >= (c.min ?? 0);
    case 'mistakesResolved':  return ctx.mistakesResolved >= (c.min ?? 0);
    case 'ieltsWriteCount':   return ctx.ieltsWriteCount  >= (c.min ?? 0);
    case 'deckMastered': {
      const v = ctx.byDeck?.[c.deck] ?? 0;
      return v >= (c.min ?? 0);
    }
    default: return false;
  }
}

// ---------- カウンタ用ヘルパ ----------

/**
 * Resolved (削除済 mistakes) 累計を `dailySettings` 内に保存して inc していく。
 * mistakes.js#markReviewed が delete する直前にここを呼ぶ前提だが、
 * Phase 4 では「現在の earnedSet を見て一度だけ判定」にとどめ、累計は別途 stats.js でも算出。
 * ここでは Firestore の users/{uid}/stats/mistakeResolved に保存される値を読む簡易実装。
 */
async function readResolvedCount() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const tx = idb.transaction('dailySettings', 'readonly');
    const req = tx.objectStore('dailySettings').get('resolvedCount');
    req.onsuccess = () => resolve(req.result?.count ?? 0);
    req.onerror   = () => resolve(0);
  });
}

export async function incrementResolvedCount() {
  const cur = await readResolvedCount();
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction('dailySettings', 'readwrite');
    tx.objectStore('dailySettings').put({ key: 'resolvedCount', count: cur + 1 });
    tx.oncomplete = () => resolve(cur + 1);
    tx.onerror    = () => reject(tx.error);
  });
}

/**
 * 累積 IELTS Writing 完了タスク数 (dailyTasks 履歴から走査)
 */
async function readIeltsWriteCount() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const tx = idb.transaction('dailyTasks', 'readonly');
    const req = tx.objectStore('dailyTasks').getAll();
    req.onsuccess = () => {
      const data = req.result ?? [];
      let count = 0;
      for (const d of data) {
        for (const t of (d.tasks ?? [])) {
          if (t.type === 'ielts-w' && t.completed) count += 1;
        }
      }
      resolve(count);
    };
    req.onerror = () => resolve(0);
  });
}
