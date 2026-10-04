// =====================================================================
// 言の葉 / Kotonoha — 学習プラン
//
//   実力テスト（4 技能を級・レベルの階段で測る）
//     → 結果から「次に取り組む級」と弱点（間違えた問題・文法項目）を記録
//     → 毎日のメニュー（1 日のカリキュラムに沿って、弱点と目標レベルから自動で組む）
//     → 週 1 回の確認テスト・4 週ごとの実力テストで弱点と目標を更新
//
// 記録はこの端末（localStorage）に保存し、ログイン中は Firestore の
// progress.studyPlan にも同期する（新しい方を採用）。
// =====================================================================

import { speak, stopSpeaking, SpeechSupport } from './scenarios.js';
import { kenteiProgress } from './vi-kentei.js';

const STORE_KEY  = 'kotonoha.plan';
const DAY_MS     = 24 * 60 * 60 * 1000;
const CHECK_DAYS = 7;    // 確認テストの間隔
const FULL_DAYS  = 28;   // 実力テストの間隔
const MINUTES    = [15, 30, 60];
const NEW_WORDS  = { 15: 5, 30: 10, 60: 15 };
const DRILL_SIZE = { 15: 6, 30: 8, 60: 12 };
const CHECK_SIZE = 12;

const VI_N     = [6, 5, 4, 3, 2, 1];                     // 6 = 準6級
const VI_SLUGS = ['pre6kyu', '5kyu', '4kyu', '3kyu', '2kyu', '1kyu'];
const EN_LEVELS = ['A1', 'A2', 'B1', 'B2', 'C1'];

const LANG = {
  vi: {
    label: 'ベトナム語', speech: 'vi',
    levels: ['準6級', '5級', '4級', '3級', '2級', '1級'],
    deck: (i) => (i === 0 ? 'vipre6kyu' : `vi${VI_N[i]}kyu`),
    deckLabel: (i) => `ベトナム語検定${i === 0 ? '準6級' : `${VI_N[i]}級`}`,
    start: [
      { label: 'はじめて／あいさつ程度', idx: 0 },
      { label: '基礎（5〜4級くらい）', idx: 1 },
      { label: '中級（3級くらい）', idx: 3 },
      { label: '上級（2級以上）', idx: 4 },
    ],
  },
  en: {
    label: '英語', speech: 'en',
    levels: EN_LEVELS,
    deck: (i) => (i <= 1 ? 'daily' : 'toeic'),
    deckLabel: (i) => (i <= 1 ? '日常会話 単語（英語）' : 'TOEIC 単語'),
    start: [
      { label: '中学英語くらい', idx: 0 },
      { label: '高校英語くらい', idx: 1 },
      { label: 'TOEIC 600点前後', idx: 2 },
      { label: 'TOEIC 800点前後', idx: 3 },
      { label: 'TOEIC 900点以上', idx: 4 },
    ],
    // ETS が公表している TOEIC L&R と CEFR の対応（各レベルの下限の目安）
    hint: ['TOEIC 120点〜', 'TOEIC 225点〜', 'TOEIC 550点〜', 'TOEIC 785点〜', 'TOEIC 945点〜'],
  },
};

const SKILLS = [
  { id: 'vocab',     label: '語彙' },
  { id: 'grammar',   label: '文法' },
  { id: 'listening', label: '聴解' },
  { id: 'reading',   label: '読解' },
];
const skillLabel = (id) => SKILLS.find((s) => s.id === id)?.label ?? id;

const EN_TAGS = {
  be: 'be動詞', present: '現在形（三単現）', past: '過去形', question: '疑問文・否定文', prep: '前置詞',
  pronoun: '代名詞', plural: '名詞の複数形', article: '冠詞', modal: '助動詞', progressive: '進行形',
  compare: '比較', future: '未来の表現', perfect: '現在完了', gerund: '動名詞・不定詞', conj: '接続詞',
  'grammar-tense': '時制', 'grammar-form': '品詞・語形', 'grammar-prep': '前置詞', 'grammar-conj': '接続詞',
  'grammar-pronoun': '代名詞', 'grammar-agreement': '主語と動詞の一致',
};

const KIND_ICON = { srs: '語', drill: '練', grammar: '法', reading: '読', listen: '聴', output: '話', night: '寝', test: '測' };

const ui = {
  tab: 'menu',          // menu | test | curriculum | media
  sess: null,           // 実行中のテスト・ドリル
  lastResult: null,     // 直前に終えたテストの結果（結果画面用）
  busy: false,
};
const hooks = {
  showScreen: () => {}, openDeck: () => {}, openKentei: () => {},
  todayActivity: async () => ({ total: 0, reviewedToday: 0, reviewDue: 0, newLeft: 0 }),
  markStudied: () => {}, persist: () => {}, remoteState: () => null, showToast: () => {},
};

