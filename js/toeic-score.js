// =====================================================================
// 言の葉 / Kotonoha — TOEIC スコア予測モジュール
// Step 12: 回答ログを IndexedDB に保存し、L+R 予測スコアを算出
// =====================================================================

const DB_NAME    = 'kotonoha-toeic';
const DB_VERSION = 1;
const STORE_RESULTS = 'results';

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const idb = e.target.result;
      if (!idb.objectStoreNames.contains(STORE_RESULTS)) {
        const s = idb.createObjectStore(STORE_RESULTS, { keyPath: 'questionId' });
        s.createIndex('part', 'part', { unique: false });
        s.createIndex('scoreLevel', 'scoreLevel', { unique: false });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror   = (e) => reject(e.target.error);
  });
  return dbPromise;
}

async function idbGetAll() {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const req = idb.transaction(STORE_RESULTS, 'readonly').objectStore(STORE_RESULTS).getAll();
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror   = () => reject(req.error);
  });
}

async function idbPut(value) {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_RESULTS, 'readwrite');
    tx.objectStore(STORE_RESULTS).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

async function idbClear() {
  const idb = await openDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE_RESULTS, 'readwrite');
    tx.objectStore(STORE_RESULTS).clear();
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

// ---------- 記録 ----------

/**
 * 問題への回答を記録。同じ questionId は最新で上書き。
 * tags から score-XXX を抽出して scoreLevel に保存。
 *
 * 不正解の場合、snapshot が渡されていれば mistakes プールにも記録。
 * （snapshot は best-effort. 渡されなければ mistake hook はスキップ）
 */
export async function recordAnswer({ questionId, correct, part, tags = [], snapshot = null }) {
  const scoreTag = tags.find((t) => t.startsWith('score-'));
  const scoreLevel = scoreTag ? parseInt(scoreTag.replace('score-', ''), 10) : null;

  await idbPut({
    questionId,
    correct: !!correct,
    part,
    scoreLevel,
    timestamp: Date.now(),
  });

  if (!correct && snapshot) {
    // dynamic import でサイクル回避
    import('./mistakes.js').then(({ recordMistake }) => {
      const source = part >= 1 && part <= 4 ? 'toeic-l' : 'toeic-r';
      recordMistake({
        source,
        refId:    questionId,
        language: 'en',
        snapshot: {
          ...snapshot,
          part,
          tags,
        },
      }).catch((err) => console.warn('mistake record failed:', err));
    }).catch(() => {});
  }
}

// ---------- 集計 ----------

/**
 * 全回答を集計してスコア予測と内訳を返す。
 * Listening = Part 1-4, Reading = Part 5-7。
 * 各セクション score = round(accuracy × 495)、合計 L+R で 10-990 範囲。
 */
export async function getScorePrediction() {
  const results = await idbGetAll();

  const listening = results.filter((r) => r.part >= 1 && r.part <= 4);
  const reading   = results.filter((r) => r.part >= 5 && r.part <= 7);

  const sectionScore = (records) => {
    if (records.length === 0) return null;
    const correct = records.filter((r) => r.correct).length;
    return Math.round((correct / records.length) * 495);
  };

  const byBand = (records) => {
    const bands = { 600: { ans: 0, ok: 0 }, 730: { ans: 0, ok: 0 }, 860: { ans: 0, ok: 0 }, 990: { ans: 0, ok: 0 } };
    for (const r of records) {
      if (!bands[r.scoreLevel]) continue;
      bands[r.scoreLevel].ans += 1;
      if (r.correct) bands[r.scoreLevel].ok += 1;
    }
    const result = {};
    for (const [band, counts] of Object.entries(bands)) {
      result[band] = {
        answered: counts.ans,
        correct:  counts.ok,
        accuracy: counts.ans > 0 ? counts.ok / counts.ans : null,
      };
    }
    return result;
  };

  return {
    listening: {
      answered: listening.length,
      correct:  listening.filter((r) => r.correct).length,
      score:    sectionScore(listening),
      byBand:   byBand(listening),
    },
    reading: {
      answered: reading.length,
      correct:  reading.filter((r) => r.correct).length,
      score:    sectionScore(reading),
      byBand:   byBand(reading),
    },
    total: (sectionScore(listening) ?? 0) + (sectionScore(reading) ?? 0),
    totalAnswered: results.length,
  };
}

export async function clearAttempts() {
  await idbClear();
}
