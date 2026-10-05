// =====================================================================
// 言の葉 / Kotonoha — マイノート（自分で単語・文を登録する）
//
// ドラマや本で見つけた単語・文を登録して、単語帳（SRS）で復習する。
// 登録内容は本人のアカウント（Firestore users/{uid}/notes）と端末にだけ保存。
// 文を入力すると、アプリにある単語データと照らし合わせて単語の意味を調べられる。
// =====================================================================

import { getNotes, saveNote, deleteNote, invalidateNotesCache, getDeck, NOTE_DECK } from './vocabulary.js';
import { speak, stopSpeaking, SpeechSupport } from './scenarios.js';
import { openWordPlayer } from './word-player.js';

const LANG_NAME = { vi: 'ベトナム語', en: '英語' };

const n = {
  lang: 'vi',
  kind: 'sentence',
  notes: [],
  q: '',
  source: '',
  hooks: { showToast: () => {}, openDeck: () => {}, onChange: () => {} },
};

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const $ = (id) => document.getElementById(id);
const speakable = (t) => String(t ?? '').replace(/\s*[（(][^）)]*[）)]/g, '').trim();
// 声調記号を外して比べる（検索用）
const fold = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

// ---------- 単語を調べる（アプリにある単語データと照合） ----------

const LOOKUP_DECKS = {
  vi: [['vipre6kyu', '準6級'], ['vi5kyu', '5級'], ['vi4kyu', '4級'], ['vi3kyu', '3級'], ['vi2kyu', '2級'], ['vi1kyu', '1級'], ['daily', '日常']],
  en: [['daily', '日常'], ['phrasal', '句動詞'], ['toeic', 'TOEIC']],
};
const dictCache = {};

async function dict(lang) {
  if (dictCache[lang]) return dictCache[lang];
  dictCache[lang] = (async () => {
    const map = new Map();
    for (const [deck, label] of LOOKUP_DECKS[lang]) {
      try {
        const res = await fetch(getDeck(deck).file(lang));
        if (!res.ok) continue;
        for (const w of await res.json()) {
          const key = speakable(w.word).toLowerCase();
          if (!key || key.includes('...')) continue;
          if (!map.has(key)) map.set(key, []);
          const list = map.get(key);
          if (list.length < 3 && !list.some((x) => x.meaning === w.meaning)) {
            list.push({ word: w.word, meaning: w.meaning, reading: w.reading ?? '', level: label });
          }
        }
      } catch { /* その級のデータが読めなくても続ける */ }
    }
    return map;
  })();
  return dictCache[lang];
}