// ---------- 小道具 ----------

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const pick = (arr) => (arr?.length ? arr[Math.floor(Math.random() * arr.length)] : undefined);
function shuffle(a) {
  const b = [...a];
  for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; }
  return b;
}
const speakable = (w) => String(w ?? '').replace(/\s*[（(][^）)]*[）)]/g, '').replace(/\.{3}|…/g, ' ').trim();
function dateKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const fmtDate = (t) => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()}`; };
const daysSince = (t) => Math.floor((Date.now() - t) / DAY_MS);
const levelName = (lang, idx) => (idx < 0 ? `${LANG[lang].levels[0]}の手前` : LANG[lang].levels[idx]);

// ---------- 保存 ----------

function blankState() {
  return {
    v: 1, updatedAt: 0, lang: 'vi', minutes: 30,
    results: { vi: [], en: [] },
    weak: { vi: { items: [], points: [], tags: [] }, en: { items: [], points: [], tags: [] } },
    steps: { vi: null, en: null },     // 段階テストの進み具合
    partial: { vi: null, en: null },   // 途中まで受けた実力テスト
    days: {},
  };
}
function normalize(s) {
  const b = blankState();
  const out = { ...b, ...s };
  out.results = { ...b.results, ...(s.results ?? {}) };
  out.weak = {
    vi: { ...b.weak.vi, ...(s.weak?.vi ?? {}) },
    en: { ...b.weak.en, ...(s.weak?.en ?? {}) },
  };
  out.days = s.days ?? {};
  out.steps = { ...b.steps, ...(s.steps ?? {}) };
  out.partial = { ...b.partial, ...(s.partial ?? {}) };
  if (!MINUTES.includes(out.minutes)) out.minutes = 30;
  if (!LANG[out.lang]) out.lang = 'vi';
  return out;
}
function loadLocal() {
  try {
    const s = JSON.parse(localStorage.getItem(STORE_KEY) ?? 'null');
    if (s?.v === 1) return normalize(s);
  } catch { /* 読めなければ新規 */ }
  return blankState();
}
let st = loadLocal();
let persistTimer = null;

function save() {
  st.updatedAt = Date.now();
  // 古い記録を間引く（端末と Firestore の容量を抑える）
  const keepDays = Object.keys(st.days).sort().slice(-21);
  st.days = Object.fromEntries(keepDays.map((k) => [k, st.days[k]]));
  for (const l of Object.keys(st.results)) st.results[l] = st.results[l].slice(-24);
  for (const l of Object.keys(st.weak)) {
    st.weak[l].items  = st.weak[l].items.slice(-80);
    st.weak[l].points = st.weak[l].points.slice(-20);
    st.weak[l].tags   = st.weak[l].tags.slice(-10);
  }
  try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch { /* 保存できなくても続ける */ }
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    try { hooks.persist(JSON.parse(JSON.stringify(st))); } catch (err) { console.warn('plan persist failed:', err); }
  }, 1500);
}

/** ログイン後などに Firestore 側の記録と比べ、新しい方を使う */
export function mergeRemotePlan(remote) {
  if (remote?.v === 1 && (remote.updatedAt ?? 0) > (st.updatedAt ?? 0)) {
    st = normalize(remote);
    try { localStorage.setItem(STORE_KEY, JSON.stringify(st)); } catch { /* 無視 */ }
  }
}

function dayRec(lang, key = dateKey()) {
  st.days[key] ??= {};
  st.days[key][lang] ??= { done: {}, mistakes: [] };
  return st.days[key][lang];
}

// ---------- 問題データ ----------

const jsonCache = new Map();
function getJson(url) {
  if (!jsonCache.has(url)) {
    jsonCache.set(url, fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null));
  }
  return jsonCache.get(url);
}

function indexLevel(L) {
  L.wordById   = new Map(L.words.map((w) => [w.id, w]));
  L.exWords    = L.words.filter((w) => w.example && w.exampleTranslation);
  L.meanings   = [...new Set(L.words.map((w) => w.meaning))];
  L.exTrans    = [...new Set(L.exWords.map((w) => w.exampleTranslation))];
  L.pointById  = new Map((L.points ?? []).map((p) => [p.id, p]));
  L.grammarById = new Map((L.grammar ?? []).map((g) => [g.id, g]));
  L.passageById = new Map(L.passages.map((p) => [p.id, p]));
  return L;
}

async function buildViBank() {
  return Promise.all(VI_SLUGS.map(async (slug, i) => {
    const [words, grammar, reading] = await Promise.all([
      getJson(`./data/vocabulary-vi-${slug}.json`),
      getJson(`./data/vi-grammar-${slug}.json`),
      getJson(`./data/vi-reading-${slug}.json`),
    ]);
    return indexLevel({
      idx: i,
      words: words ?? [],
      points: grammar?.points ?? [],
      passages: (reading?.passages ?? []).map((p) => ({
        id: p.id, title: p.title, text: p.text,
        questions: p.questions.map((q) => ({ q: q.q, sub: q.qJa ?? '', choices: q.choices, answer: q.answer, explain: q.explain })),
      })),
    });
  }));
}

async function buildEnBank() {
  const [daily, toeic, tr, basic] = await Promise.all([
    getJson('./data/vocabulary-en.json'),
    getJson('./data/vocabulary-toeic.json'),
    getJson('./data/toeic-reading.json'),
    getJson('./data/en-basic.json'),
  ]);
  const p5 = (tr ?? []).filter((x) => x.part === 5 && x.tags?.some((t) => t.startsWith('grammar-')));
  const p7 = (tr ?? []).filter((x) => x.part === 7 && x.type === 'single_passage');
  return EN_LEVELS.map((lv, i) => indexLevel({
    idx: i,
    words: ((i <= 1 ? daily : toeic) ?? []).filter((w) => w.level === lv),
    grammar: i <= 1
      ? (basic?.grammar ?? []).filter((g) => g.level === lv)
          .map((g) => ({ id: g.id, q: g.q, choices: g.choices, answer: g.answer, explain: g.explain, ja: g.ja, tag: g.tag }))
      : p5.filter((x) => x.level === lv)
          .map((x) => ({ id: x.id, q: x.sentence, choices: x.choices, answer: x.correct, explain: x.explanation,
                         tag: x.tags.find((t) => t.startsWith('grammar-')) })),
    passages: i <= 1
      ? (basic?.reading ?? []).filter((p) => p.level === lv)
          .map((p) => ({ id: p.id, title: p.title, text: p.text,
                         questions: p.questions.map((q) => ({ q: q.q, choices: q.choices, answer: q.answer, explain: q.explain })) }))
      : p7.filter((x) => x.level === lv)
          .map((x) => ({ id: x.id, title: x.passageTypeJa ?? '', text: x.passage,
                         questions: x.questions.map((q) => ({ q: q.q, choices: q.choices, answer: q.correct, explain: q.explanation })) })),
  }));
}

const banks = {};
function bank(lang) {
  banks[lang] ??= (lang === 'vi' ? buildViBank() : buildEnBank());
  return banks[lang];
}

// 4 択の選択肢を作る（同じレベルの別の語・訳を誤答に使う）
function withDistractors(answer, pool, n = 3) {
  const opts = new Set([answer]);
  for (const c of shuffle(pool)) {
    if (opts.size > n) break;
    if (c && c !== answer) opts.add(c);
  }
  const choices = shuffle([...opts]);
  return { choices, answer: choices.indexOf(answer) };
}

/** 問題キー → 出題データ。キーは端末をまたいで保存できるよう文字列にしている */
function itemFromKey(B, lang, key) {
  const [t, li, a, b] = String(key).split('|');
  const L = B[Number(li)];
  if (!L) return null;
  const level = Number(li);
  if (t === 'v') {
    const w = L.wordById.get(a);
    if (!w) return null;
    return { key, skill: 'vocab', level, prompt: w.word, reading: w.reading, say: speakable(w.word),
             ...withDistractors(w.meaning, L.meanings),
             explain: w.example ? `例：${w.example}（${w.exampleTranslation}）` : '' };
  }
  if (t === 'l') {
    const w = L.wordById.get(a);
    if (!w?.example) return null;
    return { key, skill: 'listening', level, prompt: '', hidden: true, say: w.example, autoSay: true,
             ...withDistractors(w.exampleTranslation, L.exTrans),
             explain: `音声：${w.example}` };
  }
  if (t === 'g' && lang === 'vi') {
    const p = L.pointById.get(a);
    const q = p?.quiz?.[Number(b)];
    if (!q) return null;
    return { key, skill: 'grammar', level, prompt: q.q, choices: q.choices, answer: q.answer,
             explain: [q.ja, q.explain].filter(Boolean).join('　'), point: { level, id: p.id, title: p.title } };
  }
  if (t === 'g') {
    const g = L.grammarById.get(a);
    if (!g) return null;
    return { key, skill: 'grammar', level, prompt: g.q, choices: g.choices, answer: g.answer,
             explain: [g.ja, g.explain].filter(Boolean).join('　'), tag: g.tag };
  }
  if (t === 'r') {
    const p = L.passageById.get(a);
    const q = p?.questions?.[Number(b)];
    if (!q) return null;
    return { key, skill: 'reading', level, passage: { id: p.id, title: p.title, text: p.text },
             prompt: q.q, sub: q.sub ?? '', choices: q.choices, answer: q.answer, explain: q.explain ?? '' };
  }
  return null;
}

/** そのレベル・技能の新しい問題キーを 1 つ選ぶ */
function randomKey(B, lang, skill, li, used = new Set()) {
  const L = B[li];
  if (!L) return null;
  for (let tries = 0; tries < 40; tries++) {
    let key = null;
    if (skill === 'vocab') { const w = pick(L.words); if (w) key = `v|${li}|${w.id}`; }
    else if (skill === 'listening') { const w = pick(L.exWords); if (w) key = `l|${li}|${w.id}`; }
    else if (skill === 'grammar' && lang === 'vi') {
      const p = pick(L.points);
      if (p?.quiz?.length) key = `g|${li}|${p.id}|${Math.floor(Math.random() * p.quiz.length)}`;
    } else if (skill === 'grammar') { const g = pick(L.grammar); if (g) key = `g|${li}|${g.id}`; }
    if (key && !used.has(key)) return key;
  }
  return null;
}

// ---------- レベルの階段（実力テストの適応出題） ----------

function newStair(skill, K, pass, start, max) {
  return { skill, K, pass, max, cur: Math.min(Math.max(start, 0), max), n: 0, ok: 0, passed: [], failed: [], done: false };
}
function stairAnswer(s, correct) {
  s.n += 1;
  if (correct) s.ok += 1;
  if (s.n < s.K) return;
  const ok = s.ok >= s.pass;
  (ok ? s.passed : s.failed).push(s.cur);
  s.n = 0; s.ok = 0;
  if (ok) {
    if (s.cur < s.max && !s.failed.includes(s.cur + 1)) s.cur += 1; else s.done = true;
  } else if (!s.passed.length && s.cur > 0) {
    s.cur -= 1;                                   // 最初の段で不合格なら一段下げて確かめる
  } else {
    s.done = true;
  }
}
const stairEst = (s) => (s.passed.length ? Math.max(...s.passed) : -1);

// ---------- テスト・ドリルのセッション ----------

const PARTIAL_DAYS = 7;   // 途中まで受けた実力テストを続きから受けられる日数

function validPartial(lang) {
  const pt = st.partial[lang];
  return pt && daysSince(pt.date) < PARTIAL_DAYS && Object.keys(pt.est ?? {}).length ? pt : null;
}

async function startFullTest(lang, startIdx, resume = false) {
  const B = await bank(lang);
  const max = B.length - 1;
  const pt = resume ? validPartial(lang) : null;
  const est = { ...(pt?.est ?? {}) };
  const all = ['vocab', 'grammar', ...(SpeechSupport.tts ? ['listening'] : []), 'reading'];
  const first = pt ? pt.startIdx : startIdx;
  const sections = all.filter((sk) => !(sk in est)).map((sk) => ({
    skill: sk,
    stair: sk === 'vocab' ? newStair('vocab', 4, 3, first, max) : null,
    passages: 0,
  }));
  if (!pt) st.partial[lang] = null;
  ui.sess = { kind: 'full', lang, B, sections, allSkills: all, si: 0, queue: [], used: new Set(), log: [], est,
              carry: { ...(pt?.score ?? { asked: 0, correct: 0 }) },   // 前回までに答えた問題数
              item: null, picked: null, startIdx: first, inBreak: null };
  nextItem();
}

async function startFixed(kind, lang, keys, opts = {}) {
  const B = await bank(lang);
  const items = keys.map((k) => itemFromKey(B, lang, k)).filter(Boolean);
  if (!items.length) { hooks.showToast(kind === 'night' ? '今日の間違いはありません' : '出題できる問題がありませんでした'); return false; }
  ui.sess = { kind, lang, B, fixed: items, total: items.length, log: [], item: null, picked: null,
              breaks: !!opts.breaks, allSkills: [...new Set(items.map((x) => x.skill))], inBreak: null, est: {}, ...opts };
  nextItem();
  return true;
}

function sectionStart(sess) {
  const e = (skill) => sess.est[skill] ?? -1;
  const v = e('vocab'), g = e('grammar');
  return { grammar: Math.max(0, v), listening: Math.max(0, Math.min(v, g)), reading: Math.max(0, Math.min(v, g)) };
}

// パートの区切り（語彙 → 文法 → …）。区切りの画面を出して止まる
function enterBreak(sess, done, next) {
  sess.inBreak = { done, next };
  sess.item = null;
  renderPlan();
}

function nextItem() {
  const sess = ui.sess;
  if (!sess) return;
  sess.picked = null;
  if (sess.fixed) {
    const prev = sess.item;
    const peek = sess.fixed[0];
    if (sess.breaks && !sess.inBreak && prev && peek && peek.skill !== prev.skill) {
      enterBreak(sess, prev.skill, peek.skill);
      return;
    }
    sess.inBreak = null;
    sess.item = sess.fixed.shift() ?? null;
    if (!sess.item) { finishSession(); return; }
    renderPlan();
    return;
  }
  sess.inBreak = null;
  const max = sess.B.length - 1;
  while (sess.si < sess.sections.length) {
    const sec = sess.sections[sess.si];
    if (!sec.stair) {
      const st0 = sectionStart(sess)[sec.skill] ?? 0;
      sec.stair = newStair(sec.skill, 3, 2, st0, max);
    }
    const s = sec.stair;
    if (!s.done) {
      let key = null;
      if (sec.skill === 'reading') {
        if (!sess.queue.length) {
          const p = sec.passages < 3 ? pick(sess.B[s.cur].passages) : null;
          if (p) {
            sec.passages += 1;
            sess.queue = p.questions.map((_, qi) => `r|${s.cur}|${p.id}|${qi}`);
            s.K = sess.queue.length; s.pass = Math.ceil(s.K * 2 / 3);
          }
        }
        key = sess.queue.shift() ?? null;
      } else {
        key = randomKey(sess.B, sess.lang, sec.skill, s.cur, sess.used);
      }
      const item = key ? itemFromKey(sess.B, sess.lang, key) : null;
      if (item) {
        sess.used.add(key);
        sess.item = item;
        renderPlan();
        return;
      }
      s.done = true;   // そのレベルに問題が無い
    }
    // このパートはおわり：結果を記録して、途中経過として保存
    sess.est[sec.skill] = stairEst(s);
    sess.queue = [];
    sess.si += 1;
    st.partial[sess.lang] = { date: Date.now(), startIdx: sess.startIdx, est: { ...sess.est },
      score: { asked: sess.carry.asked + sess.log.length, correct: sess.carry.correct + sess.log.filter((e) => e.correct).length } };
    save();
    if (sess.si < sess.sections.length) {
      enterBreak(sess, sec.skill, sess.sections[sess.si].skill);
      return;
    }
  }
  finishSession();
}

function answer(ci) {
  const sess = ui.sess;
  if (!sess?.item || sess.picked !== null) return;
  const it = sess.item;
  const correct = ci === it.answer;
  sess.picked = ci;
  sess.log.push({ key: it.key, skill: it.skill, level: it.level, correct, point: it.point ?? null, tag: it.tag ?? null });
  if (sess.kind === 'full') stairAnswer(sess.sections[sess.si].stair, correct);
  if (!correct) {
    const day = dayRec(sess.lang);
    if (!day.mistakes.includes(it.key)) day.mistakes.push(it.key);
  }
  if (it.skill === 'listening' || it.skill === 'grammar') {
    // 正解の文を聞いて確認
    const text = it.skill === 'listening' ? it.say : (/_{3}/.test(it.prompt) ? it.prompt.replace(/_{3,}/g, it.choices[it.answer]) : '');
    if (text && SpeechSupport.tts && !/[぀-ヿ一-鿿]/.test(text)) speak(text, LANG[sess.lang].speech);
  }
  renderPlan();
  // 解説の下の「次へ」ボタンが画面内に見えるようにする
  document.querySelector('[data-pl-next]')?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

function applyLog(lang, log) {
  const w = st.weak[lang];
  for (const e of log) {
    if (e.correct) w.items = w.items.filter((k) => k !== e.key);
    else if (!w.items.includes(e.key)) w.items.push(e.key);
    if (e.point && !e.correct) {
      const pk = `${e.point.level}|${e.point.id}`;
      if (!w.points.includes(pk)) w.points.push(pk);
    }
    if (e.tag && !e.correct && !w.tags.includes(e.tag)) w.tags.push(e.tag);
  }
  // 今回正解し、間違いが残っていない文法項目・分野は弱点から外す
  w.points = w.points.filter((pk) =>
    w.items.some((k) => k.startsWith(`g|${pk}|`)) ||
    !log.some((e) => e.point && `${e.point.level}|${e.point.id}` === pk && e.correct));
  w.tags = w.tags.filter((t) => !(log.some((e) => e.tag === t && e.correct) && !log.some((e) => e.tag === t && !e.correct)));
}

function finishSession({ partialOnly = false } = {}) {
  const sess = ui.sess;
  if (!sess) return;
  stopSpeaking();
  const { lang, log } = sess;
  let kind = sess.kind;
  applyLog(lang, log);
  const carry = sess.carry ?? { asked: 0, correct: 0 };
  const score = { asked: carry.asked + log.length, correct: carry.correct + log.filter((e) => e.correct).length };
  let result = null;
  let stage = null;
  if (kind === 'full' && partialOnly) {
    kind = 'partial';                     // 途中まで：終わったパートだけ保存して、続きは後で
  } else if (kind === 'full') {
    const levels = {};
    const detail = {};
    st.partial[lang] = null;
    for (const sk of SKILLS) {
      levels[sk.id] = sk.id in sess.est ? sess.est[sk.id] : null;
      const part = log.filter((e) => e.skill === sk.id);
      detail[sk.id] = { asked: part.length, correct: part.filter((e) => e.correct).length };
    }
    result = { date: Date.now(), kind, levels, detail, score };
  } else if (kind === 'check') {
    result = { date: Date.now(), kind, score,
               detail: Object.fromEntries(SKILLS.map((sk) => {
                 const part = log.filter((e) => e.skill === sk.id);
                 return [sk.id, { asked: part.length, correct: part.filter((e) => e.correct).length }];
               })) };
  }
  if (kind === 'stage') stage = finishStage(lang, log);
  if (result) st.results[lang].push(result);
  if (kind === 'full') syncSteps(lang);   // 実力テストの結果をステップにも反映
  const day = dayRec(lang);
  if (kind === 'drill') day.done.drill = true;
  if (kind === 'grammar-drill') day.done.grammar = true;
  if (kind === 'night') day.done.night = true;
  if (kind === 'full' || kind === 'check') day.done.test = true;
  save();
  hooks.markStudied();
  ui.lastResult = { kind, lang, score, result, stage, est: { ...sess.est }, missed: log.filter((e) => !e.correct) };
  ui.sess = null;
  renderPlan();
  refreshHomePlan();
}

// ---------- 結果から目標と弱点を読む ----------

const fullResults = (lang) => st.results[lang].filter((r) => r.kind === 'full');
const latestFull  = (lang) => fullResults(lang).at(-1) ?? null;
const latestAny   = (lang) => st.results[lang].filter((r) => r.kind === 'full' || r.kind === 'check').at(-1) ?? null;

function targets(lang, r) {
  const max = LANG[lang].levels.length - 1;
  const t = {};
  for (const sk of SKILLS) {
    const e = r?.levels?.[sk.id];
    t[sk.id] = Math.min(max, (e == null ? (r?.levels?.vocab ?? -1) : e) + 1);
  }
  // 段階テストで進んだステップより下のレベルは練習しない
  const sp = st.steps[lang];
  if (sp) for (const sk of SKILLS) t[sk.id] = Math.max(t[sk.id], Math.min(max, sp.idx));
  return t;
}

// ---------- ステップ（段階テスト） ----------
//   各レベルの段階テスト（約20問）に全問正解すると合格し、次のステップへ進む。
//   間違えた問題だけが再テストに残り、正解すると消える。
//   実力テストで合格したレベルより下は「合格扱い」。

const STAGE_COUNTS = { vocab: 8, grammar: 6, listening: 3 };

function syncSteps(lang, create = false) {
  const max = LANG[lang].levels.length - 1;
  const r = latestFull(lang);
  if (!st.steps[lang]) {
    if (!r && !create) return null;
    st.steps[lang] = { idx: 0, placed: 0, passed: [], stage: null };
  }
  const sp = st.steps[lang];
  if (r) {
    const lv = SKILLS.map((sk) => r.levels?.[sk.id]).filter((x) => x != null);
    const placed = Math.min(max + 1, Math.max(0, Math.min(...lv) + 1));   // いちばん低い技能の次のレベルから
    if (placed > sp.placed) {
      sp.placed = placed;
      if (sp.idx < placed) { sp.idx = placed; sp.stage = null; }
    }
  }
  return sp;
}

async function buildStageKeys(lang, li) {
  const B = await bank(lang);
  const L = B[li];
  const used = new Set();
  const keys = [];
  for (const skill of ['vocab', 'grammar', ...(SpeechSupport.tts ? ['listening'] : [])]) {
    let n = STAGE_COUNTS[skill];
    if (skill === 'grammar' && lang === 'vi') {
      // できるだけ別々の文法項目から出す
      for (const p of shuffle(L.points)) {
        if (!n) break;
        if (!p.quiz?.length) continue;
        keys.push(`g|${li}|${p.id}|${Math.floor(Math.random() * p.quiz.length)}`); n -= 1;
      }
      continue;
    }
    for (let i = 0; n > 0 && i < 60; i++) {
      const k = randomKey(B, lang, skill, li, used);
      if (!k) break;
      used.add(k); keys.push(k); n -= 1;
    }
  }
  const p = pick(L.passages);
  if (p) p.questions.forEach((_, qi) => keys.push(`r|${li}|${p.id}|${qi}`));
  return keys;
}

async function startStage(lang) {
  const sp = syncSteps(lang, true);
  const max = LANG[lang].levels.length - 1;
  if (sp.idx > max) { hooks.showToast('すべてのステップに合格しています'); return false; }
  if (!sp.stage || sp.stage.idx !== sp.idx) {
    const keys = await buildStageKeys(lang, sp.idx);
    sp.stage = { idx: sp.idx, keys, remaining: [...keys], attempts: 0, first: null, started: Date.now() };
    save();
  }
  // 出題は「語彙 → 文法 → 聴解 → 読解」のパートごと（元の並び順のまま）
  return startFixed('stage', lang, sp.stage.keys.filter((k) => sp.stage.remaining.includes(k)), { breaks: true, level: sp.idx });
}

function finishStage(lang, log) {
  const sp = st.steps[lang];
  const stg = sp?.stage;
  if (!stg) return null;
  const right = new Set(log.filter((e) => e.correct).map((e) => e.key));
  const before = stg.remaining.length;
  stg.remaining = stg.remaining.filter((k) => !right.has(k));
  stg.attempts += 1;
  if (!stg.first) stg.first = { asked: log.length, correct: right.size };
  const info = { level: stg.idx, total: stg.keys.length, before, remaining: stg.remaining.length, attempts: stg.attempts, passed: false };
  if (!stg.remaining.length && log.length) {
    if (!sp.passed.includes(stg.idx)) sp.passed.push(stg.idx);
    sp.idx = stg.idx + 1;
    sp.stage = null;
    info.passed = true;
    st.results[lang].push({ date: Date.now(), kind: 'stage', level: info.level, score: { asked: info.total, correct: info.total } });
  }
  return info;
}

function testDue(lang) {
  const full = latestFull(lang);
  if (!full) return 'first';
  if (daysSince(full.date) >= FULL_DAYS) return 'full';
  if (daysSince(latestAny(lang).date) >= CHECK_DAYS) return 'check';
  return null;
}
function nextTestInfo(lang) {
  const full = latestFull(lang);
  if (!full) return null;
  const toCheck = CHECK_DAYS - daysSince(latestAny(lang).date);
  const toFull  = FULL_DAYS - daysSince(full.date);
  return toFull <= toCheck ? { kind: 'full', days: Math.max(0, toFull) } : { kind: 'check', days: Math.max(0, toCheck) };
}

async function weakKeys(lang, B, n, used) {
  const w = st.weak[lang];
  const out = [];
  for (const k of shuffle(w.items)) {
    if (out.length >= n) break;
    if (!used.has(k) && itemFromKey(B, lang, k)) { out.push(k); used.add(k); }
  }
  return out;
}
function pointKeys(lang, B, n, used) {
  const w = st.weak[lang];
  const out = [];
  if (lang === 'vi') {
    for (const pk of shuffle(w.points)) {
      if (out.length >= n) break;
      const [li, pid] = pk.split('|');
      const p = B[Number(li)]?.pointById.get(pid);
      if (!p?.quiz?.length) continue;
      const key = `g|${li}|${pid}|${Math.floor(Math.random() * p.quiz.length)}`;
      if (!used.has(key)) { out.push(key); used.add(key); }
    }
  } else {
    for (const tag of shuffle(w.tags)) {
      if (out.length >= n) break;
      const cands = shuffle(B.flatMap((L) => (L.grammar ?? []).filter((g) => g.tag === tag).map((g) => `g|${L.idx}|${g.id}`)));
      const key = cands.find((k) => !used.has(k));
      if (key) { out.push(key); used.add(key); }
    }
  }
  return out;
}
function levelKeys(lang, B, t, n, used, skills) {
  const out = [];
  for (let i = 0; out.length < n && i < n * 4; i++) {
    const skill = skills[i % skills.length];
    const key = randomKey(B, lang, skill, t[skill], used);
    if (key) { out.push(key); used.add(key); }
  }
  return out;
}

async function startDrill(lang, kind = 'drill') {
  const B = await bank(lang);
  const r = latestFull(lang);
  const t = targets(lang, r);
  const used = new Set();
  const skills = SpeechSupport.tts ? ['vocab', 'grammar', 'listening'] : ['vocab', 'grammar'];
  let keys;
  if (kind === 'grammar-drill') {
    keys = [...pointKeys(lang, B, 3, used), ...levelKeys(lang, B, t, 6, used, ['grammar'])].slice(0, 6);
  } else if (kind === 'check') {
    keys = [...await weakKeys(lang, B, 5, used), ...pointKeys(lang, B, 2, used)];
    keys.push(...levelKeys(lang, B, t, CHECK_SIZE - keys.length, used, skills));
  } else {
    const n = DRILL_SIZE[st.minutes];
    keys = [...await weakKeys(lang, B, Math.ceil(n / 2), used), ...pointKeys(lang, B, Math.ceil(n / 4), used)];
    keys.push(...levelKeys(lang, B, t, n - keys.length, used, skills));
  }
  return startFixed(kind, lang, shuffle(keys));   // 種類を混ぜて出題（交互練習）
}

// ---------- 毎日のメニュー ----------

let guideCache = null;
async function guide() {
  guideCache ??= await getJson('./data/study-guide.json');
  return guideCache ?? { schedules: {}, science: [], media: {}, watch: [] };
}

function pickViPoint(B, lang, t, day) {
  const prog = kenteiProgress().grammar;
  if (day.grammarPoint) {
    const [li, pid] = day.grammarPoint.split('|');
    if (B[Number(li)]?.pointById.has(pid)) return { li: Number(li), p: B[Number(li)].pointById.get(pid) };
  }
  // 弱点の項目 → 目標の級のまだ全問正解していない項目 → その上の級
  for (const pk of st.weak[lang].points) {
    const [li, pid] = pk.split('|');
    const p = B[Number(li)]?.pointById.get(pid);
    if (p && !prog[p.id]) { day.grammarPoint = pk; return { li: Number(li), p }; }
  }
  for (let li = t.grammar; li < B.length; li++) {
    const p = B[li].points.find((x) => !prog[x.id]);
    if (p) { day.grammarPoint = `${li}|${p.id}`; return { li, p }; }
  }
  return null;
}
function pickViPassage(B, t, day) {
  const prog = kenteiProgress().reading;
  if (day.passage) {
    const [li, pid] = day.passage.split('|');
    const p = B[Number(li)]?.passageById.get(pid);
    if (p) return { li: Number(li), p };
  }
  for (let li = t.reading; li < B.length; li++) {
    const p = B[li].passages.find((x) => prog[x.id] === undefined);
    if (p) { day.passage = `${li}|${p.id}`; day.passageFresh = true; return { li, p }; }
  }
  const li = t.reading;
  const p = [...B[li].passages].sort((a, b) => (prog[a.id] ?? 0) - (prog[b.id] ?? 0))[0];
  if (p) { day.passage = `${li}|${p.id}`; day.passageFresh = false; return { li, p }; }
  return null;
}

async function menuItems(lang) {
  const r = latestFull(lang);
  if (!r) return null;
  const g = await guide();
  const B = await bank(lang);
  banksSync[lang] = B;
  const t = targets(lang, r);
  const day = dayRec(lang);
  const blocks = g.schedules[String(st.minutes)] ?? [];
  const items = [];
  const due = testDue(lang);
  if (due === 'check' || due === 'full') {
    items.push({
      kind: 'test', when: '今日', minutes: due === 'full' ? 15 : 5,
      title: due === 'full' ? '4週ごとの実力テスト' : '週1回の確認テスト',
      desc: due === 'full' ? 'レベルを測り直して、目標の級とメニューを更新します。' : '弱点が直ったかを確かめ、弱点リストを更新します。',
      done: !!day.done.test, action: { type: due === 'full' ? 'full-test' : 'check' },
    });
  }
  const sp = syncSteps(lang);
  const stg = sp?.stage;
  if (stg?.attempts && stg.remaining.length) {
    items.push({
      kind: 'test', when: 'いつでも', minutes: Math.max(2, Math.ceil(stg.remaining.length / 2)), optional: true,
      title: `ステップ再テスト（${LANG[lang].levels[stg.idx]}）`,
      desc: `前回間違えた ${stg.remaining.length} 問だけを出題。全部正解すると合格して次のステップへ進めます。`,
      done: false, action: { type: 'stage' },
    });
  } else if (sp && sp.idx < LANG[lang].levels.length) {
    items.push({
      kind: 'test', when: 'いつでも', minutes: 10, optional: true,
      title: `ステップの段階テスト（${LANG[lang].levels[sp.idx]}）`,
      desc: '約20問。合格すると次のレベルへ進み、毎日のメニューもレベルアップします。準備ができたら挑戦してください。',
      done: false, action: { type: 'stage' },
    });
  }
  const levelOf = (sk) => LANG[lang].levels[t[sk]];
  for (const b of blocks) {
    const base = { kind: b.kind, when: b.when, minutes: b.minutes, title: b.title, science: b.science };
    if (b.kind === 'srs') {
      const deck = LANG[lang].deck(t.vocab);
      const a = await hooks.todayActivity(LANG[lang].speech, deck);
      if (day.srsDeck !== deck || day.srsTarget == null) {
        day.srsDeck = deck;
        day.srsTarget = Math.min(a.reviewDue, 40) + Math.min(NEW_WORDS[st.minutes], a.newLeft);
      }
      const target = Math.max(1, day.srsTarget);
      items.push({ ...base,
        desc: `${LANG[lang].deckLabel(t.vocab)}：復習の期限 ${a.reviewDue} 語＋新しい単語 ${NEW_WORDS[st.minutes]} 語`,
        progress: `今日 ${a.reviewedToday} / ${target} 語`,
        done: !!day.done.srs || a.reviewedToday >= target,
        action: { type: 'deck', deck, lang: LANG[lang].speech } });
    } else if (b.kind === 'drill') {
      const w = st.weak[lang];
      items.push({ ...base,
        desc: `間違えた問題 ${w.items.length} 問・苦手な項目から ${DRILL_SIZE[st.minutes]} 問（語彙・文法・聴解を混ぜて出題）`,
        done: !!day.done.drill, action: { type: 'drill' } });
    } else if (b.kind === 'grammar') {
      if (lang === 'vi') {
        const pp = pickViPoint(B, lang, t, day);
        if (!pp) continue;
        const mastered = !!kenteiProgress().grammar[pp.p.id];
        items.push({ ...base, title: '今日の文法',
          desc: `${LANG.vi.levels[pp.li]}「${pp.p.title}」— 解説と例文を読み、確認問題に全問正解したら完了`,
          done: !!day.done.grammar || mastered, action: { type: 'kentei', level: VI_N[pp.li], mode: 'grammar', point: pp.p.id } });
      } else if (t.grammar <= 1) {
        items.push({ ...base, title: '基礎文法ドリル',
          desc: `${levelOf('grammar')} の文法問題 6 問（苦手な分野を優先）`,
          done: !!day.done.grammar, action: { type: 'grammar-drill' } });
      } else {
        items.push({ ...base, title: '文法・語法問題（TOEIC Part 5）',
          desc: '短文穴埋めを5問以上。間違えた問題は解説を読み、正しい文を声に出す。',
          done: !!day.done.grammar, manual: true, action: { type: 'screen', screen: 'toeic-reading' } });
      }
    } else if (b.kind === 'reading' || (b.kind === 'listen' && lang === 'vi')) {
      if (lang === 'vi') {
        const pp = pickViPassage(B, t, day);
        if (!pp) continue;
        const tried = kenteiProgress().reading[pp.p.id] !== undefined;
        const isRead = b.kind === 'reading';
        items.push({ ...base,
          title: isRead ? '読む・聞く' : b.title,
          desc: isRead
            ? `${LANG.vi.levels[pp.li]}「${pp.p.title}」— 読む→設問に答える→🔊で聞く`
            : `「${pp.p.title}」の音声を1文ずつ聞いて、すぐ後についてまねる`,
          done: isRead ? (!!day.done.reading || (day.passageFresh && tried)) : !!day.done[b.kind],
          manual: !isRead,
          action: { type: 'kentei', level: VI_N[pp.li], mode: 'reading', passage: pp.p.id } });
      } else if (t.reading >= 2) {
        items.push({ ...base, desc: 'TOEIC Part 7 の文章を1つ読み、設問に答える。読み終えたら音読。',
          done: !!day.done.reading, manual: true, action: { type: 'screen', screen: 'toeic-reading' } });
      } else {
        items.push({ ...base, desc: '会話シナリオを1つ選び、会話文を読んで音声で聞く。',
          done: !!day.done.reading, manual: true, action: { type: 'screen', screen: 'scenarios' } });
      }
    } else if (b.kind === 'listen') {
      const toLinking = t.listening <= 2;
      items.push({ ...base,
        desc: toLinking ? 'リンキング（音のつながり）練習で、1文ずつ聞いてまねる。' : 'TOEIC リスニングを数問解き、スクリプトを見ながらまねる。',
        done: !!day.done.listen, manual: true, action: { type: 'screen', screen: toLinking ? 'linking' : 'toeic-listening' } });
    } else if (b.kind === 'output') {
      if (lang === 'vi') {
        items.push({ ...base, desc: 'AI との会話練習（ベトナム語）で、今日の単語や文法を使ってみる。',
          done: !!day.done.output, manual: true, action: { type: 'screen', screen: 'scenarios' } });
      } else {
        const ielts = t.vocab >= 3;
        items.push({ ...base,
          desc: ielts ? 'IELTS Speaking の質問に答えて、AI の採点で弱点を確認。' : '今日の単語を使って英文を3つ書き、AI に添削してもらう。',
          done: !!day.done.output, manual: true, action: { type: 'screen', screen: ielts ? 'ielts-speaking' : 'grammar' } });
      }
    } else if (b.kind === 'night') {
      items.push({ ...base, desc: `今日間違えた ${day.mistakes.length} 問をもう一度解く（寝る直前に短く）`,
        done: !!day.done.night || (!day.mistakes.length && Object.keys(day.done).length > 0),
        action: { type: 'night' } });
    }
  }
  save();
  return { items, t, r };
}

// ---------- 画面 ----------

function bodyEl() { return document.getElementById('plan-body'); }

export async function renderPlan() {
  const body = bodyEl();
  if (!body) return;
  document.querySelectorAll('#plan-lang .tab').forEach((x) => x.classList.toggle('tab-active', x.dataset.planLang === st.lang));
  document.querySelectorAll('#plan-min .chip').forEach((x) => x.classList.toggle('chip-active', Number(x.dataset.planMin) === st.minutes));
  document.querySelectorAll('#plan-tabs .tab').forEach((x) => x.classList.toggle('tab-active', x.dataset.planTab === ui.tab));
  const tabsHidden = !!ui.sess;
  document.getElementById('plan-tabs')?.classList.toggle('hidden', tabsHidden);
  document.getElementById('plan-settings')?.classList.toggle('hidden', tabsHidden);
  // テスト中は下のメニューを隠す（「次へ」と重なって押し間違えないように）
  document.body.classList.toggle('pl-testing', !!ui.sess);
  if (ui.sess) return renderSession(body);
  if (ui.lastResult) return renderResult(body);
  if (ui.tab === 'steps') return renderSteps(body);
  if (ui.tab === 'test') return renderTestTab(body);
  if (ui.tab === 'curriculum') return renderCurriculum(body);
  if (ui.tab === 'media') return renderMedia(body);
  return renderMenu(body);
}

function levelBar(lang, idx) {
  return `<div class="pl-ladder">${LANG[lang].levels.map((l, i) =>
    `<span class="pl-step ${i <= idx ? 'pl-step-on' : ''}">${esc(l)}</span>`).join('')}</div>`;
}

function levelsSummary(lang, r) {
  return SKILLS.map((sk) => {
    const e = r.levels?.[sk.id];
    if (e == null) return `<div class="pl-skill"><div class="pl-skill-name">${sk.label}</div><div class="text-xs text-sumi-soft">未測定（この端末では音声が使えません）</div></div>`;
    return `<div class="pl-skill">
      <div class="pl-skill-name">${sk.label}<span class="pl-skill-lv">${esc(levelName(lang, e))}${e >= 0 ? ' 合格' : ''}</span></div>
      ${levelBar(lang, e)}
    </div>`;
  }).join('');
}

async function renderMenu(body) {
  const lang = st.lang;
  const r = latestFull(lang);
  if (!r) {
    body.innerHTML = `
      <div class="card">
        <h3 class="card-title">まずは実力テスト（約10〜15分）</h3>
        <p class="text-sm text-sumi-light mt-3 leading-relaxed">
          ${esc(LANG[lang].label)}の「語彙・文法・聴解・読解」を、やさしい級から順に測ります。正解が続くとレベルが上がり、
          間違いが続くとそこで終わるので、問題数は人によって変わります。分からない問題は「わからない」を選んでください（当てずっぽうより正確に測れます）。
        </p>
        <p class="text-sm text-sumi-light mt-2">結果から、あなたに合った<b>毎日の学習メニュー</b>を自動で作ります。</p>
        <button class="btn-primary w-full mt-4" data-pl-tab-go="test">実力テストへ</button>
      </div>`;
    return;
  }
  body.innerHTML = '<div class="text-xs text-sumi-soft">メニューを作成中...</div>';
  const m = await menuItems(lang);
  if (!m || st.lang !== lang || ui.tab !== 'menu' || ui.sess) return;
  const req = m.items.filter((x) => !x.optional);
  const doneN = req.filter((x) => x.done).length;
  const next = nextTestInfo(lang);
  const g = await guide();
  const sciTitle = (id) => g.science.find((s) => s.id === id)?.title ?? '';
  body.innerHTML = `
    <div class="card">
      <div class="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 class="card-title">今日のメニュー（${esc(LANG[lang].label)}・${st.minutes}分）</h3>
        <span class="text-sm ${doneN === req.length ? 'text-koke' : 'text-sumi-soft'}">${doneN} / ${req.length} 完了</span>
      </div>
      <div class="pl-progress mt-2"><div class="pl-progress-fill" style="width:${Math.round(doneN / Math.max(1, req.length) * 100)}%"></div></div>
      <p class="text-xs text-sumi-soft mt-2">時間帯は目安です。一度にまとめるより、1日の中で分けて行うほうが記憶に残ります。</p>
    </div>
    <ul class="pl-menu mt-4">
      ${m.items.map((it, i) => `
        <li class="card pl-item ${it.done ? 'pl-done' : ''} ${it.optional ? 'pl-optional' : ''}">
          <div class="pl-item-head">
            <span class="pl-icon">${KIND_ICON[it.kind] ?? '・'}</span>
            <div class="pl-item-main">
              <div class="pl-item-meta">${esc(it.when)}・約${it.minutes}分${it.optional ? '・<span class="pl-opt-tag">ステップ</span>' : ''}</div>
              <div class="pl-item-title">${esc(it.title)}${it.done ? '<span class="pl-check">✓ 完了</span>' : ''}</div>
              <div class="pl-item-desc">${esc(it.desc)}</div>
              ${it.progress ? `<div class="pl-item-prog">${esc(it.progress)}</div>` : ''}
              ${it.science?.length ? `<div class="pl-sci">${it.science.map((s) => `<span>${esc(sciTitle(s).replace(/（.*）/, ''))}</span>`).join('')}</div>` : ''}
            </div>
          </div>
          <div class="pl-item-actions">
            <button class="btn-primary text-sm" data-pl-act="${i}">${it.done ? 'もう一度' : 'はじめる'}</button>
            ${it.manual ? `<label class="pl-manual"><input type="checkbox" data-pl-manual="${esc(it.kind)}" ${it.done ? 'checked' : ''}> できた</label>` : ''}
          </div>
        </li>`).join('')}
    </ul>
    <div class="card mt-4">
      <h3 class="card-title">いまのレベル（${fmtDate(r.date)} の実力テスト）</h3>
      <div class="mt-3 space-y-3">${levelsSummary(lang, r)}</div>
      ${lang === 'en' ? `<p class="text-xs text-sumi-soft mt-3">CEFR と TOEIC L&R の対応（ETS 公表の目安）：${EN_LEVELS.map((l, i) => `${l} ${LANG.en.hint[i]}`).join('／')}</p>` : ''}
      ${next ? `<p class="text-sm mt-3">次の${next.kind === 'full' ? '実力テスト' : '確認テスト'}：${next.days === 0 ? '<b class="text-shu">今日</b>' : `あと ${next.days} 日`}</p>` : ''}
      ${weakSummary(lang)}
    </div>`;
  menuCache = m.items;
}
let menuCache = [];

function weakSummary(lang) {
  const w = st.weak[lang];
  const parts = [];
  if (lang === 'vi' && w.points.length) {
    parts.push(`<div class="mt-2 text-sm"><b>苦手な文法：</b>${w.points.map((pk) => {
      const [li, pid] = pk.split('|');
      const p = banksSync.vi?.[Number(li)]?.pointById.get(pid);
      return p ? `${esc(LANG.vi.levels[Number(li)])}「${esc(p.title)}」` : '';
    }).filter(Boolean).join('、')}</div>`);
  }
  if (lang === 'en' && w.tags.length) parts.push(`<div class="mt-2 text-sm"><b>苦手な文法：</b>${w.tags.map((t) => esc(EN_TAGS[t] ?? t)).join('、')}</div>`);
  parts.push(`<div class="mt-1 text-xs text-sumi-soft">復習待ちの間違えた問題：${w.items.length} 問（毎日のドリルで出題）</div>`);
  return `<div class="mt-3">${parts.join('')}</div>`;
}
const banksSync = {};   // 弱点表示用（読み込み済みのものだけ）

async function renderTestTab(body) {
  const lang = st.lang;
  const hist = st.results[lang];
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">実力テスト（${esc(LANG[lang].label)}）</h3>
      <p class="text-sm text-sumi-light mt-3 leading-relaxed">語彙 → 文法 → 聴解 → 読解の順に、やさしいレベルから出題します。約10〜15分。
        正解が続くと上のレベルへ、間違いが続くとそこで終わります。4週ごとに受けると伸びが分かります。</p>
      ${validPartial(lang) ? `
        <div class="pl-advice mt-3">途中まで受けたテストがあります（${fmtDate(validPartial(lang).date)}・終わったパート：${Object.keys(validPartial(lang).est).map((k) => esc(skillLabel(k))).join('・')}）。
          <button class="btn-primary w-full mt-2" data-pl-resume="1">続きから受ける</button></div>` : ''}
      <div class="text-sm mt-4 mb-2">${validPartial(lang) ? '最初から受け直す場合は、' : ''}今の自分に近いものを選んでください（出題を始めるレベルの目安です）</div>
      <div class="pl-start">${LANG[lang].start.map((s) => `<button class="btn-secondary text-sm" data-pl-full="${s.idx}">${esc(s.label)}</button>`).join('')}</div>
      ${SpeechSupport.tts ? '' : '<p class="text-xs text-shu mt-3">この端末では音声が使えないため、聴解は省略されます。</p>'}
    </div>
    <div class="card mt-4">
      <h3 class="card-title">確認テスト（約5分・12問）</h3>
      <p class="text-sm text-sumi-light mt-3">前回までに間違えた問題と、今の目標レベルから出題します。週1回が目安です。</p>
      <button class="btn-primary w-full mt-4" data-pl-check="1" ${latestFull(lang) ? '' : 'disabled'}>確認テストを受ける</button>
      ${latestFull(lang) ? '' : '<p class="text-xs text-sumi-soft mt-2">先に実力テストを受けてください。</p>'}
    </div>
    <div class="card mt-4">
      <h3 class="card-title">これまでの記録</h3>
      ${hist.length ? `<div class="pl-hist mt-3">${[...hist].reverse().map((r) => `
        <div class="pl-hist-row">
          <span class="pl-hist-date">${fmtDate(r.date)}</span>
          <span class="pl-hist-kind">${r.kind === 'full' ? '実力' : r.kind === 'stage' ? '段階' : '確認'}</span>
          <span class="pl-hist-body">${r.kind === 'stage' ? `${esc(LANG[lang].levels[r.level])} のステップに合格`
            : r.kind === 'full'
            ? SKILLS.map((sk) => r.levels[sk.id] == null ? '' : `${sk.label} ${esc(levelName(lang, r.levels[sk.id]))}`).filter(Boolean).join('・')
            : `${r.score.correct} / ${r.score.asked} 問正解（${Math.round(r.score.correct / Math.max(1, r.score.asked) * 100)}%）`}</span>
        </div>`).join('')}</div>` : '<p class="text-sm text-sumi-soft mt-3">まだ記録がありません。</p>'}
    </div>`;
}

