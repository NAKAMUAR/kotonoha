// =====================================================================
// 言の葉 / Kotonoha — ベトナム語検定（実用ベトナム語技能検定）対策
//
// 級ごとに 3 つの練習:
//   単語 … 単語帳（SRS）の各級デッキへ案内
//   文法 … data/vi-grammar-{n}kyu.json  文型の説明・例文・確認問題
//   長文 … data/vi-reading-{n}kyu.json  読解文・設問・全訳
//
// 文法・長文の練習記録はこの端末（localStorage）に保存する。
// =====================================================================

import { speak, speakDialogue, stopSpeaking, SpeechSupport } from './scenarios.js';

export const KENTEI_LEVELS = Object.freeze([
  { n: 5, deck: 'vi5kyu', label: '5級', desc: '入門〜初級。あいさつ・数字・家族・買い物など、身の回りの簡単な表現。' },
  { n: 4, deck: 'vi4kyu', label: '4級', desc: '初級。日常生活の基本的な会話と、短い文章の読み取り。問題文はベトナム語。' },
  { n: 3, deck: 'vi3kyu', label: '3級', desc: '中級。仕事・旅行・社会生活の話題。新聞の易しい記事程度の文章。' },
  { n: 2, deck: 'vi2kyu', label: '2級', desc: '中上級。社会・経済・文化の幅広い話題。論理的な文章の読解。' },
  { n: 1, deck: 'vi1kyu', label: '1級', desc: '上級（通訳レベル）。専門的・抽象的な話題、成語や硬い書き言葉。' },
]);

const GRAMMAR_KEY = 'kotonoha.vik.grammar'; // { pointId: true }（確認問題を全問正解）
const READING_KEY = 'kotonoha.vik.reading'; // { passageId: bestScorePercent }

const vk = {
  level:   5,
  mode:    'grammar',
  grammar: new Map(),  // n → data | null
  reading: new Map(),
  openPassage: null,
  hooks: { showToast: () => {}, openDeck: () => {}, deckTotal: async () => 0 },
};

// ---------- 保存 ----------

function loadJson(key) {
  try { return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {}; } catch { return {}; }
}
function saveJson(key, obj) {
  try { localStorage.setItem(key, JSON.stringify(obj)); } catch { /* 保存できなくても練習は続けられる */ }
}

export function kenteiProgress() {
  return { grammar: loadJson(GRAMMAR_KEY), reading: loadJson(READING_KEY) };
}

// ---------- データ ----------

async function fetchLevel(kind, n) {
  const cache = kind === 'grammar' ? vk.grammar : vk.reading;
  if (cache.has(n)) return cache.get(n);
  let data = null;
  try {
    const res = await fetch(`./data/vi-${kind}-${n}kyu.json`);
    if (res.ok) data = await res.json();
  } catch (err) {
    console.warn(`vi-kentei ${kind} ${n}kyu load failed:`, err);
  }
  cache.set(n, data);
  return data;
}

export async function kenteiCounts() {
  const out = {};
  for (const { n } of KENTEI_LEVELS) {
    const [g, r] = await Promise.all([fetchLevel('grammar', n), fetchLevel('reading', n)]);
    out[n] = { grammar: g?.points?.length ?? 0, reading: r?.passages?.length ?? 0 };
  }
  return out;
}

// ---------- 表示ヘルパ ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const sayBtn = (text, label = '🔊') =>
  SpeechSupport.tts ? `<button class="audio-btn audio-btn-sm vk-say" data-say="${esc(text)}">${label}</button>` : '';

function levelInfo(n) { return KENTEI_LEVELS.find((l) => l.n === n) ?? KENTEI_LEVELS[0]; }

function syncTabs() {
  document.querySelectorAll('#vk-level-row .chip').forEach((c) => c.classList.toggle('chip-active', Number(c.dataset.vkLevel) === vk.level));
  document.querySelectorAll('#vk-mode-tabs .tab').forEach((t) => t.classList.toggle('tab-active', t.dataset.vkMode === vk.mode));
  const info = levelInfo(vk.level);
  document.getElementById('vk-level-desc').textContent = `${info.label}：${info.desc}`;
}

