// =====================================================================
// 言の葉 / Kotonoha — ドラマで学ぶ（ベトナム語）
//
// ドラマの台詞を場面ごとに練習し、出てきた単語を単語帳（SRS）で復習する。
//   見る・聞く     … 台詞と訳を見ながら、1 行ずつ／通しで聞く
//   隠して言う     … ベトナム語を隠し、日本語を見て言ってから答えを確認
//   役になりきる   … 登場人物を 1 人選び、相手の台詞は自動で読み上げ、自分の番で止まる
// マイクが使える端末では、言った文を聞き取って合っているか確かめられる。
// =====================================================================

import { speak, speakAsync, stopSpeaking, SpeechSupport } from './scenarios.js';
import { openWordPlayer } from './word-player.js';

const DONE_KEY = 'kotonoha-drama-done';
const RATE = { normal: 0.9, slow: 0.6 };
const MODE_HELP = {
  listen: '台詞と訳を見ながら聞きます。♪ で 1 行ずつ、▶ で通しで再生します。色のついた単語をタップすると意味が出ます。',
  hide:   'ベトナム語を隠しています。日本語を見て声に出して言ってから、行をタップして答えを確かめましょう。',
  role:   '演じる人を選んで ▶ を押すと、相手の台詞は自動で読み上げ、あなたの番で止まります。日本語を見て言ってから「次へ」。',
};

const dr = {
  data: null,
  drama: null,
  sceneIdx: -1,
  mode: 'listen',
  role: null,
  slow: false,
  showJa: true,
  revealed: new Set(),
  words: [],
  token: 0,          // 再生を止めたら増やす（古い再生ループを止める合図）
  playing: false,
  waitNext: null,    // 役になりきる：自分の番で「次へ」を待つ
  recognizer: null,
  hooks: { showToast: () => {}, openDeck: () => {} },
};

const $ = (id) => document.getElementById(id);
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const fold = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const tokens = (t) => fold(t).replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/).filter(Boolean);

function loadDone() {
  try { return new Set(JSON.parse(localStorage.getItem(DONE_KEY) ?? '[]')); } catch { return new Set(); }
}
function markDone(sceneId) {
  const done = loadDone();
  if (done.has(sceneId)) return;
  done.add(sceneId);
  try { localStorage.setItem(DONE_KEY, JSON.stringify([...done])); } catch { /* 保存できなくても練習は続けられる */ }
}

const scene = () => dr.drama?.scenes[dr.sceneIdx] ?? null;
const who = (s) => dr.drama?.characters[s] ?? { name: s, full: s };

// ---------- データ読み込み ----------

async function ensureData() {
  if (dr.data) return true;
  try {
    const [dRes, wRes] = await Promise.all([
      fetch('./data/dramas-vi.json'),
      fetch('./data/vocabulary-vi-drama.json'),
    ]);
    if (!dRes.ok) throw new Error(`HTTP ${dRes.status}`);
    dr.data = await dRes.json();
    dr.words = wRes.ok ? await wRes.json() : [];
    dr.drama = dr.data[0] ?? null;
    return true;
  } catch (err) {
    console.error('drama load failed:', err);
    dr.hooks.showToast('ドラマのデータを読み込めませんでした');
    return false;
  }
}

// ---------- 一覧 ----------

