// =====================================================================
// 言の葉 / Kotonoha — シナリオモジュール
// Step 5: 30 シナリオの読込・一覧・詳細表示・TTS（Web Speech API）
// =====================================================================

let scenariosCache = null;

export async function loadScenarios() {
  if (scenariosCache) return scenariosCache;
  try {
    const res = await fetch('./data/scenarios.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    scenariosCache = await res.json();
    return scenariosCache;
  } catch (err) {
    console.error('scenarios load failed:', err);
    scenariosCache = [];
    return scenariosCache;
  }
}

export async function getScenariosByPhase(phase = 1) {
  const all = await loadScenarios();
  return all.filter((s) => s.phase === phase).sort((a, b) => a.order - b.order);
}

export async function getScenarioById(id) {
  const all = await loadScenarios();
  return all.find((s) => s.id === id) ?? null;
}

// ---------- 音声合成 (Web Speech API) ----------

export const SpeechSupport = {
  tts: typeof window !== 'undefined' && 'speechSynthesis' in window,
  stt: typeof window !== 'undefined' &&
       (typeof window.SpeechRecognition === 'function' ||
        typeof window.webkitSpeechRecognition === 'function'),
};

const LANG_BCP47 = {
  en: 'en-US',
  vi: 'vi-VN',
  ja: 'ja-JP',
};

let currentUtterance = null;

export function speak(text, lang = 'en', { rate = 0.9, pitch = 1.0 } = {}) {
  if (!SpeechSupport.tts) return false;
  if (!text) return false;

  // 既存の発話を中断
  speechSynthesis.cancel();

  const u = new SpeechSynthesisUtterance(text);
  u.lang  = LANG_BCP47[lang] ?? lang;
  u.rate  = rate;
  u.pitch = pitch;

  // 適合する音声があれば優先
  const voices = speechSynthesis.getVoices();
  const match  = voices.find((v) => v.lang.toLowerCase().startsWith(u.lang.toLowerCase().split('-')[0]));
  if (match) u.voice = match;

  currentUtterance = u;
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking() {
  if (SpeechSupport.tts) speechSynthesis.cancel();
  currentUtterance = null;
}

/**
 * シナリオのダイアログを順に読み上げる（A/B 交互）
 * 戻り値: stop() で中断
 */
export function speakDialogue(dialogue, lang, { rate = 0.9, gapMs = 500 } = {}) {
  if (!SpeechSupport.tts) return { stop: () => {}, finished: Promise.resolve(false) };
  speechSynthesis.cancel();

  let cancelled = false;
  const finished = (async () => {
    for (const turn of dialogue) {
      if (cancelled) return false;
      const text = turn[lang];
      if (!text) continue;
      await new Promise((resolve) => {
        const u = new SpeechSynthesisUtterance(text);
        u.lang  = LANG_BCP47[lang] ?? lang;
        u.rate  = rate;
        u.onend = () => setTimeout(resolve, gapMs);
        u.onerror = () => resolve();
        const voices = speechSynthesis.getVoices();
        const match  = voices.find((v) => v.lang.toLowerCase().startsWith(u.lang.toLowerCase().split('-')[0]));
        if (match) u.voice = match;
        speechSynthesis.speak(u);
      });
    }
    return !cancelled;
  })();

  return {
    stop: () => { cancelled = true; speechSynthesis.cancel(); },
    finished,
  };
}

// 音声リストの初回ロードトリガー（ブラウザによっては getVoices() が初回空配列を返す）
if (typeof window !== 'undefined' && SpeechSupport.tts) {
  speechSynthesis.getVoices();
  speechSynthesis.onvoiceschanged = () => speechSynthesis.getVoices();
}