/** 文を単語に分けて、辞書にある語を長いものから当てはめる（ベトナム語は最大 4 音節） */
async function lookupSentence(text, lang) {
  const map = await dict(lang);
  const tokens = text.toLowerCase().replace(/[.,!?;:"“”‘’…()（）「」\[\]]/g, ' ').split(/\s+/).filter(Boolean);
  const found = [];
  const seen = new Set();
  for (let i = 0; i < tokens.length;) {
    let hit = null;
    for (let len = Math.min(4, tokens.length - i); len >= 1; len--) {
      const key = tokens.slice(i, i + len).join(' ');
      if (map.has(key)) { hit = { key, len, entries: map.get(key) }; break; }
    }
    if (hit) {
      if (!seen.has(hit.key)) { seen.add(hit.key); found.push(hit); }
      i += hit.len;
    } else {
      if (!seen.has(tokens[i])) { seen.add(tokens[i]); found.push({ key: tokens[i], len: 1, entries: [] }); }
      i += 1;
    }
  }
  return found;
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
    : (n.kind === 'sentence' ? '例：I’ll be right back.' : '例：right back');
  $('note-meaning').placeholder = n.kind === 'sentence' ? (n.lang === 'vi' ? '例：帰ってきたの？' : '例：すぐ戻るね。') : (n.lang === 'vi' ? '例：家に帰る' : '例：すぐに戻って');
  $('note-word-extra').classList.toggle('hidden', n.kind !== 'word');
  $('note-lookup-btn').classList.toggle('hidden', n.kind !== 'sentence');
  if (n.kind !== 'sentence') $('note-lookup').classList.add('hidden');
  document.querySelectorAll('[data-note-say]').forEach((b) => b.classList.toggle('hidden', !SpeechSupport.tts));
}

function resetForm(keep = {}) {
  $('note-form').reset();
  $('note-id').value = '';
  if (keep.source) $('note-source').value = keep.source;
  $('note-form-title').textContent = '新しく登録する';
  $('note-save').textContent = '登録する';
  $('note-cancel').classList.add('hidden');
  $('note-lookup').classList.add('hidden');
  $('note-lookup').innerHTML = '';
  syncForm();
}

function fillForm(note) {
  n.lang = note.lang;
  n.kind = note.kind ?? 'word';
  syncForm();
  $('note-id').value = note.id;
  $('note-text').value = note.word ?? '';
  $('note-meaning').value = note.meaning ?? '';
  $('note-reading').value = note.reading ?? '';
  $('note-example').value = note.example ?? '';
  $('note-example-tr').value = note.exampleTranslation ?? '';
  $('note-source').value = note.source ?? '';
  $('note-memo').value = note.memo ?? '';
  $('note-form-title').textContent = '登録内容を編集';
  $('note-save').textContent = '更新する';
  $('note-cancel').classList.remove('hidden');
  $('note-form').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

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
    const { synced } = await saveNote({
      id: id || undefined, lang: n.lang, kind: n.kind, word: text, meaning,
      reading: n.kind === 'word' ? $('note-reading').value : '',
      example: n.kind === 'word' ? $('note-example').value : '',
      exampleTranslation: n.kind === 'word' ? $('note-example-tr').value : '',
      source, memo: $('note-memo').value,
    });
    n.hooks.showToast(synced
      ? (id ? '更新しました' : '登録しました。単語帳の「マイノート」で復習できます')
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

async function onLookup() {
  const text = $('note-text').value.trim();
  const box = $('note-lookup');
  if (!text) { n.hooks.showToast('先に文を入力してください'); return; }
  box.classList.remove('hidden');
  box.innerHTML = '<div class="text-xs text-sumi-soft">調べています...</div>';
  const found = await lookupSentence(text, n.lang);
  const registered = new Set(n.notes.filter((x) => x.lang === n.lang).map((x) => x.word.trim().toLowerCase()));
  box.innerHTML = `
    <div class="text-xs text-sumi-soft mb-1">アプリにある単語データ（${n.lang === 'vi' ? 'ベトナム語検定 準6〜1級・日常会話' : '日常会話・句動詞・TOEIC'}）と照らし合わせた結果です。＋で単語として登録できます。</div>
    <ul class="note-lookup-list">${found.map((f, i) => `
      <li>
        <span class="note-lk-word">${esc(f.key)}</span>
        ${f.entries.length
          ? `<span class="note-lk-mean">${f.entries.map((e) => `${esc(e.meaning)}<span class="note-lk-lv">${esc(e.level)}</span>`).join(' ／ ')}</span>
             ${registered.has(f.key) ? '<span class="note-lk-done">登録済み</span>' : `<button type="button" class="note-lk-add" data-note-add="${i}">＋</button>`}`
          : '<span class="note-lk-none">（データにありません）</span>'}
      </li>`).join('')}</ul>`;
  box._found = found;
  box._sentence = { text, meaning: $('note-meaning').value.trim(), source: $('note-source').value };
}

async function addFromLookup(i) {
  const box = $('note-lookup');
  const f = box._found?.[i];
  if (!f?.entries.length) return;
  const e = f.entries[0];
  const s = box._sentence;
  const { synced } = await saveNote({
    lang: n.lang, kind: 'word', word: e.word, meaning: f.entries.map((x) => x.meaning).join('／'),
    reading: e.reading, example: s.text, exampleTranslation: s.meaning, source: s.source,
    memo: `${e.level}の単語`,
  });
  invalidateNotesCache();
  n.hooks.showToast(synced ? `「${e.word}」を単語として登録しました` : `「${e.word}」を端末に保存しました`);
  await refreshList();
  n.hooks.onChange();
  const btn = box.querySelector(`[data-note-add="${i}"]`);
  if (btn) btn.outerHTML = '<span class="note-lk-done">登録済み</span>';
}

// ---------- 一覧 ----------

function filtered() {
  const q = fold(n.q.trim());
  return n.notes.filter((x) =>
    (!n.source || (x.source ?? '') === n.source) &&
    (!q || [x.word, x.meaning, x.source, x.memo, x.example].some((v) => fold(v).includes(q))));
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
      ${x.example ? `<div class="note-item-sub">例：${esc(x.example)}${x.exampleTranslation ? `（${esc(x.exampleTranslation)}）` : ''}</div>` : ''}
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
}

export async function noteCount() {
  try { return (await getNotes()).length; } catch { return 0; }
}

export function initNotes(hooks = {}) {
  Object.assign(n.hooks, hooks);
  $('note-form')?.addEventListener('submit', onSubmit);
  $('note-lang')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-note-lang]');
    if (b) { n.lang = b.dataset.noteLang; $('note-lookup').classList.add('hidden'); syncForm(); }
  });
  $('note-kind')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-note-kind]');
    if (b) { n.kind = b.dataset.noteKind; syncForm(); }
  });
  $('note-form')?.addEventListener('click', (e) => {
    const say = e.target.closest('[data-note-say]');
    if (say) {
      const text = speakable($('note-text').value);
      if (text) speak(text, n.lang, { rate: Number(say.dataset.noteSay) * 0.9 });
      return;
    }
    const add = e.target.closest('[data-note-add]');
    if (add) addFromLookup(Number(add.dataset.noteAdd));
  });
  $('note-lookup-btn')?.addEventListener('click', onLookup);
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