function renderList() {
  const d = dr.drama;
  if (!d) return;
  const done = loadDone();
  const doneCount = d.scenes.filter((s) => done.has(s.id)).length;
  const words = dr.words.filter((w) => w.tags?.includes(d.id));

  $('drama-intro').innerHTML = `
    <h3 class="text-lg font-mincho font-semibold">${esc(d.title)}</h3>
    <p class="text-sm text-sumi-light mt-1">${esc(d.description)}</p>
    <div class="dr-stats">
      <span>全 ${d.scenes.length} シーン</span><span>練習済み ${doneCount}</span><span>単語 ${words.length} 語</span>
    </div>
    <div class="flex flex-wrap gap-2 mt-3">
      <button class="btn-primary text-sm" data-dr="deck">ドラマの単語を単語帳で復習</button>
      <button class="btn-secondary text-sm" data-dr="listen-words">単語を聞き流す</button>
    </div>
    <p class="text-[11px] text-sumi-soft mt-3">※${esc(d.source)}</p>`;

  $('drama-scene-grid').innerHTML = d.scenes.map((s, i) => `
    <button class="scenario-card" data-scene="${i}">
      <div class="scenario-num">${String(i + 1).padStart(2, '0')}</div>
      <div class="scenario-title pr-8">${esc(s.title)}${done.has(s.id) ? '<span class="scenario-done-badge">練習済</span>' : ''}</div>
      <div class="scenario-desc">${esc(s.summary)}</div>
      <div class="text-[10px] text-sumi-soft mt-2 font-cormorant tracking-widest">${esc(s.time)} ・ ${s.lines.length} 行</div>
    </button>`).join('');
}

function showList() {
  stopAll();
  dr.sceneIdx = -1;
  $('drama-detail-view')?.classList.add('hidden');
  $('drama-list-view')?.classList.remove('hidden');
  renderList();
}

// ---------- シーン ----------

