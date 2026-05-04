// =====================================================================
// 言の葉 / Kotonoha — デイリータスク モジュール
// Step 22-2/3: タスク自動生成 + 完了管理
//
// データ:
//   ・IndexedDB:  kotonoha-daily / dailyTasks (keyPath: 'date' = 'YYYY-MM-DD')
//   ・Firestore:  users/{uid}/dailyTasks/{date}
//
// タスク自動生成:
//   ・コース別の合計時間 (短15 / 中30 / 長60 分)
//   ・テンプレート比率に従ってタスクを並べる
//   ・date+uid を seed にした決定的シャッフル (同日は何度開いても同じ並び)
// =====================================================================

import { doc, getDoc, setDoc } from 'https://www.gstatic.com/firebasejs/10.14.1/firebase-firestore.js';
import { auth, db } from './firebase-init.js';
import { openDailyDB, COURSES } from './daily-settings.js';

const STORE = 'dailyTasks';

// ---------- IndexedDB ----------

async function idbGet(key) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
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

// ---------- 日付ヘルパ ----------

export function todayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// ---------- 決定的シャッフル (mulberry32 PRNG) ----------

function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function mulberry32(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffleSeeded(arr, rng) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- タスクテンプレート ----------
// type ごとのメタ情報。units はコースプリセットで指定する。

const TEMPLATE_META = {
  'vocab':    { label: '単語復習',         target: 'vocabulary',      icon: '単', minPerUnit: 0.25, unitLabel: '語' },
  'scenario': { label: '会話シナリオ',     target: 'scenarios',       icon: '話', minPerUnit: 5,    unitLabel: '本' },
  'toeic-l':  { label: 'TOEIC リスニング', target: 'toeic-listening', icon: '聴', minPerUnit: 1.5,  unitLabel: '問' },
  'toeic-r':  { label: 'TOEIC リーディング', target: 'toeic-reading',  icon: '読', minPerUnit: 1.5,  unitLabel: '問' },
  'ielts-w':  { label: 'IELTS Writing',    target: 'ielts-writing',   icon: '作', minPerUnit: 10,   unitLabel: '本' },
  'grammar':  { label: '文法添削',         target: 'grammar',         icon: '添', minPerUnit: 3,    unitLabel: '回' },
};

// コースごとの推奨タスク構成。合計が概ね totalMin に収まるように。
// 短 15分 / 中 30分 / 長 60分。
const COURSE_PRESETS = {
  short: [
    { type: 'vocab',    units: 30 },   // 7.5 分
    { type: 'toeic-l',  units: 3 },    // 4.5 分
    { type: 'grammar',  units: 1 },    // 3 分
  ],
  standard: [
    { type: 'vocab',    units: 40 },   // 10 分
    { type: 'scenario', units: 1 },    // 5 分
    { type: 'toeic-l',  units: 4 },    // 6 分
    { type: 'toeic-r',  units: 4 },    // 6 分
    { type: 'grammar',  units: 1 },    // 3 分
  ],
  long: [
    { type: 'vocab',    units: 60 },   // 15 分
    { type: 'scenario', units: 2 },    // 10 分
    { type: 'toeic-l',  units: 8 },    // 12 分
    { type: 'toeic-r',  units: 8 },    // 12 分
    { type: 'ielts-w',  units: 1 },    // 10 分 (任意)
    { type: 'grammar',  units: 1 },    // 3 分
  ],
};

// ---------- タスク生成 ----------

/**
 * 指定コース・言語・日付の本日タスクを生成する (純粋関数)。
 * 既に IDB に同 date のドキュメントがあれば、それを尊重して返す。
 */
function generateTasksFor({ date, course, language, uid = 'guest', adaptedPreset = null }) {
  const courseDef = COURSES[course] ?? COURSES.standard;
  const totalMin  = courseDef.minutes;
  const basePreset = COURSE_PRESETS[course] ?? COURSE_PRESETS.standard;
  const preset = adaptedPreset ?? basePreset;
  const adapted = !!adaptedPreset;
  const seed = hashSeed(`${uid}:${date}:${course}:${language}${adapted ? ':adapted' : ''}`);
  const rng  = mulberry32(seed);

  const tasks = [];
  let order = 0;

  for (const item of preset) {
    const meta = TEMPLATE_META[item.type];
    if (!meta) continue;
    const units = item.units;
    const estimatedMin = Math.max(1, Math.round(units * meta.minPerUnit));

    tasks.push({
      id:           `${date}-${item.type}-${order++}`,
      type:         item.type,
      label:        `${meta.label} ${units} ${meta.unitLabel}`,
      icon:         meta.icon,
      target:       meta.target,
      params:       { units, language, course },
      estimatedMin,
      completed:    false,
      completedAt:  null,
      result:       null,
      adapted:      !!item._adapted,
    });
  }

  // 順序にランダム性を入れる (種つき) — タスク内容自体は決定的
  const shuffled = shuffleSeeded(tasks, rng);

  return {
    date,
    course,
    language,
    adapted,
    generatedAt:   Date.now(),
    tasks:         shuffled,
    totalMin,
    completedMin:  0,
    allCompleted:  false,
  };
}

// ---------- 公開 API ----------

/**
 * 本日 (または指定日) のタスクを取得。なければ生成して保存。
 * regenerate=true なら強制再生成。
 * adaptedPreset が渡されると、その preset でタスクを生成 (Phase 3 / 24-3)。
 */
export async function getOrGenerateDailyTasks({
  course, language, date = todayKey(),
  regenerate = false, adaptedPreset = null,
}) {
  const existing = await idbGet(date);
  const uid = auth.currentUser?.uid ?? 'guest';
  const wantAdapted = !!adaptedPreset;

  // 既存があり、コース・言語・adapted フラグが一致して再生成不要 → そのまま返す
  if (existing && !regenerate &&
      existing.course === course &&
      existing.language === language &&
      !!existing.adapted === wantAdapted) {
    return existing;
  }

  // 既存があるが何かが変わっている → 完了状態は引き継ぎつつ再生成
  let preservedCompletions = new Map();
  if (existing) {
    for (const t of existing.tasks) {
      if (t.completed) {
        preservedCompletions.set(t.type, { completedAt: t.completedAt, result: t.result });
      }
    }
  }

  const fresh = generateTasksFor({ date, course, language, uid, adaptedPreset });

  // 同一 type のタスクには既存の完了状態を移植
  if (preservedCompletions.size) {
    for (const t of fresh.tasks) {
      const prev = preservedCompletions.get(t.type);
      if (prev) {
        t.completed   = true;
        t.completedAt = prev.completedAt;
        t.result      = prev.result;
      }
    }
    recomputeProgress(fresh);
  }

  await idbPut(fresh);
  syncTasksToFirestore(fresh).catch((err) => console.warn('Firestore tasks sync failed:', err));

  return fresh;
}

/**
 * Phase 3: コースに対応する base preset を取得 (adapt 用)
 */
export function getBasePreset(course) {
  return COURSE_PRESETS[course] ?? COURSE_PRESETS.standard;
}

/**
 * タスクを完了 / 未完了でトグル
 */
export async function toggleTaskComplete(date, taskId, result = null) {
  const day = await idbGet(date);
  if (!day) return null;

  const t = day.tasks.find((x) => x.id === taskId);
  if (!t) return day;

  if (t.completed) {
    t.completed   = false;
    t.completedAt = null;
    t.result      = null;
  } else {
    t.completed   = true;
    t.completedAt = Date.now();
    t.result      = result;
  }

  recomputeProgress(day);
  await idbPut(day);
  syncTasksToFirestore(day).catch((err) => console.warn('Firestore tasks sync failed:', err));

  return day;
}

function recomputeProgress(day) {
  const completedMin = day.tasks
    .filter((t) => t.completed)
    .reduce((sum, t) => sum + (t.estimatedMin ?? 0), 0);
  day.completedMin = completedMin;
  day.allCompleted = day.tasks.length > 0 && day.tasks.every((t) => t.completed);
}

// ---------- Firestore 同期 ----------

async function syncTasksToFirestore(day) {
  const user = auth.currentUser;
  if (!user) return;
  await setDoc(
    doc(db, 'users', user.uid, 'dailyTasks', day.date),
    day,
    { merge: true }
  );
}

/**
 * ログイン直後に当日分を Firestore から取り込む (best-effort)。
 */
export async function pullDailyTasksFromFirestore(date = todayKey()) {
  const user = auth.currentUser;
  if (!user) return null;
  const snap = await getDoc(doc(db, 'users', user.uid, 'dailyTasks', date));
  if (!snap.exists()) return null;
  const data = snap.data();
  await idbPut(data);
  return data;
}