const SESSION_TITLE = { full: '実力テスト', check: '確認テスト', drill: '弱点ドリル', 'grammar-drill': '基礎文法ドリル',
                        night: '今日の間違いの見直し', stage: 'ステップの段階テスト' };

// 語彙・文法・聴解・読解のどこまで進んだか
function partsBar(s, current) {
  if (s.kind !== 'full' && !s.breaks) return '';
  const done = (sk) => (s.kind === 'full' ? sk in s.est : s.log.some((e) => e.skill === sk) && sk !== current);
  return `<ol class="pl-parts">${s.allSkills.map((sk, i) => {
    const cls = sk === current ? 'pl-part-now' : done(sk) ? 'pl-part-done' : '';
    return `<li class="${cls}"><span>${done(sk) && sk !== current ? '✓' : i + 1}</span>${esc(skillLabel(sk))}</li>`;
  }).join('')}</ol>`;
}

function renderBreak(body, s) {
  const { done, next } = s.inBreak;
  const part = s.log.filter((e) => e.skill === done);
  const ok = part.filter((e) => e.correct).length;
  const est = s.kind === 'full' ? s.est[done] : null;
  const remainParts = s.allSkills.length - s.allSkills.indexOf(next);
  body.innerHTML = `
    <div class="card pl-session">
      <div class="pl-sess-title">${esc(SESSION_TITLE[s.kind])}${s.kind === 'stage' ? `（${esc(LANG[s.lang].levels[s.level])}）` : ''}</div>
      ${partsBar(s, next)}
      <div class="pl-break">
        <div class="pl-break-mark">✓</div>
        <div class="pl-break-title">「${esc(skillLabel(done))}」のパートおわり</div>
        <div class="text-sm mt-1">${ok} / ${part.length} 問正解${est != null ? `・推定レベル <b>${esc(levelName(s.lang, est))}${est >= 0 ? ' 合格' : ''}</b>` : ''}</div>
        <p class="text-xs text-sumi-soft mt-2">${s.kind === 'full' ? 'ここまでの結果は保存しました。' : '正解した問題は合格済みとして記録します。'}
          次は「${esc(skillLabel(next))}」です（残り ${remainParts} パート）。</p>
      </div>
      <button class="btn-primary w-full mt-4" data-pl-cont="1">「${esc(skillLabel(next))}」へ進む</button>
      <button class="btn-secondary w-full mt-2" data-pl-stop="1">ここで終える（続きは後で）</button>
    </div>`;
}