function openScene(i) {
  if (!dr.drama?.scenes[i]) return;
  stopAll();
  dr.sceneIdx = i;
  dr.revealed = new Set();
  const s = scene();
  const speakers = [...new Set(s.lines.map((l) => l.s))];
  if (!speakers.includes(dr.role)) dr.role = speakers[0];

  $('drama-list-view')?.classList.add('hidden');
  $('drama-detail-view')?.classList.remove('hidden');
  $('drama-scene-num').textContent = String(i + 1).padStart(2, '0');
  $('drama-scene-title').textContent = s.title;
  $('drama-scene-summary').textContent = s.summary;
  $('drama-scene-meta').textContent = `${s.time} ・ 登場: ${speakers.map((sp) => who(sp).name).join('、')}`;
  $('drama-prev').disabled = i === 0;
  $('drama-next').disabled = i === dr.drama.scenes.length - 1;
  renderControls();
  renderLines();
  renderSceneWords();
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function renderControls() {
  document.querySelectorAll('#drama-mode-tabs .tab').forEach((t) => t.classList.toggle('tab-active', t.dataset.mode === dr.mode));
  $('drama-mode-help').textContent = MODE_HELP[dr.mode];
  $('drama-slow').classList.toggle('chip-active', dr.slow);
  $('drama-ja').classList.toggle('chip-active', dr.showJa);
  $('drama-play').textContent = dr.mode === 'role' ? '▶ 練習スタート' : '▶ 通しで再生';

  const roleRow = $('drama-role-row');
  roleRow.classList.toggle('hidden', dr.mode !== 'role');
  const s = scene();
  if (s && dr.mode === 'role') {
    const speakers = [...new Set(s.lines.map((l) => l.s))];
    roleRow.innerHTML = `<span class="text-xs text-sumi-soft mr-1">演じる人:</span>` + speakers.map((sp) => `
      <button class="chip ${sp === dr.role ? 'chip-active' : ''}" data-role="${esc(sp)}">${esc(who(sp).full)}</button>`).join('');
  }
}

/** 台詞の中の「このドラマの単語」に印をつける（HTML エスケープ後の文字列に対して） */
function markWords(text) {
  const s = scene();
  let html = esc(text);
  const list = dr.words.filter((w) => w.scene === s?.id).sort((a, b) => b.word.length - a.word.length);
  for (const w of list) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}>])(${esc(w.word).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})(?![\\p{L}\\p{N}<])`, 'iu');
    html = html.replace(re, `<span class="dr-word" data-word="${esc(w.id)}">$1</span>`);
  }
  return html;
}

function isHidden(line, i) {
  if (dr.revealed.has(i)) return false;
  if (dr.mode === 'hide') return true;
  if (dr.mode === 'role') return line.s === dr.role;
  return false;
}

function renderLines() {
  const s = scene();
  const box = $('drama-lines');
  if (!s || !box) return;
  const speakers = [...new Set(s.lines.map((l) => l.s))];
  box.innerHTML = s.lines.map((l, i) => {
    const hidden = isHidden(l, i);
    const mine = dr.mode === 'role' && l.s === dr.role;
    return `
      <div class="dr-line ${mine ? 'dr-line-mine' : ''}" data-i="${i}">
        <div class="dr-avatar dr-sp-${speakers.indexOf(l.s) % 5}">${esc(who(l.s).name.charAt(0))}</div>
        <div class="dr-body">
          <div class="dr-name">${esc(who(l.s).name)}${mine ? ' <span class="dr-you">あなた</span>' : ''}</div>
          ${hidden
            ? `<button class="dr-vi dr-vi-hidden" data-act="reveal">タップして答えを見る</button>`
            : `<div class="dr-vi">${markWords(l.vi)}</div>`}
          <div class="dr-ja ${dr.showJa || hidden ? '' : 'hidden'}">${esc(l.ja)}</div>
          ${l.note && !hidden ? `<div class="dr-note">💡 ${esc(l.note)}</div>` : ''}
          <div class="dr-result hidden"></div>
        </div>
        <div class="dr-btns">
          <button class="dialogue-tts" data-act="play" aria-label="読み上げ" ${SpeechSupport.tts ? '' : 'disabled'}>♪</button>
          ${SpeechSupport.stt && dr.mode !== 'listen' ? '<button class="dialogue-tts" data-act="mic" aria-label="言ってみる">🎙</button>' : ''}
        </div>
      </div>`;
  }).join('');
}

function renderSceneWords() {
  const s = scene();
  const list = dr.words.filter((w) => w.scene === s?.id);
  $('drama-words-card').classList.toggle('hidden', list.length === 0);
  $('drama-words').innerHTML = list.map((w) => `
    <button class="dr-word-row" data-word="${esc(w.id)}">
      <span class="dr-word-vi">${esc(w.word)}</span>
      <span class="dr-word-reading">${esc(w.reading)}</span>
      <span class="dr-word-ja">${esc(w.meaning)}</span>
    </button>`).join('');
}

function lineEl(i) { return $('drama-lines')?.querySelector(`.dr-line[data-i="${i}"]`); }

function reveal(i) {
  dr.revealed.add(i);
  const el = lineEl(i);
  if (!el) return;
  const l = scene().lines[i];
  const btn = el.querySelector('.dr-vi-hidden');
  if (btn) {
    const div = document.createElement('div');
    div.className = 'dr-vi';
    div.innerHTML = markWords(l.vi);
    btn.replaceWith(div);
    if (l.note && !el.querySelector('.dr-note')) {
      el.querySelector('.dr-ja')?.insertAdjacentHTML('afterend', `<div class="dr-note">💡 ${esc(l.note)}</div>`);
    }
  }
  if (!dr.showJa) el.querySelector('.dr-ja')?.classList.add('hidden');
}

function sayLine(i) {
  const l = scene()?.lines[i];
  if (!l) return;
  if (!SpeechSupport.tts) { dr.hooks.showToast('お使いのブラウザは読み上げに対応していません'); return; }
  stopAll();
  speak(l.vi, 'vi', { rate: dr.slow ? RATE.slow : RATE.normal });
}

function showWord(id) {
  const w = dr.words.find((x) => x.id === id);
  if (!w) return;
  dr.hooks.showToast(`${w.word}（${w.reading}）＝ ${w.meaning}`, 3500);
  if (SpeechSupport.tts && !dr.playing) speak(w.word, 'vi', { rate: RATE.slow });
}

// ---------- 通し再生・役になりきる ----------

function setCurrent(i) {
  $('drama-lines')?.querySelectorAll('.dr-line').forEach((el) => el.classList.toggle('dr-line-current', Number(el.dataset.i) === i));
  if (i >= 0) lineEl(i)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function setTurnBar(show, text = '') {
  $('drama-turn-bar')?.classList.toggle('hidden', !show);
  if (show) $('drama-turn-text').textContent = text;
}

function stopAll() {
  dr.token += 1;
  dr.playing = false;
  dr.waitNext?.(false);
  dr.waitNext = null;
  stopSpeaking();
  if (dr.recognizer) { try { dr.recognizer.abort(); } catch { /* ignore */ } dr.recognizer = null; }
  setCurrent(-1);
  setTurnBar(false);
}

async function playScene() {
  const s = scene();
  if (!s) return;
  if (!SpeechSupport.tts) { dr.hooks.showToast('お使いのブラウザは読み上げに対応していません'); return; }
  stopAll();
  const my = dr.token;
  dr.playing = true;
  const rate = dr.slow ? RATE.slow : RATE.normal;

  for (let i = 0; i < s.lines.length; i++) {
    if (my !== dr.token) return;
    const l = s.lines[i];
    setCurrent(i);
    if (dr.mode === 'role' && l.s === dr.role) {
      setTurnBar(true, `あなたの番：「${l.ja}」をベトナム語で言ってみましょう`);
      const go = await new Promise((resolve) => { dr.waitNext = resolve; });
      dr.waitNext = null;
      if (!go || my !== dr.token) return;
      setTurnBar(false);
      continue;
    }
    await speakAsync(l.vi, 'vi', { rate });
    if (my !== dr.token) return;
    await new Promise((r) => setTimeout(r, 350));
  }
  if (my !== dr.token) return;
  dr.playing = false;
  setCurrent(-1);
  markDone(s.id);
  dr.hooks.showToast(dr.mode === 'role' ? 'おつかれさまでした！最後まで演じきりました' : 'シーンを最後まで聞きました');
}

function currentTurnIndex() {
  const el = $('drama-lines')?.querySelector('.dr-line-current');
  return el ? Number(el.dataset.i) : -1;
}

// ---------- 発音チェック（音声認識） ----------

function matchRatio(target, heard) {
  const a = tokens(target);
  const b = tokens(heard);
  if (a.length === 0) return 0;
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] + 1 : Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[a.length][b.length] / a.length;
}

function listen(i, btn) {
  if (dr.recognizer) { try { dr.recognizer.stop(); } catch { /* ignore */ } return; }
  const l = scene()?.lines[i];
  const el = lineEl(i);
  if (!l || !el) return;
  stopSpeaking();
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.lang = 'vi-VN';
  rec.interimResults = false;
  rec.maxAlternatives = 3;
  const result = el.querySelector('.dr-result');
  result.className = 'dr-result';
  result.textContent = '聞いています… ベトナム語で言ってください';
  btn.textContent = '⏹';

  let got = false;
  rec.onresult = (e) => {
    got = true;
    const alts = [...e.results[0]].map((a) => a.transcript);
    const best = Math.max(...alts.map((h) => matchRatio(l.vi, h)));
    const heard = alts[0];
    const pct = Math.round(best * 100);
    if (best >= 0.8) {
      result.classList.add('dr-result-ok');
      result.innerHTML = `◎ よく言えました！（${pct}%）<span class="dr-heard">聞き取られた文: ${esc(heard)}</span>`;
    } else if (best >= 0.5) {
      result.classList.add('dr-result-mid');
      result.innerHTML = `○ おしい！（${pct}%）♪ で聞き直してもう一度。<span class="dr-heard">聞き取られた文: ${esc(heard)}</span>`;
    } else {
      result.classList.add('dr-result-retry');
      result.innerHTML = `もう一度！（${pct}%）<span class="dr-heard">聞き取られた文: ${esc(heard)}</span>`;
    }
    reveal(i);
  };
  rec.onerror = (e) => {
    result.classList.add('dr-result-retry');
    result.textContent = e.error === 'not-allowed'
      ? 'マイクが使えません。ブラウザの設定でマイクを「許可」にしてください。'
      : '聞き取れませんでした。もう一度ためしてください。';
  };
  rec.onend = () => {
    dr.recognizer = null;
    btn.textContent = '🎙';
    if (!got && result.textContent.startsWith('聞いています')) result.textContent = '聞き取れませんでした。もう一度ためしてください。';
  };
  dr.recognizer = rec;
  try { rec.start(); } catch { dr.recognizer = null; btn.textContent = '🎙'; }
}

// ---------- 単語 ----------

function dramaWords(sceneId = null) {
  return dr.words
    .filter((w) => w.tags?.includes(dr.drama?.id) && (!sceneId || w.scene === sceneId))
    .map((w) => ({ ...w, lang: 'vi', deck: 'vidrama' }));
}

// ---------- 初期化 ----------

export function initDrama(hooks = {}) {
  Object.assign(dr.hooks, hooks);

  $('drama-intro')?.addEventListener('click', (e) => {
    const act = e.target.closest('[data-dr]')?.dataset.dr;
    if (act === 'deck') dr.hooks.openDeck('vidrama', 'vi');
    if (act === 'listen-words') {
      const list = dramaWords();
      if (list.length) openWordPlayer({ words: list, lang: 'vi', title: `${dr.drama.title} の単語` });
    }
  });
  $('drama-scene-grid')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-scene]');
    if (b) openScene(Number(b.dataset.scene));
  });
  $('drama-back')?.addEventListener('click', showList);
  $('drama-prev')?.addEventListener('click', () => openScene(dr.sceneIdx - 1));
  $('drama-next')?.addEventListener('click', () => openScene(dr.sceneIdx + 1));

  $('drama-mode-tabs')?.addEventListener('click', (e) => {
    const t = e.target.closest('[data-mode]');
    if (!t || t.dataset.mode === dr.mode) return;
    stopAll();
    dr.mode = t.dataset.mode;
    dr.revealed = new Set();
    renderControls();
    renderLines();
  });
  $('drama-role-row')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-role]');
    if (!b) return;
    stopAll();
    dr.role = b.dataset.role;
    dr.revealed = new Set();
    renderControls();
    renderLines();
  });
  $('drama-slow')?.addEventListener('click', () => { dr.slow = !dr.slow; renderControls(); });
  $('drama-ja')?.addEventListener('click', () => {
    dr.showJa = !dr.showJa;
    renderControls();
    $('drama-lines')?.querySelectorAll('.dr-line').forEach((el) => {
      const hidden = !!el.querySelector('.dr-vi-hidden');
      el.querySelector('.dr-ja')?.classList.toggle('hidden', !(dr.showJa || hidden));
    });
  });
  $('drama-play')?.addEventListener('click', playScene);
  $('drama-stop')?.addEventListener('click', stopAll);

  $('drama-lines')?.addEventListener('click', (e) => {
    const row = e.target.closest('.dr-line');
    if (!row) return;
    const i = Number(row.dataset.i);
    const word = e.target.closest('.dr-word');
    if (word) { showWord(word.dataset.word); return; }
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'play') sayLine(i);
    else if (act === 'mic') listen(i, e.target.closest('[data-act]'));
    else if (act === 'reveal') reveal(i);
  });

  $('drama-words')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-word]');
    if (b) showWord(b.dataset.word);
  });
  $('drama-words-deck')?.addEventListener('click', () => dr.hooks.openDeck('vidrama', 'vi'));
  $('drama-words-listen')?.addEventListener('click', () => {
    const list = dramaWords(scene()?.id);
    if (list.length) openWordPlayer({ words: list, lang: 'vi', title: `「${scene().title}」の単語` });
  });

  // 役になりきる：自分の番の操作
  $('drama-turn-answer')?.addEventListener('click', () => {
    const i = currentTurnIndex();
    if (i < 0) return;
    reveal(i);
    const l = scene().lines[i];
    if (SpeechSupport.tts) speak(l.vi, 'vi', { rate: dr.slow ? RATE.slow : RATE.normal });
  });
  $('drama-turn-next')?.addEventListener('click', () => {
    const i = currentTurnIndex();
    if (i >= 0) reveal(i);
    stopSpeaking();
    dr.waitNext?.(true);
  });
}

export async function activateDramaScreen() {
  if (!(await ensureData())) return;
  if (dr.sceneIdx >= 0) return;   // シーンを開いたまま戻ってきたときはそのまま
  showList();
}

export function leaveDramaScreen() {
  stopAll();
}
