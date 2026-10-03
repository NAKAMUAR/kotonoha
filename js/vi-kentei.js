// =====================================================================
// 言の葉 / Kotonoha — ベトナム語検定（実用ベトナム語技能検定）対策
//
// 級ごとに 3 つの練習:
//   単語 … 単語帳（SRS）の各級デッキへ案内
//   文法 … data/vi-grammar-{slug}.json  文型の説明・例文・確認問題（slug は 5kyu, pre6kyu など）
//   長文 … data/vi-reading-{slug}.json  読解文・設問・全訳
//
// 文法・長文の練習記録はこの端末（localStorage）に保存する。
// =====================================================================

import { speak, speakDialogue, stopSpeaking, SpeechSupport } from './scenarios.js';

// n は画面内の識別用の数値（準6級は 6）。slug はデータファイル名に使う。
export const KENTEI_LEVELS = Object.freeze([
  { n: 6, slug: 'pre6kyu', deck: 'vipre6kyu', label: '準6級', desc: 'はじめの一歩。文字と声調、あいさつ、数字、自己紹介など、ごく基本的な表現。' },
  { n: 5, slug: '5kyu', deck: 'vi5kyu', label: '5級', desc: '入門〜初級。あいさつ・数字・家族・買い物など、身の回りの簡単な表現。' },
  { n: 4, slug: '4kyu', deck: 'vi4kyu', label: '4級', desc: '初級。日常生活の基本的な会話と、短い文章の読み取り。問題文はベトナム語。' },
  { n: 3, slug: '3kyu', deck: 'vi3kyu', label: '3級', desc: '中級。仕事・旅行・社会生活の話題。新聞の易しい記事程度の文章。' },
  { n: 2, slug: '2kyu', deck: 'vi2kyu', label: '2級', desc: '中上級。社会・経済・文化の幅広い話題。論理的な文章の読解。' },
  { n: 1, slug: '1kyu', deck: 'vi1kyu', label: '1級', desc: '上級（通訳レベル）。専門的・抽象的な話題、成語や硬い書き言葉。' },
]);

const GRAMMAR_KEY = 'kotonoha.vik.grammar'; // { pointId: true }（確認問題を全問正解）
const READING_KEY = 'kotonoha.vik.reading'; // { passageId: bestScorePercent }

const vk = {
  level:   5,
  mode:    'grammar',
  grammar: new Map(),  // n → data | null
  reading: new Map(),
  openPassage: null,
  words:   new Map(),  // deck → 単語の配列（一覧表示用）
  wl:      { q: '', cat: '', shown: 0 },  // 単語一覧の検索語・分類・表示件数
  hooks: { showToast: () => {}, openDeck: () => {}, deckWords: async () => [] },
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
    const res = await fetch(`./data/vi-${kind}-${levelInfo(n).slug}.json`);
    if (res.ok) data = await res.json();
  } catch (err) {
    console.warn(`vi-kentei ${kind} ${levelInfo(n).slug} load failed:`, err);
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

// 単語データの分類タグ → 日本語の表示名
const TAG_LABELS = {
  greeting: 'あいさつ', phrase: '決まり文句・表現', basic: '基本語', person: '人・呼び方', people: '人', pronoun: '代名詞',
  family: '家族', number: '数', measure: '単位・数量', money: 'お金', color: '色', country: '国・言葉',
  verb: '動詞', general_verbs: '動詞', action: '動作', adj: '形容詞', adjective: '形容詞', general_adjectives: '形容詞',
  adverb: '副詞', general_adverbs: '副詞', connector: '接続の言葉', grammar: '文法語', classifier: '類別詞',
  demonstrative: '指示語', question: '疑問詞', position: '位置', time: '時間', weather: '天気',
  food: '食べ物', drink: '飲み物', fruit: '果物', vegetable: '野菜', cooking: '料理',
  place: '場所', city: '都市', urban: '都市', house: 'すまい', household: '家庭用品', thing: '身の回りの物', tool: '道具',
  clothes: '服', fashion: 'ファッション', beauty: '美容', body: '体', health: '健康・医療', mental: '心の健康',
  school: '学校', education: '教育', academic: '学術', science: '科学', tech: 'IT・技術', it: 'IT', it_advanced: 'IT（上級）',
  work: '仕事', job: '職業', occupation: '職業', office: 'オフィス', business: 'ビジネス', hr: '人事',
  sales: '営業・販売', retail: '小売', service: 'サービス', shopping: '買い物', trade: '貿易', finance: '金融',
  economy: '経済', industry: '産業', manufacturing: '製造', manufacturing_advanced: '製造（上級）', quality: '品質管理',
  construction: '建設', construction_advanced: '建設（上級）', material: '素材', agriculture: '農業',
  transport: '交通', traffic: '交通', travel: '旅行', travel_extended: '旅行（応用）',
  hobby: '趣味', sports: 'スポーツ', sport: 'スポーツ', sports_hobbies: 'スポーツ・趣味', music: '音楽', entertainment: '娯楽',
  art: '芸術', art_culture: '芸術・文化', craft: '工芸', culture: '文化', festival: '祭り・行事', literature: '文学', literary: '文学的表現',
  nature: '自然', animal: '動物', plant: '植物', environment: '環境', disaster: '災害', geography: '地理',
  feeling: '気持ち', emotion: '感情', character: '性格', describe: '様子・性質', perception: '感覚',
  life: '生活', daily: '日常', personal: '個人', social: '人付き合い', relation: '人間関係', communication: 'コミュニケーション', gesture: 'しぐさ',
  society: '社会', politics: '政治', government: '行政', law: '法律', legal: '法律', history: '歴史', belief: '信仰・価値観', value: '価値観',
  media: '報道・メディア', formal: '書き言葉', abstract: '抽象語', idiom: '成語・ことわざ', trouble: 'トラブル', general: '一般',
};
const tagLabel = (t) => TAG_LABELS[t] ?? t;
const WL_PAGE = 100;

// 読み上げ用：（…）の補足や「...」を除く
const speakable = (w) => String(w ?? '').replace(/\s*[（(][^）)]*[）)]/g, '').replace(/\.{3}|…/g, ' ').trim();