function renderSession(body) {
  const s = ui.sess;
  if (s.inBreak) { renderBreak(body, s); return; }
  const it = s.item;
  if (!it) { body.innerHTML = ''; return; }
  const title = SESSION_TITLE[s.kind] + (s.kind === 'stage' ? `（${LANG[s.lang].levels[s.level]}）` : '');
  const count = s.fixed ? `${s.total - s.fixed.length} / ${s.total}` : `${s.log.length + (s.picked === null ? 1 : 0)} 問目`;
  const answered = s.picked !== null;
  const prompt = it.skill === 'listening'
    ? `<div class="pl-q-label">音声を聞いて、意味に合うものを選んでください</div>
       <div class="pl-audio">
         <button class="audio-btn" data-pl-say="1">🔊 もう一度</button>
         <button class="audio-btn" data-pl-say="0.6">🐢 ゆっくり</button>
       </div>
       ${answered ? `<div class="pl-q pl-q-vi mt-2">${esc(it.say)}</div>` : ''}`
    : it.skill === 'vocab'
      ? `<div class="pl-q-label">意味を選んでください</div>
         <div class="pl-q pl-q-vi">${esc(it.prompt)} ${SpeechSupport.tts ? '<button class="audio-btn audio-btn-sm" data-pl-say="1">🔊</button>' : ''}</div>
         ${answered && it.reading ? `<div class="text-xs text-sumi-soft">${esc(it.reading)}</div>` : ''}`
      : `${it.passage ? `<details class="pl-passage" ${answered ? '' : 'open'}><summary>${esc(it.passage.title || '本文')}</summary>
           <div class="pl-passage-text">${it.passage.text.split(/\n+/).map((p) => `<p>${esc(p)}</p>`).join('')}</div></details>` : ''}
         <div class="pl-q-label">${it.skill === 'grammar' ? '空欄に入るものを選んでください' : '答えを選んでください'}</div>
         <div class="pl-q pl-q-vi">${esc(it.prompt)}</div>
         ${it.sub ? `<details class="vk-qja-d"><summary>設問の訳</summary>${esc(it.sub)}</details>` : ''}`;
  body.innerHTML = `
    <div class="card pl-session">
      <div class="flex items-center justify-between gap-2">
        <div><span class="pl-sess-title">${esc(title)}</span>
          <span class="pl-sess-skill">${esc(skillLabel(it.skill))}・${esc(LANG[s.lang].levels[it.level] ?? '')}</span></div>
        <span class="text-xs text-sumi-soft">${count}</span>
      </div>
      ${partsBar(s, it.skill)}
      <div class="mt-3">${prompt}</div>
      <div class="pl-choices mt-3">
        ${it.choices.map((c, ci) => {
          const cls = !answered ? '' : ci === it.answer ? 'vk-correct' : ci === s.picked ? 'vk-wrong' : '';
          return `<button class="pl-choice ${cls}" data-pl-ans="${ci}" ${answered ? 'disabled' : ''}>${esc(c)}</button>`;
        }).join('')}
        ${answered ? '' : '<button class="pl-choice pl-dontknow" data-pl-ans="-1">わからない</button>'}
      </div>
      ${answered ? `
        <div class="vk-feedback mt-3">${s.picked === it.answer ? '<b class="text-koke">◎ 正解</b>' : `<b class="text-shu">✕ 正解は「${esc(it.choices[it.answer])}」</b>`}
          ${it.explain ? `<div class="mt-1">${esc(it.explain)}</div>` : ''}
          ${it.point ? `<div class="mt-1 text-xs text-sumi-soft">文法項目：${esc(LANG.vi.levels[it.point.level])}「${esc(it.point.title)}」</div>` : ''}
        </div>
        <button class="btn-primary w-full mt-4" data-pl-next="1">次へ</button>` : ''}
      <button class="btn-secondary text-xs mt-4" data-pl-quit="1">${s.kind === 'full' ? '中断する（終わったパートは保存）' : '中断する'}</button>
    </div>`;
  if (!answered && it.autoSay && SpeechSupport.tts) speak(it.say, LANG[s.lang].speech, { rate: 0.85 });
}

