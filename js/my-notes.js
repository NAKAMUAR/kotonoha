// =====================================================================
// 言の葉 / Kotonoha — マイノート（自分で単語・文を登録する）
//
// ドラマや本で見つけた単語・文を登録して、単語帳（SRS）で復習する。
// 登録内容は本人のアカウント（Firestore users/{uid}/notes）と端末にだけ保存。
//
//   文を入力   → アプリの単語データと照らして自動で単語に分け、意味と級を表示。
//                チェックした単語は、その文を例文にして単語としても登録する。
//   単語を入力 → アプリの単語データから意味を補い、その単語を使った例文の候補を出す。
//                （データに無い単語は、AI に例文を作ってもらう質問文を用意する）
// =====================================================================

import { getNotes, saveNote, deleteNote, invalidateNotesCache, getDeck, NOTE_DECK } from './vocabulary.js';
import { speak, stopSpeaking, SpeechSupport } from './scenarios.js';
import { openWordPlayer } from './word-player.js';
import { launchProvider } from './ai-providers.js';

const LANG_NAME = { vi: 'ベトナム語', en: '英語' };

const n = {
  lang: 'vi',
  kind: 'sentence',
  notes: [],
  q: '',
  source: '',
  touched: { meaning: false, example: false },   // 自分で書き換えた欄は自動で上書きしない
  breakdown: null,      // { text, found }
  candidates: null,     // { word, list }
  hooks: { showToast: () => {}, openDeck: () => {}, onChange: () => {} },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (id) => document.getElementById(id);
const speakable = (t) => String(t ?? '').replace(/\s*[（(][^）)]*[）)]/g, '').trim();
// 声調記号を外して比べる（検索用）
const fold = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');
const PUNCT = /[.,!?;:"“”‘’…()（）「」[\]\-–—/]/g;
const tokenize = (t) => String(t ?? '').toLowerCase().replace(PUNCT, ' ').split(/\s+/).filter(Boolean);
function debounce(fn, ms) {
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------- アプリの単語データ（辞書と例文） ----------
// 並び順＝やさしい順。おすすめの判定と例文の並べ替えに使う。

const LOOKUP_DECKS = {
  vi: [['vipre6kyu', '準6級'], ['daily', '日常'], ['vi5kyu', '5級'], ['vi4kyu', '4級'], ['vi3kyu', '3級'], ['vi2kyu', '2級'], ['vi1kyu', '1級'], ['vidrama', 'ドラマ']],
  en: [['daily', '日常'], ['phrasal', '句動詞'], ['toeic', 'TOEIC']],
};
// 文から単語を登録するとき、最初からチェックを入れない「基本の語」の級
const BASIC_LEVELS = new Set(['準6級', '日常']);
const dictCache = {};

async function dict(lang) {
  dictCache[lang] ??= (async () => {
    const map = new Map();       // 見出し語 → [{ word, meaning, reading, level, rank, example, exampleTranslation }]
    const examples = [];         // [{ text, ja, level, rank, padded }]
    const seenEx = new Set();
    for (const [rank, [deck, label]] of LOOKUP_DECKS[lang].entries()) {
      let words = [];
      try {
        const res = await fetch(getDeck(deck).file(lang));
        if (res.ok) words = await res.json();
      } catch { /* その級のデータが読めなくても続ける */ }
      for (const w of words) {
        const key = speakable(w.word).toLowerCase();
        if (key && !key.includes('...')) {
          if (!map.has(key)) map.set(key, []);
          const list = map.get(key);
          if (list.length < 3 && !list.some((x) => x.meaning === w.meaning)) {
            list.push({ word: w.word, meaning: w.meaning, reading: w.reading ?? '', level: label, rank,
                        example: w.example ?? '', exampleTranslation: w.exampleTranslation ?? '' });
          }
        }
        if (w.example && w.exampleTranslation && !seenEx.has(w.example)) {
          seenEx.add(w.example);
          examples.push({ text: w.example, ja: w.exampleTranslation, level: label, rank,
                          padded: ` ${tokenize(w.example).join(' ')} ` });
        }
      }
    }
    return { map, examples };
  })();
  return dictCache[lang];
}

/** 文を単語に分ける。辞書にある語を長いものから当てはめる（ベトナム語は最大 4 音節のまとまり） */
async function splitSentence(text, lang) {
  const { map } = await dict(lang);
  const tokens = tokenize(text);
  const found = [];
  const seen = new Set();
  for (let i = 0; i < tokens.length;) {
    let hit = null;
    for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
      const key = tokens.slice(i, i + len).join(' ');
      if (map.has(key)) { hit = { key, len, entries: map.get(key) }; break; }
    }
    const item = hit ?? { key: tokens[i], len: 1, entries: [] };
    if (!seen.has(item.key) && !/^\d+$/.test(item.key)) { seen.add(item.key); found.push(item); }
    i += item.len;
  }
  return found;
}

/**
 * その単語を使った例文の候補（よく使われる順の目安：やさしい級・短い文を優先）
 *   1. その単語の見出しに付いている例文  2. 単語データ全体から、その単語を含む例文
 */
async function examplesFor(word, lang, { exclude = '', limit = 4 } = {}) {
  const { map, examples } = await dict(lang);
  const key = speakable(word).toLowerCase();
  if (!key) return [];
  const out = [];
  const add = (text, ja, level) => {
    if (!text || text === exclude || out.some((x) => x.text === text)) return;
    out.push({ text, ja, level });
  };
  for (const e of map.get(key) ?? []) add(e.example, e.exampleTranslation, e.level);
  const needle = ` ${tokenize(key).join(' ')} `;
  examples
    .filter((e) => e.padded.includes(needle))
    .sort((a, b) => a.rank - b.rank || a.text.length - b.text.length)
    .slice(0, 12)
    .forEach((e) => add(e.text, e.ja, e.level));
  return out.slice(0, limit);
}

// ---------- フォーム ----------

function syncForm() {
  document.querySelectorAll('#note-lang .tab').forEach((t) => t.classList.toggle('tab-active', t.dataset.noteLang === n.lang));
  document.querySelectorAll('#note-kind .chip').forEach((c) => c.classList.toggle('chip-active', c.dataset.noteKind === n.kind));
  const name = LANG_NAME[n.lang];
  $('note-text-label').textContent = n.kind === 'sentence' ? `文（${name}）` : `単語（${name}）`;
  $('note-meaning-label').textContent = n.kind === 'sentence' ? '訳（日本語）' : '意味（日本語）';
  $('note-text').rows = n.kind === 'sentence' ? 2 : 1;
  $('note-text').placeholder = n.lang === 'vi'
    ? (n.kind === 'sentence' ? '例：Con về rồi à?' : '例：về nhà')
    : (n.kind === 'sentence' ? '例：I’ll be right back.' : '例：figure out');
  $('note-meaning').placeholder = n.kind === 'sentence'
    ? (n.lang === 'vi' ? '例：帰ってきたの？' : '例：すぐ戻るね。')
    : '（アプリのデータにある単語なら自動で入ります）';
  $('note-word-extra').classList.toggle('hidden', n.kind !== 'word');
  $('note-lookup').classList.toggle('hidden', n.kind !== 'sentence' || !n.breakdown);
  $('note-examples').classList.toggle('hidden', n.kind !== 'word' || !n.candidates);
  document.querySelectorAll('[data-note-say]').forEach((b) => b.classList.toggle('hidden', !SpeechSupport.tts));
}

function clearHelpers() {
  n.breakdown = null;
  n.candidates = null;
  $('note-lookup').innerHTML = '';
  $('note-examples').innerHTML = '';
}

function resetForm(keep = {}) {
  $('note-form').reset();
  $('note-id').value = '';
  if (keep.source) $('note-source').value = keep.source;
  n.touched = { meaning: false, example: false };
  $('note-form-title').textContent = '新しく登録する';
  $('note-save').textContent = '登録する';
  $('note-cancel').classList.add('hidden');
  clearHelpers();
  syncForm();
}

function fillForm(note) {
  n.lang = note.lang;
  n.kind = note.kind ?? 'word';
  clearHelpers();
  $('note-id').value = note.id;
  $('note-text').value = note.word ?? '';
  $('note-meaning').value = note.meaning ?? '';
  $('note-reading').value = note.reading ?? '';
  $('note-example').value = note.example ?? '';
  $('note-example-tr').value = note.exampleTranslation ?? '';
  $('note-source').value = note.source ?? '';
  $('note-memo').value = note.memo ?? '';
  n.touched = { meaning: true, example: true };
  $('note-form-title').textContent = '登録内容を編集';
  $('note-save').textContent = '更新する';
  $('note-cancel').classList.remove('hidden');
  syncForm();
  onTextChanged();
  $('note-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

const registeredWords = (lang) =>
  new Set(n.notes.filter((x) => x.lang === lang && x.kind === 'word').map((x) => speakable(x.word).toLowerCase()));

// ---- 文：単語の内訳 ----

async function renderBreakdown() {
  const text = $('note-text').value.trim();
  const box = $('note-lookup');
  if (n.kind !== 'sentence' || !text) { n.breakdown = null; box.innerHTML = ''; syncForm(); return; }
  const lang = n.lang;
  const found = await splitSentence(text, lang);
  if ($('note-text').value.trim() !== text || n.kind !== 'sentence' || n.lang !== lang) return;   // 入力が変わった
  const prevChecks = new Map((n.breakdown?.found ?? []).map((f) => [f.key, f.checked]));
  const reg = registeredWords(lang);
  for (const f of found) {
    f.registered = reg.has(f.key);
    f.checked = f.entries.length && !f.registered
      ? (prevChecks.get(f.key) ?? !BASIC_LEVELS.has(f.entries[0].level))
      : false;
  }
  n.breakdown = { text, lang, found };
  const known = found.filter((f) => f.entries.length);
  box.innerHTML = `
    <div class="note-lk-head">
      <span>単語の内訳（${known.length} / ${found.length} 語がアプリのデータにあります）</span>
      ${known.some((f) => !f.registered) ? '<button type="button" class="acct-link" data-note-pickall="1">すべて選ぶ／外す</button>' : ''}
    </div>
    <ul class="note-lookup-list">${found.map((f, i) => `
      <li>
        ${f.entries.length && !f.registered
          ? `<input type="checkbox" class="note-lk-check" data-note-pick="${i}" ${f.checked ? 'checked' : ''} aria-label="${esc(f.key)} を単語として登録">`
          : '<span class="note-lk-check-sp"></span>'}
        <span class="note-lk-word">${esc(f.key)}</span>
        ${f.entries.length
          ? `<span class="note-lk-mean">${f.entries.map((e) => `${esc(e.meaning)}<span class="note-lk-lv">${esc(e.level)}</span>`).join(' ／ ')}</span>
             ${f.registered ? '<span class="note-lk-done">登録済み</span>' : ''}`
          : '<span class="note-lk-none">（アプリのデータにありません）</span>'}
      </li>`).join('')}</ul>
    <p class="note-lk-foot">✓を付けた単語は、この文を例文にして単語としても登録します（基本の語は最初は外してあります）。</p>`;
  syncForm();
}

// ---- 単語：意味と例文の候補 ----

async function renderCandidates() {
  const word = $('note-text').value.trim();
  const box = $('note-examples');
  if (n.kind !== 'word' || !word) { n.candidates = null; box.innerHTML = ''; syncForm(); return; }
  const lang = n.lang;
  const [{ map }, list] = await Promise.all([dict(lang), examplesFor(word, lang)]);
  if ($('note-text').value.trim() !== word || n.kind !== 'word' || n.lang !== lang) return;
  const entries = map.get(speakable(word).toLowerCase()) ?? [];
  // 意味・読みが空なら、アプリのデータから補う
  if (entries.length && !n.touched.meaning && !$('note-meaning').value.trim()) {
    $('note-meaning').value = entries.map((e) => e.meaning).join('／');
  }
  if (entries[0]?.reading && !$('note-reading').value.trim()) $('note-reading').value = entries[0].reading;
  n.candidates = { word, lang, list };
  if (list.length && !n.touched.example && !$('note-example').value.trim()) {
    $('note-example').value = list[0].text;
    $('note-example-tr').value = list[0].ja;
  }
  const current = $('note-example').value.trim();
  box.innerHTML = list.length ? `
    <div class="note-lk-head"><span>例文の候補（よく使われるやさしい文から順に）</span></div>
    <ul class="note-ex-list">${list.map((e, i) => `
      <li>
        <label class="note-ex-opt">
          <input type="radio" name="note-ex" data-note-ex="${i}" ${e.text === current ? 'checked' : ''}>
          <span><span class="note-ex-text">${esc(e.text)}</span><span class="note-lk-lv">${esc(e.level)}</span>
            <span class="note-ex-ja">${esc(e.ja)}</span></span>
        </label>
        ${SpeechSupport.tts ? `<button type="button" class="audio-btn audio-btn-sm" data-note-ex-say="${i}">🔊</button>` : ''}
      </li>`).join('')}</ul>
    <p class="note-lk-foot">選んだ例文が下の「例文」欄に入ります。ほかの候補も「ほかの例文」として一緒に保存します。自分で書き換えてもかまいません。</p>`
    : `
    <div class="note-lk-head"><span>この単語はアプリのデータに例文がありません</span></div>
    <p class="note-lk-foot">例文を自分で入力するか、AI に考えてもらいましょう。</p>
    <button type="button" class="btn-secondary text-sm mt-2" data-note-ai="1">Claude に例文を作ってもらう</button>`;
  syncForm();
}

const onTextChanged = debounce(() => {
  if (n.kind === 'sentence') renderBreakdown(); else renderCandidates();
}, 350);

async function askAiForExamples() {
  const word = $('note-text').value.trim();
  if (!word) return;
  const meaning = $('note-meaning').value.trim();
  const prompt = `${LANG_NAME[n.lang]}の「${word}」${meaning ? `（意味：${meaning}）` : ''}を使った、日常会話でよく使われる短い例文を3つ作ってください。` +
    `それぞれ「例文 ／ 日本語訳」の形で、1行に1つずつ書いてください。${n.lang === 'vi' ? 'ベトナム北部の自然な言い方でお願いします。' : ''}`;
  const { copied, opened } = await launchProvider('claude', prompt);
  n.hooks.showToast(copied
    ? `質問文をコピーしました。${opened ? '開いた Claude に貼り付けて送り、' : 'Claude に貼り付けて送り、'}気に入った例文を「例文」欄に貼ってください`
    : '質問文をコピーできませんでした', 9000);
}

// ---- 登録 ----

async function onSubmit(e) {
  e.preventDefault();
  const text = $('note-text').value.trim();
  const meaning = $('note-meaning').value.trim();
  if (!text || !meaning) { n.hooks.showToast('「単語・文」と「意味・訳」を入力してください'); return; }
  const id = $('note-id').value;
  const dup = n.notes.find((x) => x.id !== id && x.lang === n.lang && x.word.trim().toLowerCase() === text.toLowerCase());
  if (dup && !confirm(`「${dup.word}」はすでに登録されています。もう一つ登録しますか？`)) return;
  const btn = $('note-save');
  btn.disabled = true;
  try {
    const source = $('note-source').value;
    const memo = $('note-memo').value;
    let parts;
    let extraExamples;
    let picked = [];
    if (n.kind === 'sentence') {
      if (n.breakdown?.text !== text || n.breakdown?.lang !== n.lang) await renderBreakdown();
      const found = n.breakdown?.found ?? [];
      parts = found.map((f) => ({ w: f.key, m: f.entries.slice(0, 2).map((x) => x.meaning).join('／'), lv: f.entries[0]?.level ?? '' }));
      picked = found.filter((f) => f.checked && f.entries.length && !f.registered);
    } else {
      if (n.candidates?.word !== text) await renderCandidates();
      const ex = $('note-example').value.trim();
      extraExamples = (n.candidates?.list ?? []).filter((x) => x.text !== ex).slice(0, 2)
        .map((x) => ({ text: x.text, ja: x.ja, lv: x.level }));
    }
    const { synced } = await saveNote({
      id: id || undefined, lang: n.lang, kind: n.kind, word: text, meaning,
      reading: n.kind === 'word' ? $('note-reading').value : '',
      example: n.kind === 'word' ? $('note-example').value : '',
      exampleTranslation: n.kind === 'word' ? $('note-example-tr').value : '',
      source, memo, parts, extraExamples,
    });
    // 文から選んだ単語も登録（その文を例文にする）
    let allSynced = synced;
    for (const f of picked) {
      const e0 = f.entries[0];
      const more = await examplesFor(e0.word, n.lang, { exclude: text, limit: 2 });
      const r = await saveNote({
        lang: n.lang, kind: 'word', word: e0.word, meaning: f.entries.map((x) => x.meaning).join('／'),
        reading: e0.reading, example: text, exampleTranslation: meaning, source,
        memo: `${e0.level}の単語・文から登録`,
        extraExamples: more.map((x) => ({ text: x.text, ja: x.ja, lv: x.level })),
      });
      allSynced = allSynced && r.synced;
    }
    const what = n.kind === 'sentence' && picked.length ? `文と単語 ${picked.length} 語を` : '';
    n.hooks.showToast(allSynced
      ? (id ? `${what || ''}更新しました` : `${what || ''}登録しました。単語帳の「マイノート」で復習できます`)
      : '端末に保存しました（インターネットにつながったときに同期します）', 5000);
    invalidateNotesCache();
    resetForm({ source });   // 同じ作品から続けて登録しやすいよう、出典は残す
    await refreshList();
    n.hooks.onChange();
  } catch (err) {
    console.error('note save failed:', err);
    n.hooks.showToast('保存に失敗しました。もう一度お試しください');
  } finally {
    btn.disabled = false;
  }
}

// ---------- 一覧 ----------

function filtered() {
  const q = fold(n.q.trim());
  return n.notes.filter((x) =>
    (!n.source || (x.source ?? '') === n.source) &&
    (!q || [x.word, x.meaning, x.source, x.memo, x.example].some((v) => fold(v).includes(q))));
}

function partsHtml(parts) {
  if (!parts?.length) return '';
  return `<div class="note-parts">${parts.map((p) =>
    `<span class="note-part"><b>${esc(p.w)}</b>${p.m ? ` ${esc(p.m)}` : ''}</span>`).join('')}</div>`;
}

function renderList() {
  const list = filtered();
  $('note-list-count').textContent = `${n.notes.length} 件${list.length !== n.notes.length ? `（表示 ${list.length} 件）` : ''}`;
  const sources = [...new Set(n.notes.map((x) => x.source).filter(Boolean))];
  $('note-sources').innerHTML = sources.map((s) => `<option value="${esc(s)}">`).join('');
  const sel = $('note-filter-source');
  sel.innerHTML = `<option value="">すべての出典</option>${sources.map((s) => `<option value="${esc(s)}">${esc(s)}</option>`).join('')}`;
  sel.value = sources.includes(n.source) ? n.source : '';
  $('note-study').disabled = !n.notes.length;
  $('note-play').disabled = !list.length || !SpeechSupport.tts;
  $('note-list').innerHTML = list.length ? list.map((x) => `
    <li class="note-item">
      <div class="note-item-head">
        <span class="note-badge">${x.lang === 'vi' ? 'VI' : 'EN'}・${x.kind === 'sentence' ? '文' : '単語'}</span>
        ${x.synced === false ? '<span class="note-unsynced" title="インターネットにつながったときに同期します">未同期</span>' : ''}
      </div>
      <div class="note-item-text">${esc(x.word)}
        ${SpeechSupport.tts ? `<button class="audio-btn audio-btn-sm" data-note-play="${esc(x.id)}">🔊</button>` : ''}</div>
      ${x.reading ? `<div class="note-item-sub">${esc(x.reading)}</div>` : ''}
      <div class="note-item-mean">${esc(x.meaning)}</div>
      ${partsHtml(x.parts)}
      ${x.example ? `<div class="note-item-sub">例：${esc(x.example)}${x.exampleTranslation ? `（${esc(x.exampleTranslation)}）` : ''}</div>` : ''}
      ${(x.extraExamples ?? []).map((e) => `<div class="note-item-sub">例：${esc(e.text)}（${esc(e.ja)}）</div>`).join('')}
      ${x.source || x.memo ? `<div class="note-item-meta">${[x.source, x.memo].filter(Boolean).map(esc).join('・')}</div>` : ''}
      <div class="note-item-actions">
        <button class="acct-link" data-note-edit="${esc(x.id)}">編集</button>
        <button class="acct-link" data-note-del="${esc(x.id)}">削除</button>
      </div>
    </li>`).join('')
    : `<li class="text-sm text-sumi-soft">${n.notes.length ? '条件に合う登録はありません' : 'まだ登録がありません。上のフォームから登録してください。'}</li>`;
}

async function refreshList() {
  try { n.notes = await getNotes(); } catch (err) { console.warn('notes load failed:', err); n.notes = []; }
  renderList();
}

// ---------- 公開関数 ----------

export async function activateNotesScreen() {
  syncForm();
  await refreshList();
  dict(n.lang).catch(() => {});   // 単語データを先に読み込んでおく
}

export async function noteCount() {
  try { return (await getNotes()).length; } catch { return 0; }
}

/** 単語帳のカード裏に出す「単語の内訳」「ほかの例文」の HTML（マイノート以外は空） */
export function noteCardExtras(word) {
  if (word?.deck !== NOTE_DECK) return { parts: '', more: '' };
  const parts = word.parts?.length
    ? `<div class="card-extra-title">単語の内訳</div>${partsHtml(word.parts)}` : '';
  const more = word.extraExamples?.length
    ? `<div class="card-extra-title">ほかの例文</div>${word.extraExamples.map((e) =>
        `<div class="card-more-ex-row"><span>${esc(e.text)}</span><span class="note-ex-ja">${esc(e.ja)}</span></div>`).join('')}` : '';
  return { parts, more };
}

export function initNotes(hooks = {}) {
  Object.assign(n.hooks, hooks);
  $('note-form')?.addEventListener('submit', onSubmit);
  $('note-lang')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-note-lang]');
    if (!b) return;
    n.lang = b.dataset.noteLang;
    clearHelpers(); syncForm(); onTextChanged();
  });
  $('note-kind')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-note-kind]');
    if (!b) return;
    n.kind = b.dataset.noteKind;
    clearHelpers(); syncForm(); onTextChanged();
  });
  $('note-text')?.addEventListener('input', onTextChanged);
  $('note-meaning')?.addEventListener('input', () => { n.touched.meaning = true; });
  $('note-example')?.addEventListener('input', () => { n.touched.example = true; });
  $('note-form')?.addEventListener('change', (e) => {
    const pick = e.target.closest('[data-note-pick]');
    if (pick && n.breakdown) { n.breakdown.found[Number(pick.dataset.notePick)].checked = pick.checked; return; }
    const ex = e.target.closest('[data-note-ex]');
    if (ex && n.candidates) {
      const c = n.candidates.list[Number(ex.dataset.noteEx)];
      $('note-example').value = c.text;
      $('note-example-tr').value = c.ja;
      n.touched.example = true;
    }
  });
  $('note-form')?.addEventListener('click', (e) => {
    const say = e.target.closest('[data-note-say]');
    if (say) {
      const text = speakable($('note-text').value);
      if (text) speak(text, n.lang, { rate: Number(say.dataset.noteSay) * 0.9 });
      return;
    }
    const exSay = e.target.closest('[data-note-ex-say]');
    if (exSay) { const c = n.candidates?.list[Number(exSay.dataset.noteExSay)]; if (c) speak(c.text, n.lang, { rate: 0.9 }); return; }
    if (e.target.closest('[data-note-pickall]') && n.breakdown) {
      const opts = n.breakdown.found.filter((f) => f.entries.length && !f.registered);
      const to = !opts.every((f) => f.checked);
      opts.forEach((f) => { f.checked = to; });
      document.querySelectorAll('[data-note-pick]').forEach((c) => { c.checked = to; });
      return;
    }
    if (e.target.closest('[data-note-ai]')) askAiForExamples();
  });
  $('note-cancel')?.addEventListener('click', () => resetForm());
  $('note-search')?.addEventListener('input', (e) => { n.q = e.target.value; renderList(); });
  $('note-filter-source')?.addEventListener('change', (e) => { n.source = e.target.value; renderList(); });
  $('note-study')?.addEventListener('click', () => {
    // 登録の多い言語の単語帳を開く（言語は単語帳の画面でも切り替えられる）
    const vi = n.notes.filter((x) => x.lang === 'vi').length;
    const en = n.notes.length - vi;
    n.hooks.openDeck(NOTE_DECK, vi >= en ? 'vi' : 'en');
  });
  $('note-play')?.addEventListener('click', () => {
    const list = filtered();
    if (!list.length) return;
    const title = n.source ? `マイノート：${n.source}` : 'マイノート';
    openWordPlayer({ words: list, lang: list[0].lang, title });
  });
  $('note-list')?.addEventListener('click', async (e) => {
    const play = e.target.closest('[data-note-play]');
    if (play) {
      const x = n.notes.find((y) => y.id === play.dataset.notePlay);
      if (x) speak(speakable(x.word), x.lang, { rate: 0.9 });
      return;
    }
    const edit = e.target.closest('[data-note-edit]');
    if (edit) { const x = n.notes.find((y) => y.id === edit.dataset.noteEdit); if (x) fillForm(x); return; }
    const del = e.target.closest('[data-note-del]');
    if (del) {
      const x = n.notes.find((y) => y.id === del.dataset.noteDel);
      if (!x || !confirm(`「${x.word}」を削除しますか？（復習の記録も消えます）`)) return;
      await deleteNote(x.id);
      invalidateNotesCache();
      if ($('note-id').value === x.id) resetForm();
      await refreshList();
      n.hooks.onChange();
      n.hooks.showToast('削除しました');
    }
  });
}

export function leaveNotesScreen() { stopSpeaking(); }