async function levelWords(deck) {
  if (!vk.words.has(deck)) vk.words.set(deck, await vk.hooks.deckWords(deck));
  return vk.words.get(deck);
}

async function renderVocab(body) {
  const info  = levelInfo(vk.level);
  const words = await levelWords(info.deck);
  if (!words.length) {
    body.innerHTML = `<div class="card"><h3 class="card-title">${esc(info.label)}の単語</h3>
      <p class="text-sm text-sumi-light mt-3">この級の単語は準備中です。</p></div>`;
    return;
  }
  const cats = new Map();
  for (const w of words) {
    const t = w.tags?.[1];
    if (t) cats.set(tagLabel(t), (cats.get(tagLabel(t)) ?? 0) + 1);
  }
  const catOpts = [...cats].sort((a, b) => b[1] - a[1])
    .map(([label, n]) => `<option value="${esc(label)}">${esc(label)}（${n}）</option>`).join('');
  vk.wl.shown = WL_PAGE;
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">${esc(info.label)}の単語</h3>
      <p class="text-sm text-sumi-light mt-3">${words.length.toLocaleString()} 語。下の一覧で確認できます。単語帳（間隔反復 SRS）なら、忘れかけた頃に自動で復習できます。</p>
      <button class="btn-primary w-full mt-4" data-vk-open-deck="${esc(info.deck)}">単語帳で ${esc(info.label)} を学習する</button>
    </div>
    <div class="card mt-4">
      <div class="vk-wl-tools">
        <input id="vk-wl-q" type="search" class="vk-wl-search" placeholder="検索（ベトナム語・日本語）" value="${esc(vk.wl.q)}">
        <select id="vk-wl-cat" class="vk-wl-select">
          <option value="">すべての分類（${words.length}）</option>${catOpts}
        </select>
      </div>
      <div id="vk-wl-count" class="text-xs text-sumi-soft mt-2"></div>
      <ul id="vk-wl-list" class="vk-wl"></ul>
      <button id="vk-wl-more" class="btn-secondary w-full mt-3 hidden" data-vk-wl-more="1"></button>
    </div>`;
  const sel = document.getElementById('vk-wl-cat');
  if ([...sel.options].some((o) => o.value === vk.wl.cat)) sel.value = vk.wl.cat; else vk.wl.cat = '';
  renderWordList();
}

// 声調記号を外して比べる（「pho」で「phở」も見つかるように）
const fold = (t) => String(t ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd');

function renderWordList() {
  const list = document.getElementById('vk-wl-list');
  if (!list) return;
  const words = vk.words.get(levelInfo(vk.level).deck) ?? [];
  const q = fold(vk.wl.q.trim());
  const hits = words.filter((w) =>
    (!vk.wl.cat || tagLabel(w.tags?.[1]) === vk.wl.cat) &&
    (!q || fold(w.word).includes(q) || fold(w.meaning).includes(q) || String(w.reading ?? '').includes(vk.wl.q.trim())));
  // 検索中は「完全一致 → 前方一致 → その他」の順に並べる
  if (q) {
    const rank = (w) => { const f = fold(speakable(w.word)); return f === q ? 0 : f.startsWith(q) ? 1 : 2; };
    hits.sort((x, y) => rank(x) - rank(y));
  }
  const shown = hits.slice(0, vk.wl.shown);
  document.getElementById('vk-wl-count').textContent =
    hits.length ? `${hits.length.toLocaleString()} 語${hits.length > shown.length ? `（うち ${shown.length} 語を表示）` : ''}・語をタップすると例文が見られます` : '該当する単語がありません';
  list.innerHTML = shown.map((w) => `
    <li class="vk-wl-row">
      ${sayBtn(speakable(w.word))}
      <details class="vk-wl-item">
        <summary>
          <span class="vk-wl-vi">${esc(w.word)}</span>
          <span class="vk-wl-read">${esc(w.reading)}</span>
          <span class="vk-wl-ja">${esc(w.meaning)}</span>
        </summary>
        ${w.example ? `<div class="vk-wl-ex">
          <div class="vk-vi">${esc(w.example)} ${sayBtn(w.example)}</div>
          <div class="vk-ja">${esc(w.exampleTranslation)}</div>
        </div>` : ''}
      </details>
    </li>`).join('');
  const more = document.getElementById('vk-wl-more');
  const rest = hits.length - shown.length;
  more.classList.toggle('hidden', rest <= 0);
  more.textContent = `もっと見る（残り ${rest.toLocaleString()} 語）`;
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
  // 正解を入れたベトナム語の文だけ読み上げる（日本語を含む問題文はベトナム語の声で読めないので除く）
  if (SpeechSupport.tts && /_{3}/.test(q.q) && !/[\u3040-\u30ff\u4e00-\u9fff]/.test(q.q)) {
    speak(q.q.replace(/_{3,}/g, q.choices[q.answer]), 'vi');
  }

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
    vk.wl = { q: '', cat: '', shown: 0 };
    render();
  });
  document.getElementById('vk-mode-tabs')?.addEventListener('click', (e) => {
    const tab = e.target.closest('[data-vk-mode]');
    if (!tab) return;
    vk.mode = tab.dataset.vkMode;
    vk.openPassage = null;
    render();
  });

  const vkBody = document.getElementById('vk-body');
  vkBody?.addEventListener('input', (e) => {
    if (e.target.id !== 'vk-wl-q') return;
    vk.wl.q = e.target.value; vk.wl.shown = WL_PAGE; renderWordList();
  });
  vkBody?.addEventListener('change', (e) => {
    if (e.target.id !== 'vk-wl-cat') return;
    vk.wl.cat = e.target.value; vk.wl.shown = WL_PAGE; renderWordList();
  });
  vkBody?.addEventListener('click', (e) => {
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
    if (t.closest('[data-vk-wl-more]')) { vk.wl.shown += WL_PAGE; renderWordList(); return; }
    const deckBtn = t.closest('[data-vk-open-deck]');
    if (deckBtn) { vk.hooks.openDeck(deckBtn.dataset.vkOpenDeck); return; }
    const item = t.closest('[data-vk-passage]');
    if (item) { vk.openPassage = item.dataset.vkPassage; render(); window.scrollTo({ top: 0 }); return; }
    if (t.closest('[data-vk-back]')) { vk.openPassage = null; render(); return; }
    const read = t.closest('[data-vk-read]');
    if (read) {
      const p = vk.reading.get(vk.level)?.passages.find((x) => x.id === vk.openPassage);
      // 長い文を一度に渡すと途中で止まるブラウザがあるので、1文ずつ読み上げる
      // 会話文の話者ラベル（「A:」など）は読み上げない
      const sentences = (p?.text ?? '').split(/(?<=[.!?…])\s+|\n+/)
        .map((x) => x.trim().replace(/^[A-Z]{1,2}\s*[:：]\s*/, '')).filter(Boolean);
      if (sentences.length) speakDialogue(sentences.map((x) => ({ vi: x })), 'vi', { rate: Number(read.dataset.vkRead) * 0.9, gapMs: 200 });
      return;
    }
    if (t.closest('[data-vk-stop]')) { stopSpeaking(); return; }
    if (t.closest('[data-vk-grade]')) gradePassage();
  });
}