function renderResult(body) {
  const { kind, lang, score, result, missed, stage, est } = ui.lastResult;
  const pct = Math.round(score.correct / Math.max(1, score.asked) * 100);
  if (kind === 'partial') {
    const done = SKILLS.filter((sk) => sk.id in (est ?? {}));
    body.innerHTML = `
      <div class="card">
        <h3 class="card-title">実力テスト（途中まで保存しました）</h3>
        <div class="mt-3 space-y-1 text-sm">${done.map((sk) => `<div>✓ ${esc(sk.label)}：${esc(levelName(lang, est[sk.id]))}${est[sk.id] >= 0 ? ' 合格' : ''}</div>`).join('') || '<div>まだ終わったパートはありません</div>'}</div>
        <p class="text-sm text-sumi-light mt-3">続きは「実力テスト」タブの<b>「続きから受ける」</b>で、残りのパートから再開できます（${PARTIAL_DAYS}日以内）。</p>
        <button class="btn-primary w-full mt-4" data-pl-done="1">メニューへ</button>
      </div>`;
    return;
  }
  if (kind === 'stage' && stage) {
    const lv = LANG[lang].levels[stage.level];
    const nextLv = LANG[lang].levels[stage.level + 1];
    body.innerHTML = `
      <div class="card">
        <h3 class="card-title">ステップ ${esc(lv)} の段階テスト</h3>
        ${stage.passed ? `
          <div class="pl-pass mt-3">
            <div class="pl-pass-mark">合格</div>
            <div class="mt-1">${esc(lv)}のステップをクリアしました！</div>
            ${nextLv ? `<div class="text-sm mt-1">次は <b>${esc(nextLv)}</b> のステップです。毎日のメニューも ${esc(nextLv)} に切り替わります。</div>` : '<div class="text-sm mt-1">すべてのステップをクリアしました。</div>'}
          </div>` : `
          <p class="text-sm mt-3">今回：${score.correct} / ${score.asked} 問正解</p>
          <div class="pl-advice mt-3">
            残り <b>${stage.remaining} 問</b>（全 ${stage.total} 問中）。<br>
            間違えた問題だけが再テストに残ります。すべて正解するとステップ合格です。
          </div>
          <p class="text-xs text-sumi-soft mt-2">間違えた問題の文法・単語を見直してから再テストすると効果的です。</p>`}
        ${stage.passed || !stage.remaining ? '' : '<button class="btn-primary w-full mt-4" data-pl-stage="1">続けて再テストする</button>'}
        <button class="${stage.passed ? 'btn-primary' : 'btn-secondary'} w-full mt-2" data-pl-done="1" data-pl-to="steps">ステップ一覧へ</button>
      </div>`;
    return;
  }
  let main = '';
  if (kind === 'full' && result) {
    const t = targets(lang, result);
    const measured = SKILLS.filter((sk) => result.levels[sk.id] != null);
    const lows = measured.map((sk) => result.levels[sk.id]);
    // 他より低い技能があるときだけ「伸びしろ」として挙げる
    const weakest = Math.min(...lows) < Math.max(...lows)
      ? measured.sort((a, b) => result.levels[a.id] - result.levels[b.id])[0] : null;
    main = `
      <div class="mt-3 space-y-3">${levelsSummary(lang, result)}</div>
      <div class="pl-advice mt-4">
        <div>次に取り組むレベル：<b>単語 ${esc(LANG[lang].levels[t.vocab])}</b>・<b>文法 ${esc(LANG[lang].levels[t.grammar])}</b>・<b>読解 ${esc(LANG[lang].levels[t.reading])}</b></div>
        ${weakest ? `<div class="mt-1">いちばん伸びしろがあるのは <b>${esc(weakest.label)}</b> です。毎日のメニューで重点的に練習します。</div>`
                  : '<div class="mt-1">4つの技能のバランスが取れています。間違えた問題を中心に、次のレベルへ進みましょう。</div>'}
      </div>`;
  } else {
    const prev = st.results[lang].filter((r) => r.kind === kind).slice(-2, -1)[0];
    main = `<p class="text-sm mt-3">${score.correct} / ${score.asked} 問正解（${pct}%）
      ${prev && kind === 'check' ? `・前回 ${Math.round(prev.score.correct / Math.max(1, prev.score.asked) * 100)}%` : ''}</p>`;
    if (kind === 'check') {
      const lastTwo = st.results[lang].filter((r) => r.kind === 'check').slice(-2);
      if (lastTwo.length === 2 && lastTwo.every((r) => r.score.correct / Math.max(1, r.score.asked) >= 0.85)) {
        main += '<p class="pl-advice mt-3">2回続けて85%以上です。レベルが上がっている可能性があるので、実力テストを受け直してみましょう。</p>';
      }
    }
  }
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">${kind === 'full' ? '実力テストの結果' : kind === 'check' ? '確認テストの結果' : 'おつかれさまでした'}</h3>
      ${kind === 'full' ? `<p class="text-sm text-sumi-soft mt-2">${score.asked} 問中 ${score.correct} 問正解</p>` : ''}
      ${main}
      ${missed.length ? `<p class="text-sm mt-4">間違えた ${missed.length} 問は「弱点」として記録し、明日からのドリルで出題します。</p>` : '<p class="text-sm mt-4 text-koke">全問正解です！</p>'}
      ${kind === 'full' ? stepAfterFull(lang) : ''}
      <button class="btn-primary w-full mt-4" data-pl-done="1">今日のメニューへ</button>
    </div>`;
}

function stepAfterFull(lang) {
  const sp = st.steps[lang];
  if (!sp) return '';
  const max = LANG[lang].levels.length - 1;
  return sp.idx > max
    ? '<p class="text-sm mt-3">ステップはすべて合格扱いです。</p>'
    : `<p class="text-sm mt-3">ステップは <b>${esc(LANG[lang].levels[sp.idx])}</b> から始まります（それより下は合格扱い）。「ステップ」タブの段階テストに合格すると、次のレベルへ進めます。</p>`;
}

// ---------- ステップ一覧 ----------

function renderSteps(body) {
  const lang = st.lang;
  const sp = syncSteps(lang);
  const levels = LANG[lang].levels;
  if (!sp) {
    body.innerHTML = `
      <div class="card">
        <h3 class="card-title">ステップ（段階テスト）</h3>
        <p class="text-sm text-sumi-light mt-3 leading-relaxed">レベルごとの段階テスト（約20問）に合格すると、次のステップへ進めます。
          間違えた問題だけが再テストに残り、すべて正解すると合格です。</p>
        <p class="text-sm text-sumi-light mt-2">まず実力テストを受けると、今のレベルより下のステップは合格扱いになり、ちょうどよい所から始められます。</p>
        <button class="btn-primary w-full mt-4" data-pl-tab-go="test">実力テストを受ける</button>
        <button class="btn-secondary w-full mt-2" data-pl-stage-init="1">${esc(levels[0])}から順番に始める</button>
      </div>`;
    return;
  }
  const stg = sp.stage;
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">ステップ（${esc(LANG[lang].label)}）</h3>
      <p class="text-xs text-sumi-soft mt-2 leading-relaxed">各ステップの段階テスト（語彙・文法・聴解・読解 約20問）に全問正解すると合格です。
        間違えた問題だけが再テストに残ります。合格すると、毎日のメニューも次のレベルに切り替わります。</p>
      <ol class="pl-steplist mt-4">
        ${levels.map((lv, i) => {
          const placed = i < sp.placed && !sp.passed.includes(i);
          const passed = sp.passed.includes(i) || placed;
          const now = i === sp.idx;
          const status = passed ? (placed ? '実力テストで合格扱い' : '段階テスト合格')
            : now ? (stg?.attempts ? `挑戦中：残り ${stg.remaining.length} / ${stg.keys.length} 問（${stg.attempts}回目まで受験）` : '挑戦中：まだ受けていません')
            : 'ロック中（前のステップに合格すると挑戦できます）';
          return `
            <li class="pl-step-row ${passed ? 'is-passed' : now ? 'is-now' : 'is-locked'}">
              <span class="pl-step-badge">${passed ? '✓' : now ? '▶' : '🔒'}</span>
              <div class="pl-step-main">
                <div class="pl-item-title">${esc(lv)}</div>
                <div class="pl-item-desc">${esc(status)}</div>
                ${now ? `<button class="btn-primary text-sm mt-2" data-pl-stage="1">${stg?.attempts ? `再テスト（${stg.remaining.length}問）` : '段階テストを受ける'}</button>` : ''}
              </div>
            </li>`;
        }).join('')}
      </ol>
      ${sp.idx > levels.length - 1 ? '<p class="pl-pass mt-4">すべてのステップに合格しました！</p>' : ''}
    </div>`;
}

