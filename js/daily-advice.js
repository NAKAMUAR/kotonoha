// =====================================================================
// 言の葉 / Kotonoha — デイリー AI アドバイス
// Step 24-2/3: profile + 今日のタスク → AI で短い励まし/助言を生成
//
// 取得方法:
//   ・Ollama 利用可能 → callOllama でストリーミング (アプリ内に直接表示)
//   ・利用不可 → クラウド AI へプロンプトをコピーして新タブで開く (既存パターン)
//
// キャッシュ:
//   ・kotonoha-daily / dailySettings に key='dailyAdviceCache' で保存
//   ・有効: 同じ日 + 同じコース/言語 + プロファイルの generatedAt が変わってない間
// =====================================================================

import { openDailyDB } from './daily-settings.js';
import { buildPrompt } from './prompts.js';
import { launchProvider, callOllama, checkOllamaAvailable } from './ai-providers.js';

const STORE = 'dailySettings';
const CACHE_KEY = 'dailyAdviceCache';

// ---------- キャッシュ ----------

async function readAdviceCache() {
  const idb = await openDailyDB();
  return new Promise((resolve) => {
    const tx = idb.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(CACHE_KEY);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror   = () => resolve(null);
  });
}

async function writeAdviceCache(entry) {
  const idb = await openDailyDB();
  return new Promise((resolve, reject) => {
    const tx = idb.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key: CACHE_KEY, ...entry });
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

function cacheMatches(cache, dateKey, course, language, profileGeneratedAt) {
  return !!cache &&
         cache.dateKey === dateKey &&
         cache.course === course &&
         cache.language === language &&
         cache.profileGeneratedAt === profileGeneratedAt;
}

// ---------- 公開 API ----------

/**
 * キャッシュがあれば返す、なければ null を返す。
 */
export async function getCachedAdvice(dateKey, course, language, profileGeneratedAt) {
  const c = await readAdviceCache();
  return cacheMatches(c, dateKey, course, language, profileGeneratedAt) ? c.text : null;
}

/**
 * AI からアドバイスを取得。
 *   options: { dateKey, course, language, profile, taskLabels, providerKey, onToken? }
 *
 * 戻り値: { source: 'cache' | 'ollama' | 'launch', text: string|null, launched?: object }
 *   ・cache: text あり (キャッシュ HIT)
 *   ・ollama: text あり (ストリーミング完了)
 *   ・launch: text=null (新タブで AI を開いた、ユーザーが貼り付ける必要あり)
 */
export async function fetchAdvice({
  dateKey, course, language, profile, taskLabels = [],
  providerKey = 'claude', onToken = null, force = false,
}) {
  if (!force) {
    const c = await readAdviceCache();
    if (cacheMatches(c, dateKey, course, language, profile?.generatedAt)) {
      return { source: 'cache', text: c.text };
    }
  }

  const prompt = buildPrompt('daily-advice', providerKey, {
    profile,
    todayCourse:    course,
    todayLanguage:  language,
    todayTaskLabels: taskLabels,
  });

  // ユーザーが明示的に Ollama を選んだ場合のみ直接 API 経由で取得 (ストリーミング)。
  // 他の AI を選択した場合はユーザーの選択を尊重して新タブで起動する。
  if (providerKey === 'ollama') {
    if (!(await checkOllamaAvailable())) {
      return {
        source: 'launch',
        text:   null,
        error:  'Ollama に接続できません (http://localhost:11434 が起動していますか?)',
        prompt,
      };
    }
    try {
      const text = await callOllama(prompt, { onToken });
      await writeAdviceCache({
        dateKey, course, language,
        profileGeneratedAt: profile?.generatedAt ?? null,
        provider: 'ollama',
        text,
        savedAt: Date.now(),
      });
      return { source: 'ollama', text };
    } catch (err) {
      console.warn('Ollama advice failed:', err);
      return { source: 'launch', text: null, error: err.message, prompt };
    }
  }

  // クラウド AI: プロンプトをコピーして新タブで開く
  const launched = await launchProvider(providerKey, prompt);
  return { source: 'launch', text: null, launched, prompt };
}
