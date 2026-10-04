// =====================================================================
// 言の葉 / Kotonoha — 単語の連続読み上げ（聞き流しプレーヤー）
//
// 単語の一覧や単語帳の並びを、画面に表示しながら順番に読み上げる。
//   覚えるモード   … 外国語 →（ゆっくり）→ 日本語の意味 → 例文 → 例文の訳
//   思い出すモード … 日本語の意味 → 考える間 → 外国語 → 例文 …（答えを思い出す練習）
// 設定はこの端末（localStorage）に保存する。
// =====================================================================

import { SpeechSupport, speakAsync, stopSpeaking, hasVoiceFor } from './scenarios.js';

const STORE_KEY = 'kotonoha.wordPlayer';
const DEFAULTS = Object.freeze({
  mode: 'learn',                    // learn | recall
  parts: { slow: false, meaning: true, example: true, exTrans: false },
  repeat: 1,                        // 外国語の単語を何回読むか
  rate: 0.9,
  gap: 1.5,                         // 項目と項目の間（秒）
  loop: false,
  shuffle: false,
});
const LANG_NAME = { en: '英語', vi: 'ベトナム語' };

const p = {
  words: [], order: [], lang: 'en', title: '',
  i: 0, playing: false, token: 0, part: null,
  wakeLock: null, el: null,
  settings: loadSettings(),
};

function loadSettings() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? '{}');
    return { ...DEFAULTS, ...s, parts: { ...DEFAULTS.parts, ...(s.parts ?? {}) } };
  } catch { return { ...DEFAULTS, parts: { ...DEFAULTS.parts } }; }
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(p.settings)); } catch { /* 保存できなくても再生は続ける */ }
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
// 「năm (年)」の括弧書きや「...」は読まない
const speakable = (t) => String(t ?? '').replace(/\s*[（(][^）)]*[）)]/g, '').replace(/\.{3}|…/g, ' ').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function shuffled(n) {
  const a = [...Array(n).keys()];
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ---------- 画面を消さない（読み上げが止まらないように） ----------

async function keepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !p.wakeLock) {
      p.wakeLock = await navigator.wakeLock.request('screen');
      p.wakeLock.addEventListener?.('release', () => { p.wakeLock = null; });
    } else if (!on && p.wakeLock) {
      await p.wakeLock.release();
      p.wakeLock = null;
    }
  } catch { /* 対応していない端末では何もしない */ }
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && p.playing) keepAwake(true);
});

// ---------- 読み上げの手順 ----------

function current() { return p.words[p.order[p.i]]; }
function wordLang(w) { return w?.lang ?? p.lang; }

/** 1 語分の読み上げ手順 [{ part, text, lang, rate, pauseAfter }] */
function steps(w) {
  const s = p.settings;
  const lang = wordLang(w);
  const gap = s.gap * 1000;
  const jaOk = hasVoiceFor('ja') !== false;
  const word = speakable(w.word);
  const out = [];
  const wordSteps = () => {
    for (let k = 0; k < s.repeat; k++) out.push({ part: 'word', text: word, lang, rate: s.rate, pauseAfter: k < s.repeat - 1 ? 600 : gap });
    if (s.parts.slow) out.push({ part: 'word', text: word, lang, rate: Math.max(0.5, s.rate * 0.6), pauseAfter: gap });
  };
  const meaning = () => { if (jaOk && w.meaning) out.push({ part: 'meaning', text: speakable(w.meaning), lang: 'ja', rate: 1.0, pauseAfter: gap }); };
  if (s.mode === 'recall') {
    // 意味を聞いて、外国語を思い出す時間をとってから正解を読む
    if (jaOk && w.meaning) out.push({ part: 'meaning', text: speakable(w.meaning), lang: 'ja', rate: 1.0, pauseAfter: Math.max(2500, gap * 2) });
    wordSteps();
  } else {
    wordSteps();
    if (s.parts.meaning) meaning();
  }
  if (s.parts.example && w.example) out.push({ part: 'example', text: w.example, lang, rate: s.rate, pauseAfter: gap });
  if (s.parts.exTrans && jaOk && w.exampleTranslation) out.push({ part: 'exTrans', text: w.exampleTranslation, lang: 'ja', rate: 1.0, pauseAfter: gap });
  return out;
}

async function run(token) {
  while (p.playing && token === p.token) {
    const w = current();
    if (!w) break;
    p.revealed = p.settings.mode !== 'recall';
    render();
    for (const st of steps(w)) {
      if (token !== p.token) return;
      p.part = st.part;
      if (st.part === 'word') p.revealed = true;
      render();
      await speakAsync(st.text, st.lang, { rate: st.rate });
      if (token !== p.token) return;
      await sleep(st.pauseAfter);
    }
    if (token !== p.token) return;
    p.part = null;
    if (p.i < p.order.length - 1) {
      p.i += 1;
    } else if (p.settings.loop) {
      if (p.settings.shuffle) p.order = shuffled(p.words.length);
      p.i = 0;
    } else {
      p.playing = false;
      p.finished = true;
      keepAwake(false);
      render();
      return;
    }
  }
}