async function renderCurriculum(body) {
  const g = await guide();
  if (ui.tab !== 'curriculum') return;
  const blocks = g.schedules[String(st.minutes)] ?? [];
  const sci = new Map(g.science.map((s) => [s.id, s]));
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">1日のカリキュラム（${st.minutes}分）</h3>
      <p class="text-sm text-sumi-light mt-3 leading-relaxed">学習の研究で効果が確かめられている方法を組み合わせた、1日の時間割です。
        「今日のメニュー」はこの時間割に、あなたのレベルと弱点を当てはめて作られます。上の 15分／30分／60分 で切り替えられます。</p>
      <ol class="pl-timeline mt-4">
        ${blocks.map((b) => `
          <li class="pl-tl">
            <div class="pl-tl-when">${esc(b.when)}<span>${b.minutes}分</span></div>
            <div class="pl-tl-body">
              <div class="pl-item-title">${esc(b.title)}</div>
              <div class="pl-item-desc">${esc(b.what)}</div>
              <div class="pl-sci">${b.science.map((id) => `<span>${esc(sci.get(id)?.title ?? id)}</span>`).join('')}</div>
            </div>
          </li>`).join('')}
      </ol>
      <p class="text-xs text-sumi-soft mt-3">週1回の確認テスト（約5分）と、4週ごとの実力テスト（約15分）で、弱点と目標を更新します。休日は「映画・ドラマ」タブの作品を楽しむ時間にするのもおすすめです。</p>
    </div>
    <div class="card mt-4">
      <h3 class="card-title">なぜこの順番・時間なのか</h3>
      <div class="mt-3 space-y-2">
        ${g.science.map((s) => `
          <details class="pl-sci-d">
            <summary>${esc(s.title)}</summary>
            <p>${esc(s.body)}</p>
            <p class="pl-ref">参考：${esc(s.ref)}</p>
          </details>`).join('')}
      </div>
    </div>`;
}

async function renderMedia(body) {
  const g = await guide();
  if (ui.tab !== 'media') return;
  const lang = st.lang;
  const list = g.media[lang] ?? [];
  const r = latestFull(lang);
  const myLevel = r ? LANG[lang].levels[targets(lang, r).listening] : null;
  body.innerHTML = `
    <div class="card">
      <h3 class="card-title">おすすめの映画・ドラマ（${esc(LANG[lang].label)}）</h3>
      <p class="text-sm text-sumi-light mt-3">毎日のメニューに加える「楽しむためのインプット」です（必須ではありません）。
        ${myLevel ? `今の聴解の目標レベルは <b>${esc(myLevel)}</b> です。` : '実力テストを受けると、レベルに合う作品が分かりやすくなります。'}</p>
      <ul class="pl-media mt-4">
        ${list.map((m) => `
          <li class="pl-media-item">
            <div class="pl-media-head">
              <span class="pl-item-title">${esc(m.title)}</span>
              <span class="pl-media-lv">${esc(m.level)}</span>
            </div>
            <div class="text-xs text-sumi-soft">${[m.en, m.year, m.kind].filter(Boolean).map(esc).join('・')}</div>
            <div class="pl-item-desc mt-1">${esc(m.note)}</div>
          </li>`).join('')}
      </ul>
      <p class="text-xs text-sumi-soft mt-3">${esc(g.mediaNote ?? '')}</p>
    </div>
    <div class="card mt-4">
      <h3 class="card-title">効果的な見方</h3>
      <ol class="pl-steps mt-3">${(g.watch ?? []).map((w) => `<li>${esc(w)}</li>`).join('')}</ol>
    </div>`;
}

// ---------- ホームのカード ----------

export async function refreshHomePlan() {
  const el = document.getElementById('home-plan');
  if (!el) return;
  mergeRemotePlan(hooks.remoteState());
  const lang = st.lang;
  const r = latestFull(lang);
  if (!r) {
    el.innerHTML = `
      <div class="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 class="card-title">学習プラン</h3><span class="text-xs text-sumi-soft">${esc(LANG[lang].label)}</span>
      </div>
      <p class="text-sm text-sumi-light mt-3">実力テスト（約10〜15分）で今のレベルと弱点を測ると、毎日の学習メニューを自動で作ります。</p>
      <button class="btn-primary w-full mt-4" data-plan-open="test">実力テストを受ける</button>`;
    return;
  }
  try {
    const m = await menuItems(lang);
    const req = m.items.filter((x) => !x.optional);
    const doneN = req.filter((x) => x.done).length;
    const nextItemTodo = req.find((x) => !x.done);
    const due = testDue(lang);
    el.innerHTML = `
      <div class="flex items-baseline justify-between gap-2 flex-wrap">
        <h3 class="card-title">今日の学習メニュー</h3>
        <span class="text-xs text-sumi-soft">${esc(LANG[lang].label)}・${st.minutes}分</span>
      </div>
      <div class="pl-progress mt-3"><div class="pl-progress-fill" style="width:${Math.round(doneN / Math.max(1, req.length) * 100)}%"></div></div>
      <p class="text-sm mt-2">${doneN} / ${req.length} 完了${nextItemTodo ? `・次は「${esc(nextItemTodo.title)}」` : '・今日のメニューはすべて完了です！'}</p>
      ${stepLine(lang)}
      ${due === 'check' || due === 'full' ? `<p class="text-sm text-shu mt-1">今日は${due === 'full' ? '4週ごとの実力テスト' : '週1回の確認テスト'}の日です。</p>` : ''}
      <button class="btn-primary w-full mt-4" data-plan-open="menu">メニューを開く</button>`;
  } catch (err) {
    console.warn('home plan failed:', err);
  }
}

function stepLine(lang) {
  const sp = st.steps[lang];
  if (!sp) return '';
  const lv = LANG[lang].levels[sp.idx];
  if (!lv) return '<p class="text-xs text-koke mt-1">ステップ：すべて合格</p>';
  const stg = sp.stage;
  return `<p class="text-xs text-sumi-soft mt-1">ステップ：<b>${esc(lv)}</b>${stg?.attempts ? `（再テスト 残り ${stg.remaining.length} 問）` : '（段階テスト未受験）'}</p>`;
}

// ---------- 操作 ----------

async function runAction(it) {
  const a = it.action;
  if (a.type === 'deck') hooks.openDeck(a.deck, a.lang);
  else if (a.type === 'kentei') hooks.openKentei({ level: a.level, mode: a.mode, point: a.point, passage: a.passage });
  else if (a.type === 'screen') hooks.showScreen(a.screen);
  else if (a.type === 'drill') await startDrill(st.lang, 'drill');
  else if (a.type === 'grammar-drill') await startDrill(st.lang, 'grammar-drill');
  else if (a.type === 'check') await startDrill(st.lang, 'check');
  else if (a.type === 'stage') await startStage(st.lang);
  else if (a.type === 'full-test') { ui.tab = 'test'; renderPlan(); }
  else if (a.type === 'night') {
    const ok = await startFixed('night', st.lang, [...dayRec(st.lang).mistakes].slice(-10));
    if (!ok) { dayRec(st.lang).done.night = true; save(); renderPlan(); }
  }
}

export async function activatePlanScreen(opts = {}) {
  mergeRemotePlan(hooks.remoteState());
  if (opts.tab) { ui.tab = opts.tab; ui.lastResult = null; }
  // 弱点の文法名を表示するため、読み込み済みのデータを同期で参照できるようにする
  bank(st.lang).then((B) => { banksSync[st.lang] = B; }).catch(() => {});
  await renderPlan();
}
export function leavePlanScreen() { stopSpeaking(); document.body.classList.remove('pl-testing'); }

export function initStudyPlan(h = {}) {
  Object.assign(hooks, h);
  mergeRemotePlan(hooks.remoteState());

  document.getElementById('plan-lang')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-lang]');
    if (!b || ui.sess) return;
    st.lang = b.dataset.planLang; ui.lastResult = null; save();
    bank(st.lang).then((B) => { banksSync[st.lang] = B; }).catch(() => {});
    renderPlan(); refreshHomePlan();
  });
  document.getElementById('plan-min')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-min]');
    if (!b || ui.sess) return;
    st.minutes = Number(b.dataset.planMin);
    // 目標語数は時間に合わせて作り直す
    const day = dayRec(st.lang); delete day.srsTarget;
    save(); renderPlan(); refreshHomePlan();
  });
  document.getElementById('plan-tabs')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-tab]');
    if (!b) return;
    ui.tab = b.dataset.planTab; ui.lastResult = null; renderPlan();
  });
  document.getElementById('home-plan')?.addEventListener('click', (e) => {
    const b = e.target.closest('[data-plan-open]');
    if (b) hooks.showScreen('plan', { tab: b.dataset.planOpen });
  });

  bodyEl()?.addEventListener('change', (e) => {
    const m = e.target.closest('[data-pl-manual]');
    if (!m) return;
    const day = dayRec(st.lang);
    day.done[m.dataset.plManual] = m.checked;
    if (m.checked) hooks.markStudied();
    save(); renderPlan(); refreshHomePlan();
  });
  bodyEl()?.addEventListener('click', async (e) => {
    const t = e.target;
    if (ui.busy) return;
    const ans = t.closest('[data-pl-ans]');
    if (ans) { answer(Number(ans.dataset.plAns)); return; }
    if (t.closest('[data-pl-next]')) { stopSpeaking(); nextItem(); window.scrollTo({ top: 0 }); return; }
    const say = t.closest('[data-pl-say]');
    if (say && ui.sess?.item) { speak(ui.sess.item.say, LANG[ui.sess.lang].speech, { rate: Number(say.dataset.plSay) * 0.85 }); return; }
    if (t.closest('[data-pl-cont]')) { nextItem(); window.scrollTo({ top: 0 }); return; }
    if (t.closest('[data-pl-stop]')) {
      if (ui.sess?.kind === 'full') finishSession({ partialOnly: true }); else finishSession();
      window.scrollTo({ top: 0 });
      return;
    }
    if (t.closest('[data-pl-quit]')) {
      const sess = ui.sess;
      if (sess?.kind === 'full') {
        // 終わったパートだけ保存（今のパートの途中の回答はレベル判定に使わない）
        if (Object.keys(sess.est).length) { if (confirm('終わったパートの結果を保存して中断しますか？（続きは後で受けられます）')) finishSession({ partialOnly: true }); }
        else if (confirm('テストを中断しますか？（最初のパートが終わる前なので結果は残りません）')) { stopSpeaking(); ui.sess = null; renderPlan(); }
        return;
      }
      if (sess?.log.length && !confirm('ここまでの回答を記録して終了しますか？\n（「キャンセル」で記録せずに中断）')) {
        stopSpeaking(); ui.sess = null; renderPlan(); return;
      }
      if (sess?.log.length) finishSession(); else { ui.sess = null; renderPlan(); }
      return;
    }
    const doneBtn = t.closest('[data-pl-done]');
    if (doneBtn) { ui.lastResult = null; ui.tab = doneBtn.dataset.plTo ?? 'menu'; renderPlan(); return; }
    const go = t.closest('[data-pl-tab-go]');
    if (go) { ui.tab = go.dataset.plTabGo; renderPlan(); return; }
    const full = t.closest('[data-pl-full]');
    const check = t.closest('[data-pl-check]');
    const act = t.closest('[data-pl-act]');
    const stageBtn = t.closest('[data-pl-stage]');
    const resume = t.closest('[data-pl-resume]');
    if (t.closest('[data-pl-stage-init]')) { syncSteps(st.lang, true); save(); renderPlan(); return; }
    if (!full && !check && !act && !stageBtn && !resume) return;
    ui.busy = true;
    try {
      if (full) { bodyEl().innerHTML = '<div class="text-xs text-sumi-soft">問題を準備中...</div>'; await startFullTest(st.lang, Number(full.dataset.plFull)); }
      else if (resume) { bodyEl().innerHTML = '<div class="text-xs text-sumi-soft">問題を準備中...</div>'; await startFullTest(st.lang, 0, true); }
      else if (stageBtn) { ui.lastResult = null; bodyEl().innerHTML = '<div class="text-xs text-sumi-soft">問題を準備中...</div>'; await startStage(st.lang); }
      else if (check) await startDrill(st.lang, 'check');
      else if (act) { const it = menuCache[Number(act.dataset.plAct)]; if (it) await runAction(it); }
      window.scrollTo({ top: 0 });
    } catch (err) {
      console.error('plan action failed:', err);
      hooks.showToast('問題の読み込みに失敗しました');
    } finally {
      ui.busy = false;
    }
  });
}
