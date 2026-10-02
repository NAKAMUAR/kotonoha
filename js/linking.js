// =====================================================================
// 言の葉 / Kotonoha — 英語リンキング（音のつながり）練習
//
// data/linking-en.json の記法:
//   ‿     … 前後の単語の音がつながる
//   [x]   … 音が変わる部分（t→ラ行の音、t+you→チュ など）
//   (x)   … ほとんど聞こえない（消える）音
//   {w}   … 単語の間に入る軽い音（w / y）
// =====================================================================

import { speak, stopSpeaking, pickVoice, SpeechSupport } from './scenarios.js';

const DONE_KEY = 'kotonoha.linking.done';

const lk = {
  data:       null,
  catId:      null,
  playing:    null,   // { cancel() } 連続再生・シャドーイング中
  recognizer: null,
  toast:      () => {},
};

// ---------- 保存（この端末のみ） ----------

function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]')); } catch { return new Set(); }
}
function saveDone(set) {
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...set])); } catch { /* 保存できなくても練習は続けられる */ }
}

// ---------- 表示 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function renderLinked(linked) {
  return esc(linked)
    .replace(/\{(\w+)\}/g, '<sup class="lk-ins">$1</sup>')
    .replace(/\[([^\]]+)\]/g, '<span class="lk-chg">$1</span>')
    .replace(/\(([^)]+)\)/g, '<span class="lk-drop">$1</span>')
    .replace(/‿/g, '<span class="lk-arc" aria-label="つながる"></span>');
}

function currentCategory() {
  return lk.data?.categories.find((c) => c.id === lk.catId) ?? lk.data?.categories[0];
}

function renderCategoryRow() {
  const row = document.getElementById('lk-cat-row');
  if (!row || !lk.data) return;
  row.innerHTML = lk.data.categories.map((c) => `
    <button class="chip ${c.id === lk.catId ? 'chip-active' : ''}" data-lk-cat="${esc(c.id)}">
      <span class="lk-chip-icon">${esc(c.icon)}</span>${esc(c.title)}
    </button>`).join('');
}

function renderCategory() {
  const cat = currentCategory();
  if (!cat) return;
  const done = loadDone();
  const doneCount = cat.items.filter((it) => done.has(it.id)).length;

  document.getElementById('lk-rule').textContent = cat.rule;
  document.getElementById('lk-tip').textContent  = cat.tip;
  document.getElementById('lk-cat-title').textContent = cat.title;
  document.getElementById('lk-done').textContent = `言えた文: ${doneCount} / ${cat.items.length}`;

  const canSpeak  = SpeechSupport.tts;
  const canListen = SpeechSupport.stt;
  document.getElementById('lk-list').innerHTML = cat.items.map((it) => `
    <div class="lk-item ${done.has(it.id) ? 'lk-item-done' : ''}" data-lk-id="${esc(it.id)}">
      <div class="lk-linked">${renderLinked(it.linked)}${done.has(it.id) ? '<span class="lk-badge">言えた</span>' : ''}</div>
      <div class="lk-sound"><span class="lk-label">聞こえ方</span>${esc(it.sound)}</div>
      ${it.casual ? `<div class="lk-casual"><span class="lk-label">くだけた書き方</span>${esc(it.casual)}</div>` : ''}
      <div class="lk-ja">${esc(it.ja)}</div>
      <details class="lk-note"><summary>ポイント</summary>${esc(it.note)}</details>
      <div class="lk-actions">
        ${canSpeak ? `
        <button class="audio-btn audio-btn-sm" data-lk-play="natural">🔊 自然な速さ</button>
        <button class="audio-btn audio-btn-sm" data-lk-play="slow">🐢 ゆっくり</button>
        <button class="audio-btn audio-btn-sm" data-lk-play="words">🧩 1語ずつ</button>` : ''}
        ${canListen ? '<button class="audio-btn audio-btn-sm lk-mic" data-lk-mic="1">🎙 言ってみる</button>' : ''}
      </div>
      <div class="lk-result hidden"></div>
    </div>`).join('');
}

// ---------- 音声 ----------

// 自然な速さの再生には、くだけた書き方（gonna など）があればそちらを使う
function naturalText(it) { return it.casual ?? it.text; }