function play() {
  if (!SpeechSupport.tts || !p.words.length) return;
  if (p.finished) { p.i = 0; p.finished = false; }
  p.playing = true;
  p.token += 1;
  keepAwake(true);
  run(p.token);
}
function pause() {
  p.playing = false;
  p.token += 1;
  p.part = null;
  p.revealed = true;
  stopSpeaking();
  keepAwake(false);
  render();
}
function jump(delta) {
  const wasPlaying = p.playing;
  p.token += 1;
  stopSpeaking();
  p.i = Math.min(Math.max(p.i + delta, 0), p.order.length - 1);
  p.part = null;
  p.finished = false;
  p.revealed = true;
  if (wasPlaying) { p.playing = true; run(p.token); } else render();
}

// ---------- 画面 ----------

function ensureEl() {
  if (p.el) return p.el;
  const el = document.createElement('div');
  el.id = 'word-player';
  el.className = 'wp hidden';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', '単語の連続読み上げ');
  document.body.appendChild(el);
  el.addEventListener('click', onClick);
  el.addEventListener('change', onChange);
  // 設定欄の開閉を覚えておく（読み上げ中に画面を描き直しても閉じないように）
  el.addEventListener('toggle', (e) => { if (e.target.classList?.contains('wp-settings')) p.settingsOpen = e.target.open; }, true);
  p.el = el;
  return el;
}

const chip = (group, value, label, on) =>
  `<button class="chip ${on ? 'chip-active' : ''}" data-wp-set="${group}" data-wp-val="${value}">${label}</button>`;
const check = (name, label, on) =>
  `<label class="wp-check"><input type="checkbox" data-wp-part="${name}" ${on ? 'checked' : ''}> ${label}</label>`;

function render() {
  const el = ensureEl();
  const w = current();
  const s = p.settings;
  const total = p.order.length;
  const lang = wordLang(w);
  const on = (part) => (p.part === part ? 'wp-on' : '');
  const noVoice = hasVoiceFor(lang) === false;
  const noJa = hasVoiceFor('ja') === false;
  el.innerHTML = `
    <div class="wp-sheet">
      <div class="wp-head">
        <div>
          <div class="wp-title">${esc(p.title)}</div>
          <div class="wp-count">${total ? `${p.i + 1} / ${total} 語` : ''}${s.shuffle ? '・シャッフル' : ''}${s.loop ? '・くり返し' : ''}</div>
        </div>
        <button class="wp-close" data-wp="close" aria-label="閉じる">✕</button>
      </div>
      <div class="wp-bar"><div class="wp-bar-fill" style="width:${total ? Math.round(((p.i + (p.finished ? 1 : 0)) / total) * 100) : 0}%"></div></div>

      <div class="wp-card">
        ${w ? `
          <div class="wp-word ${on('word')} ${p.revealed ? '' : 'wp-hidden'}">${esc(w.word)}</div>
          ${w.reading && p.revealed ? `<div class="wp-reading">${esc(w.reading)}</div>` : ''}
          <div class="wp-meaning ${on('meaning')}">${esc(w.meaning)}</div>
          ${w.example ? `<div class="wp-example ${on('example')}">${esc(w.example)}</div>` : ''}
          ${w.exampleTranslation ? `<div class="wp-extrans ${on('exTrans')}">${esc(w.exampleTranslation)}</div>` : ''}
        ` : '<div class="wp-meaning">読み上げる単語がありません</div>'}
        ${p.finished ? '<div class="wp-done">最後まで読み上げました</div>' : ''}
      </div>

      <div class="wp-controls">
        <button class="wp-btn" data-wp="prev" aria-label="前の単語">⏮</button>
        <button class="wp-btn wp-play" data-wp="toggle" aria-label="${p.playing ? '一時停止' : '再生'}">${p.playing ? '⏸' : '▶'}</button>
        <button class="wp-btn" data-wp="next" aria-label="次の単語">⏭</button>
      </div>
      ${!SpeechSupport.tts ? '<p class="wp-note">このブラウザは音声の読み上げに対応していません。Safari・Chrome・Edge でお使いください。</p>' : ''}
      ${noVoice ? `<p class="wp-note">この端末には${esc(LANG_NAME[lang] ?? lang)}の音声が入っていないため、正しく発音されないことがあります。</p>` : ''}
      ${noJa ? '<p class="wp-note">日本語の音声が見つからないため、意味・訳は読み上げずに表示だけします。</p>' : ''}

      <details class="wp-settings" ${p.settingsOpen ? 'open' : ''}>
        <summary>読み上げの設定</summary>
        <div class="wp-row"><span class="wp-label">モード</span>
          ${chip('mode', 'learn', '覚える（外国語→意味）', s.mode === 'learn')}
          ${chip('mode', 'recall', '思い出す（意味→考える→外国語）', s.mode === 'recall')}
        </div>
        <div class="wp-row"><span class="wp-label">読む内容</span>
          ${check('slow', 'ゆっくりもう一度', s.parts.slow)}
          ${s.mode === 'learn' ? check('meaning', '日本語の意味', s.parts.meaning) : ''}
          ${check('example', '例文', s.parts.example)}
          ${check('exTrans', '例文の訳', s.parts.exTrans)}
        </div>
        <div class="wp-row"><span class="wp-label">単語を読む回数</span>
          ${[1, 2, 3].map((n) => chip('repeat', n, `${n}回`, s.repeat === n)).join('')}
        </div>
        <div class="wp-row"><span class="wp-label">速さ</span>
          ${[[0.7, 'ゆっくり'], [0.9, 'ふつう'], [1.1, '速め']].map(([v, l]) => chip('rate', v, l, s.rate === v)).join('')}
        </div>
        <div class="wp-row"><span class="wp-label">間の長さ</span>
          ${[[0.8, '短い'], [1.5, 'ふつう'], [3, '長い']].map(([v, l]) => chip('gap', v, l, s.gap === v)).join('')}
        </div>
        <div class="wp-row">
          <label class="wp-check"><input type="checkbox" data-wp-flag="shuffle" ${s.shuffle ? 'checked' : ''}> 順番をシャッフル</label>
          <label class="wp-check"><input type="checkbox" data-wp-flag="loop" ${s.loop ? 'checked' : ''}> 最後まで行ったら最初からくり返す</label>
        </div>
        <p class="wp-hint">再生中は画面が自動で消えないようにしています。画面を消したり別のアプリに切り替えたりすると、読み上げは止まります（ブラウザの仕組みのため）。</p>
      </details>
    </div>`;
}