async function render() {
  stopSpeaking();
  syncTabs();
  const body = document.getElementById('vk-body');
  if (!body) return;
  body.innerHTML = '<div class="text-xs text-sumi-soft">読み込み中...</div>';
  if (vk.mode === 'vocab')   return renderVocab(body);
  if (vk.mode === 'grammar') return renderGrammar(body);
  return vk.openPassage ? renderPassage(body) : renderReadingList(body);
}

// ---------- 単語 ----------

async function renderVocab(body) {
  const info  = levelInfo(vk.level);
  const total = await vk.hooks.deckTotal(info.deck);
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">${esc(info.label)}の単語</h3>
      ${total > 0
        ? `<p class="text-sm text-sumi-light mt-3">${total.toLocaleString()} 語。単語帳（間隔反復 SRS）で、忘れかけた頃に自動で復習できます。カードの🔊で発音も聞けます。</p>
           <button class="btn-primary w-full mt-4" data-vk-open-deck="${esc(info.deck)}">単語帳で ${esc(info.label)} を学習する</button>`
        : '<p class="text-sm text-sumi-light mt-3">この級の単語は準備中です。</p>'}
    </div>`;
}

// ---------- 文法 ----------

async function renderGrammar(body) {
  const data = await fetchLevel('grammar', vk.level);
  if (!data?.points?.length) { body.innerHTML = '<div class="card text-sm text-sumi-light">この級の文法は準備中です。</div>'; return; }
  const done = loadJson(GRAMMAR_KEY);
  const doneCount = data.points.filter((p) => done[p.id]).length;
  body.innerHTML = `
    <div class="text-xs text-koke mb-3">確認問題を全問正解した文法: ${doneCount} / ${data.points.length}</div>
    ${data.points.map((p, i) => `
      <details class="card vk-point ${done[p.id] ? 'vk-done' : ''}" data-vk-point="${esc(p.id)}">
        <summary class="vk-point-head">
          <span class="vk-num">${i + 1}</span>
          <span class="vk-point-title">${esc(p.title)}</span>
          ${done[p.id] ? '<span class="lk-badge">正解</span>' : ''}
        </summary>
        <div class="vk-pattern">${esc(p.pattern)}</div>
        <p class="vk-explain">${esc(p.explain)}</p>
        <div class="vk-examples">
          ${(p.examples ?? []).map((e) => `
            <div class="vk-example">
              <div class="vk-vi">${esc(e.vi)} ${sayBtn(e.vi)}</div>
              <div class="vk-ja">${esc(e.ja)}</div>
            </div>`).join('')}
        </div>
        ${(p.quiz ?? []).length ? `
        <div class="vk-quiz-title">確認問題</div>
        ${p.quiz.map((q, qi) => `
          <div class="vk-quiz" data-qi="${qi}">
            <div class="vk-q">${esc(q.q)}</div>
            ${q.ja ? `<div class="vk-qja">${esc(q.ja)}</div>` : ''}
            <div class="vk-choices">
              ${q.choices.map((c, ci) => `<button class="vk-choice" data-ci="${ci}">${esc(c)}</button>`).join('')}
            </div>
            <div class="vk-feedback hidden"></div>
          </div>`).join('')}` : ''}
      </details>`).join('')}`;
}

function onGrammarChoice(btn) {
  const pointEl = btn.closest('[data-vk-point]');
  const quizEl  = btn.closest('.vk-quiz');
  const data    = vk.grammar.get(vk.level);
  const point   = data?.points.find((p) => p.id === pointEl.dataset.vkPoint);
  const q       = point?.quiz?.[Number(quizEl.dataset.qi)];
  if (!q || quizEl.dataset.answered) return;
  const ci = Number(btn.dataset.ci);
  const ok = ci === q.answer;
  quizEl.dataset.answered = ok ? 'ok' : 'ng';
  quizEl.querySelectorAll('.vk-choice').forEach((b, i) => {
    b.disabled = true;
    if (i === q.answer) b.classList.add('vk-correct');
    else if (i === ci)  b.classList.add('vk-wrong');
  });
  const fb = quizEl.querySelector('.vk-feedback');
  fb.classList.remove('hidden');
  fb.innerHTML = `${ok ? '<b class="text-koke">◎ 正解</b>' : '<b class="text-shu">✕ 不正解</b>'}　${esc(q.explain ?? '')}`;
  // 空欄（___）のある問題だけ、正解を入れた文を読み上げる
  if (SpeechSupport.tts && /_{3}/.test(q.q)) speak(q.q.replace(/_{3,}/g, q.choices[q.answer]), 'vi');

  const all = [...pointEl.querySelectorAll('.vk-quiz')];
  if (all.every((el) => el.dataset.answered)) {
    if (all.every((el) => el.dataset.answered === 'ok')) {
      const done = loadJson(GRAMMAR_KEY); done[point.id] = true; saveJson(GRAMMAR_KEY, done);
      pointEl.classList.add('vk-done');
      vk.hooks.showToast('この文法の確認問題に全問正解しました');
    } else {
      fb.insertAdjacentHTML('beforeend', ' <button class="btn-secondary text-xs px-2 py-0.5 vk-retry">もう一度解く</button>');
    }
  }
}

// ---------- 長文 ----------

async function renderReadingList(body) {
  const data = await fetchLevel('reading', vk.level);
  if (!data?.passages?.length) { body.innerHTML = '<div class="card text-sm text-sumi-light">この級の長文は準備中です。</div>'; return; }
  const best = loadJson(READING_KEY);
  body.innerHTML = `
    <div class="space-y-3">
      ${data.passages.map((p, i) => `
        <button class="card vk-passage-item w-full text-left" data-vk-passage="${esc(p.id)}">
          <div class="flex items-baseline gap-2">
            <span class="vk-num">${i + 1}</span>
            <span class="vk-point-title">${esc(p.title)}</span>
          </div>
          <div class="text-xs text-sumi-soft mt-1">${esc(p.titleJa ?? '')}・設問 ${p.questions.length} 問
            ${best[p.id] != null ? `<span class="text-koke ml-2">最高 ${best[p.id]}%</span>` : ''}</div>
        </button>`).join('')}
    </div>`;
}

async function renderPassage(body) {
  const data = await fetchLevel('reading', vk.level);
  const p = data?.passages.find((x) => x.id === vk.openPassage);
  if (!p) { vk.openPassage = null; return renderReadingList(body); }
  const paragraphs = p.text.split(/\n+/).map((t) => `<p>${esc(t)}</p>`).join('');
  body.innerHTML = `
    <button class="btn-secondary text-xs px-3 py-1.5 mb-3" data-vk-back="1">← 一覧にもどる</button>
    <div class="card">
      <h3 class="card-title">${esc(p.title)}</h3>
      <div class="text-xs text-sumi-soft mt-1">${esc(p.titleJa ?? '')}</div>
      ${SpeechSupport.tts ? `
      <div class="audio-row audio-row-start mt-3">
        <button class="audio-btn audio-btn-sm" data-vk-read="1">🔊 本文を聞く</button>
        <button class="audio-btn audio-btn-sm" data-vk-read="0.65">🐢 ゆっくり</button>
        <button class="audio-btn audio-btn-sm" data-vk-stop="1">■ 停止</button>
      </div>` : ''}
      <div class="vk-text mt-3">${paragraphs}</div>
      ${(p.vocab ?? []).length ? `
      <details class="vk-vocab mt-3"><summary>語句のヒント（${p.vocab.length}）</summary>
        <ul>${p.vocab.map((v) => `<li><b>${esc(v.vi)}</b>：${esc(v.ja)}</li>`).join('')}</ul>
      </details>` : ''}
    </div>
    <div class="card mt-4" id="vk-questions">
      <h3 class="card-title">設問</h3>
      ${p.questions.map((q, qi) => `
        <div class="vk-quiz vk-rq" data-qi="${qi}">
          <div class="vk-q">${qi + 1}. ${esc(q.q)}</div>
          ${q.qJa ? `<details class="vk-qja-d"><summary>設問の訳</summary>${esc(q.qJa)}</details>` : ''}
          <div class="vk-choices vk-choices-col">
            ${q.choices.map((c, ci) => `<label class="vk-opt"><input type="radio" name="vkq${qi}" value="${ci}"> ${esc(c)}</label>`).join('')}
          </div>
          <div class="vk-feedback hidden"></div>
        </div>`).join('')}
      <button class="btn-primary w-full mt-4" data-vk-grade="1">答え合わせ</button>
      <div id="vk-score" class="text-center mt-3 hidden"></div>
    </div>
    <details class="card mt-4 vk-trans"><summary class="card-title cursor-pointer">全文の日本語訳</summary>
      <div class="vk-text-ja mt-3">${p.ja.split(/\n+/).map((t) => `<p>${esc(t)}</p>`).join('')}</div>
    </details>`;
}

function gradePassage() {
  const data = vk.reading.get(vk.level);
  const p = data?.passages.find((x) => x.id === vk.openPassage);
  if (!p) return;
  let correct = 0;
  p.questions.forEach((q, qi) => {
    const el = document.querySelector(`.vk-rq[data-qi="${qi}"]`);
    const picked = el.querySelector('input:checked');
    const ci = picked ? Number(picked.value) : -1;
    const ok = ci === q.answer;
    if (ok) correct += 1;
    el.querySelectorAll('.vk-opt').forEach((lab, i) => {
      lab.classList.toggle('vk-correct', i === q.answer);
      lab.classList.toggle('vk-wrong', i === ci && !ok);
    });
    const fb = el.querySelector('.vk-feedback');
    fb.classList.remove('hidden');
    fb.innerHTML = `${ok ? '<b class="text-koke">◎ 正解</b>' : `<b class="text-shu">✕ 正解は ${q.answer + 1} 番目</b>`}　${esc(q.explain ?? '')}`;
  });
  const pct = Math.round((correct / p.questions.length) * 100);
  const best = loadJson(READING_KEY);
  if (best[p.id] == null || pct > best[p.id]) { best[p.id] = pct; saveJson(READING_KEY, best); }
  const score = document.getElementById('vk-score');
  score.classList.remove('hidden');
  score.innerHTML = `<div class="font-mincho text-lg">${correct} / ${p.questions.length} 問正解（${pct}%）</div>
    <div class="text-xs text-sumi-soft mt-1">下の「全文の日本語訳」で内容を確認できます。</div>`;
}

// ---------- 初期化 ----------

export async function activateKenteiScreen(opts = {}) {
  if (opts.level) vk.level = opts.level;
  if (opts.mode)  { vk.mode = opts.mode; vk.openPassage = null; }
  await render();
}

export function initKentei(hooks = {}) {
  Object.assign(vk.hooks, hooks);

  document.getElementById('vk-level-row')?.addEventListener('click', (e) => {
    const chip = e.target.closest('[data-vk-level]');
    if (!chip) return;
    vk.level = Number(chip.dataset.vkLevel);
    vk.openPassage = null;
    render();
  });
  document.getElementById('vk-mode-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-vk-mode]');
    if (!tab) return;
    vk.mode = tab.dataset.vkMode;
    vk.openPassage = null;
    render();
  });

  document.getElementById('vk-body')?.addEventListener('click', (e) => {
    const t = e.target;
    const say = t.closest('.vk-say');
    if (say) { e.preventDefault(); speak(say.dataset.say, 'vi'); return; }
    const choice = t.closest('.vk-choice');
    if (choice) { onGrammarChoice(choice); return; }
    const retry = t.closest('.vk-retry');
    if (retry) {
      const pointEl = retry.closest('[data-vk-point]');
      const open = pointEl.open;
      render().then(() => {
        const again = document.querySelector(`[data-vk-point="${pointEl.dataset.vkPoint}"]`);
        if (again) { again.open = open; again.scrollIntoView({ block: 'start' }); }
      });
      return;
    }
    const deckBtn = t.closest('[data-vk-open-deck]');
    if (deckBtn) { vk.hooks.openDeck(deckBtn.dataset.vkOpenDeck); return; }
    const item = t.closest('[data-vk-passage]');
    if (item) { vk.openPassage = item.dataset.vkPassage; render(); window.scrollTo({ top: 0 }); return; }
    if (t.closest('[data-vk-back]')) { vk.openPassage = null; render(); return; }
    const read = t.closest('[data-vk-read]');
    if (read) {
      const p = vk.reading.get(vk.level)?.passages.find((x) => x.id === vk.openPassage);
      // 長い文を一度に渡すと途中で止まるブラウザがあるので、1文ずつ読み上げる
      const sentences = (p?.text ?? '').split(/(?<=[.!?…])\s+|\n+/).map((x) => x.trim()).filter(Boolean);
      if (sentences.length) speakDialogue(sentences.map((x) => ({ vi: x })), 'vi', { rate: Number(read.dataset.vkRead) * 0.9, gapMs: 200 });
      return;
    }
    if (t.closest('[data-vk-stop]')) { stopSpeaking(); return; }
    if (t.closest('[data-vk-grade]')) gradePassage();
  });
}