function speakAsync(text, rate) {
  return new Promise((resolve) => {
    if (!SpeechSupport.tts || !text) { resolve(0); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'en-US';
    u.rate = rate;
    const voice = pickVoice('en');
    if (voice) u.voice = voice;
    const started = Date.now();
    u.onend   = () => resolve(Date.now() - started);
    u.onerror = () => resolve(0);
    speechSynthesis.speak(u);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function stopPlayback() {
  if (lk.playing) { lk.playing.cancel(); lk.playing = null; }
  stopSpeaking();
  document.querySelectorAll('.lk-item-playing').forEach((el) => el.classList.remove('lk-item-playing'));
  setSeqButtons(false);
}

function setSeqButtons(running) {
  document.getElementById('lk-stop')?.classList.toggle('hidden', !running);
  document.getElementById('lk-play-all')?.classList.toggle('hidden', running);
  document.getElementById('lk-shadow')?.classList.toggle('hidden', running);
}

async function playItem(it, mode) {
  stopPlayback();
  if (mode === 'natural') { speak(naturalText(it), 'en', { rate: 1.0 }); return; }
  if (mode === 'slow')    { speak(naturalText(it), 'en', { rate: 0.6 }); return; }
  // 1語ずつ: つながる前の音と聞き比べる
  speechSynthesis.cancel();
  let cancelled = false;
  lk.playing = { cancel: () => { cancelled = true; } };
  for (const w of it.text.split(/\s+/)) {
    if (cancelled) return;
    await speakAsync(w.replace(/[.,!?]/g, ''), 0.85);
    await wait(250);
  }
  lk.playing = null;
}

// 連続再生（shadow = true なら、1文ごとに「まねして言う」ための間を空ける）
async function playSequence(shadow) {
  stopPlayback();
  const cat = currentCategory();
  if (!cat) return;
  let cancelled = false;
  lk.playing = { cancel: () => { cancelled = true; speechSynthesis.cancel(); } };
  setSeqButtons(true);
  for (const it of cat.items) {
    if (cancelled) break;
    const el = document.querySelector(`.lk-item[data-lk-id="${it.id}"]`);
    document.querySelectorAll('.lk-item-playing').forEach((e) => e.classList.remove('lk-item-playing'));
    el?.classList.add('lk-item-playing');
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    const ms = await speakAsync(naturalText(it), 1.0);
    if (cancelled) break;
    await wait(shadow ? Math.max(1500, ms * 1.4) : 700);
  }
  if (!cancelled) stopPlayback();
}

// ---------- 発音チェック（音声認識） ----------

const REDUCTIONS = {
  gonna: 'going to', wanna: 'want to', gotta: 'got to', lemme: 'let me', gimme: 'give me',
  kinda: 'kind of', dunno: 'dont know', hafta: 'have to', whaddaya: 'what do you', gotcha: 'got you',
  shoulda: 'should have', coulda: 'could have', whatcha: 'what are you', okay: 'ok',
};

function normWords(s) {
  return String(s ?? '').toLowerCase()
    .replace(/[’']/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/).filter(Boolean)
    .flatMap((w) => (REDUCTIONS[w] ?? w).split(' '));
}

// 目標の文の単語のうち、順番どおりに言えた割合（最長共通部分列）
function matchRatio(target, heard) {
  const a = normWords(target), b = normWords(heard);
  if (a.length === 0) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length] / a.length;
}

function listenFor(it, itemEl, btn) {
  if (lk.recognizer) { try { lk.recognizer.stop(); } catch { /* ignore */ } return; }
  stopPlayback();
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  const result = itemEl.querySelector('.lk-result');
  result.classList.remove('hidden');
  result.className = 'lk-result';
  result.textContent = '聞いています… 英文を言ってください';
  btn.textContent = '⏹ やめる';

  let got = false;
  rec.onresult = (e) => {
    got = true;
    const alts = [...e.results[0]].map((a) => a.transcript);
    const best = Math.max(...alts.map((h) => Math.max(matchRatio(it.text, h), it.casual ? matchRatio(it.casual, h) : 0)));
    const heard = alts[0];
    if (best >= 0.8) {
      result.classList.add('lk-result-ok');
      result.innerHTML = `◎ よく言えました！<span class="lk-heard">聞き取られた文: ${esc(heard)}</span>`;
      const done = loadDone(); done.add(it.id); saveDone(done);
      itemEl.classList.add('lk-item-done');
      const cat = currentCategory();
      document.getElementById('lk-done').textContent =
        `言えた文: ${cat.items.filter((x) => done.has(x.id)).length} / ${cat.items.length}`;
    } else {
      result.classList.add('lk-result-retry');
      result.innerHTML = `もう一度！ 音のつながりを意識して言ってみましょう。<span class="lk-heard">聞き取られた文: ${esc(heard)}</span>`;
    }
  };
  rec.onerror = (e) => {
    result.classList.add('lk-result-retry');
    result.textContent = e.error === 'not-allowed'
      ? 'マイクが使えません。ブラウザのアドレス欄の🔒からマイクを「許可」にしてください。'
      : '聞き取れませんでした。もう一度ためしてください。';
  };
  rec.onend = () => {
    lk.recognizer = null;
    btn.textContent = '🎙 言ってみる';
    if (!got && result.textContent.startsWith('聞いています')) result.textContent = '聞き取れませんでした。もう一度ためしてください。';
  };
  lk.recognizer = rec;
  rec.start();
}

// ---------- 初期化 ----------

export async function activateLinkingScreen() {
  if (!lk.data) {
    try {
      const res = await fetch('./data/linking-en.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      lk.data = await res.json();
      lk.catId = lk.data.categories[0]?.id ?? null;
    } catch (err) {
      console.error('linking load failed:', err);
      lk.toast('リンキング練習のデータを読み込めませんでした');
      return;
    }
  }
  renderCategoryRow();
  renderCategory();
  document.getElementById('lk-voice-note')?.classList.toggle('hidden', SpeechSupport.tts);
}

export function leaveLinkingScreen() {
  stopPlayback();
  if (lk.recognizer) { try { lk.recognizer.abort(); } catch { /* ignore */ } lk.recognizer = null; }
}

export function initLinking({ showToast } = {}) {
  if (showToast) lk.toast = showToast;

  document.getElementById('lk-cat-row')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-lk-cat]');
    if (!chip) return;
    leaveLinkingScreen();
    lk.catId = chip.dataset.lkCat;
    renderCategoryRow();
    renderCategory();
  });

  document.getElementById('lk-list')?.addEventListener('click', (e) => {
    const itemEl = e.target.closest('.lk-item');
    if (!itemEl) return;
    const it = currentCategory()?.items.find((x) => x.id === itemEl.dataset.lkId);
    if (!it) return;
    const play = e.target.closest('[data-lk-play]');
    if (play) { playItem(it, play.dataset.lkPlay); return; }
    const mic = e.target.closest('[data-lk-mic]');
    if (mic) listenFor(it, itemEl, mic);
  });

  document.getElementById('lk-play-all')?.addEventListener('click', () => playSequence(false));
  document.getElementById('lk-shadow')?.addEventListener('click', () => playSequence(true));
  document.getElementById('lk-stop')?.addEventListener('click', () => stopPlayback());
}
