// =====================================================================
// 言の葉 / Kotonoha — TOEIC Listening モジュール
// Step 10: Part 1-4 のリスニング演習
// =====================================================================

import { speak, stopSpeaking, SpeechSupport } from './scenarios.js';

let listeningCache = null;

export async function loadListening() {
  if (listeningCache) return listeningCache;
  try {
    const res = await fetch('./data/toeic-listening.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    listeningCache = await res.json();
  } catch (err) {
    console.error('listening load failed:', err);
    listeningCache = [];
  }
  return listeningCache;
}

export async function getQuestionsByPart(part) {
  const all = await loadListening();
  const records = all.filter((q) => q.part === part);

  // Part 3/4 は 1 レコード = 1 会話/トーク + 内部に複数 Q。学習画面では Q 単位で進めるため flatten。
  if (part === 3 || part === 4) {
    const flat = [];
    for (const r of records) {
      const subs = r.questions ?? [];
      subs.forEach((sq, i) => {
        flat.push({
          ...sq,
          part: r.part,
          parentId:    r.id,
          conversation: r.conversation,
          talk:         r.talk,
          talkType:     r.talkType,
          subIndex: i,
          totalSub: subs.length,
          tags:  r.tags,
          level: r.level,
        });
      });
    }
    return flat;
  }

  return records;
}

// ---------- TTS シーケンス再生 ----------
// 既存 scenarios.js の speak() を順に呼び出す。

let activeSequence = null;

/**
 * 文字列の配列を順に読み上げる。speed は 0.7-1.5 倍。
 * 戻り値: stop()（途中停止）
 */
export function playSequence(lines, { rate = 0.9, gapMs = 700, voiceLang = 'en' } = {}) {
  stopAudio();

  let cancelled = false;
  let timer = null;

  const run = (idx) => {
    if (cancelled || idx >= lines.length) {
      activeSequence = null;
      return;
    }
    const text = lines[idx];
    speak(text, voiceLang, { rate });

    // utterance 終了を onend で待つ — Web Speech API のイベント
    const u = window.speechSynthesis;
    const checkDone = () => {
      if (cancelled) return;
      if (!u.speaking && !u.pending) {
        timer = setTimeout(() => run(idx + 1), gapMs);
      } else {
        timer = setTimeout(checkDone, 100);
      }
    };
    timer = setTimeout(checkDone, 100);
  };

  run(0);

  const stop = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    stopSpeaking();
    activeSequence = null;
  };

  activeSequence = { stop };
  return stop;
}

export function stopAudio() {
  if (activeSequence) {
    activeSequence.stop();
    activeSequence = null;
  } else {
    stopSpeaking();
  }
}

// ---------- Part ごとの再生用ヘルパー ----------

export function playPart1(question, rate = 0.9) {
  const lines = question.choices.map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`);
  return playSequence(lines, { rate, gapMs: 800 });
}

export function playPart2(question, rate = 0.9) {
  const q = question.question ?? '';
  const responses = question.choices.map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`);
  return playSequence([q, ...responses], { rate, gapMs: 800 });
}

// 会話を話者ごとのピッチ差で順次再生（M=低め / W=高め）。
export function playConversation(conversation, rate = 0.9) {
  stopAudio();
  if (!Array.isArray(conversation) || conversation.length === 0) return () => {};

  let cancelled = false;
  let timer = null;

  const run = (idx) => {
    if (cancelled || idx >= conversation.length) {
      activeSequence = null;
      return;
    }
    const turn = conversation[idx];
    const pitch = (turn.speaker === 'M') ? 0.85 : (turn.speaker === 'W') ? 1.15 : 1.0;
    speak(turn.line, 'en', { rate, pitch });

    const u = window.speechSynthesis;
    const checkDone = () => {
      if (cancelled) return;
      if (!u.speaking && !u.pending) {
        timer = setTimeout(() => run(idx + 1), 600);
      } else {
        timer = setTimeout(checkDone, 100);
      }
    };
    timer = setTimeout(checkDone, 100);
  };

  run(0);

  const stop = () => {
    cancelled = true;
    if (timer) clearTimeout(timer);
    stopSpeaking();
    activeSequence = null;
  };
  activeSequence = { stop };
  return stop;
}

// Part 3: 会話 → 設問読み上げ
export function playPart3(question, rate = 0.9) {
  return playConversation(question.conversation ?? [], rate);
}

// Part 4: トーク本文を 1 ナレーターで読み上げ
export function playPart4(question, rate = 0.9) {
  const text = question.talk ?? '';
  if (!text) return () => {};
  return playSequence([text], { rate, gapMs: 0 });
}

export { SpeechSupport };