function restartIfPlaying() {
  if (p.playing) { p.token += 1; stopSpeaking(); p.part = null; run(p.token); } else render();
}

function onClick(e) {
  const t = e.target;
  if (t === p.el) { closeWordPlayer(); return; }           // 背景をタップで閉じる
  const act = t.closest('[data-wp]')?.dataset.wp;
  if (act === 'close') { closeWordPlayer(); return; }
  if (act === 'toggle') { if (p.playing) pause(); else play(); return; }
  if (act === 'prev') { jump(-1); return; }
  if (act === 'next') { jump(1); return; }
  const set = t.closest('[data-wp-set]');
  if (set) {
    const k = set.dataset.wpSet;
    const v = set.dataset.wpVal;
    p.settings[k] = k === 'mode' ? v : Number(v);
    p.settingsOpen = true;
    saveSettings();
    restartIfPlaying();
  }
}

function onChange(e) {
  const t = e.target;
  p.settingsOpen = true;
  if (t.dataset.wpPart) {
    p.settings.parts[t.dataset.wpPart] = t.checked;
  } else if (t.dataset.wpFlag) {
    p.settings[t.dataset.wpFlag] = t.checked;
    if (t.dataset.wpFlag === 'shuffle') {
      const now = p.order[p.i];
      p.order = t.checked ? shuffled(p.words.length) : [...p.words.keys()];
      p.i = Math.max(0, p.order.indexOf(now));
    }
  } else {
    return;
  }
  saveSettings();
  restartIfPlaying();
}

// ---------- 公開関数 ----------

/**
 * 単語の連続読み上げを開く。
 *   words: [{ word, reading?, meaning, example?, exampleTranslation?, lang? }]
 *   lang:  単語に lang が無いときの言語（'en' / 'vi'）
 */
export function openWordPlayer({ words, lang = 'en', title = '単語の読み上げ', startIndex = 0, autoplay = true } = {}) {
  closeWordPlayer();
  p.words = (words ?? []).filter((w) => w?.word);
  p.lang = lang;
  p.title = title;
  p.order = p.settings.shuffle ? shuffled(p.words.length) : [...p.words.keys()];
  p.i = p.settings.shuffle ? 0 : Math.min(Math.max(startIndex, 0), Math.max(0, p.words.length - 1));
  p.finished = false;
  p.revealed = true;
  p.settingsOpen = false;
  const el = ensureEl();
  el.classList.remove('hidden');
  document.body.classList.add('wp-open');
  render();
  if (autoplay) play();
}

export function closeWordPlayer() {
  if (!p.el || p.el.classList.contains('hidden')) return;
  p.playing = false;
  p.token += 1;
  stopSpeaking();
  keepAwake(false);
  p.el.classList.add('hidden');
  document.body.classList.remove('wp-open');
}

export const isWordPlayerOpen = () => !!p.el && !p.el.classList.contains('hidden');
