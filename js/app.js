// =====================================================================
// 言の葉 / Kotonoha — メインエントリ
// Step 1: 画面切り替え骨格
// Step 2: Firebase 認証 + Firestore ユーザードキュメント連携
// Step 3: 単語帳（IndexedDB + SM-2 SRS + Firestore 同期）  ← 現在
//   AI 連携は Step 4 で接続。
// =====================================================================

import {
  signInWithGoogle,
  signOutUser,
  onAuthChange,
  handleRedirectResult,
  ensureUserDoc,
  authErrorMessage,
} from './firebase-init.js';

import {
  loadVocabulary,
  buildQueue,
  rateWord,
  getStudyStats,
  pullSrsFromFirestore,
  clearLocalSrs,
  getDeck,
} from './vocabulary.js';

import {
  launchProvider,
  copyToClipboard,
  getProvider,
  callOllama,
  checkOllamaAvailable,
} from './ai-providers.js';

import {
  buildPrompt,
  detectLanguage,
} from './prompts.js';

import {
  loadScenarios,
  getScenariosByPhase,
  getScenarioById,
  speak,
  stopSpeaking,
  speakDialogue,
  SpeechSupport,
} from './scenarios.js';

import {
  getQuestionsByPart,
  playPart1,
  playPart2,
  playPart3,
  playPart4,
  stopAudio as stopListeningAudio,
} from './toeic-listening.js';

import { getReadingByPart } from './toeic-reading.js';

const SCREENS = ['login', 'home', 'vocabulary', 'scenarios', 'grammar', 'toeic-listening', 'toeic-reading'];
const PHASE_LABELS = { 1: '日常', 2: '中級', 3: 'ビジネス' };

const state = {
  currentScreen:   'login',
  isAuthenticated: false,
  user:            null,
  userData:        null,
  selectedAi:      'claude',
};

const vocabState = {
  lang:                'en',
  deck:                'daily',
  filter:              'all',
  queue:               [],
  index:               0,
  flipped:             false,
  loading:             false,
  pulledFromFirestore: false,
};

const scenarioState = {
  phase:        1,
  detailLang:   'en',
  selectedAi:   'claude',
  current:      null,
  playback:     null,
};

const tlState = {
  part:      1,
  questions: [],
  index:     0,
  speed:     0.9,
  answered:  false,
  correct:   0,
  total:     0,
};

const trState = {
  part:      5,
  questions: [],
  index:     0,
  answered:  false,
  correct:   0,
  total:     0,
};

// ---------- 画面切替 ----------

function showScreen(name) {
  if (!SCREENS.includes(name)) return;
  if (!state.isAuthenticated && name !== 'login') {
    showToast('まずログインしてください');
    return;
  }

  for (const s of SCREENS) {
    const el = document.getElementById(`screen-${s}`);
    if (el) el.classList.toggle('hidden', s !== name);
  }
  document.querySelectorAll('#bottom-nav .nav-item').forEach((btn) => {
    btn.classList.toggle('nav-active', btn.dataset.target === name);
  });

  state.currentScreen = name;
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (name === 'vocabulary')       activateVocabularyScreen();
  if (name === 'home')             refreshHomeStats();
  if (name === 'scenarios')        activateScenariosScreen();
  if (name === 'toeic-listening')  activateListeningScreen();
  if (name === 'toeic-reading')    activateReadingScreen();
  if (name !== 'scenarios' && name !== 'toeic-listening') stopSpeaking();
  if (name !== 'toeic-listening')  stopListeningAudio();
}

// ---------- 認証状態反映 ----------

async function handleAuthChange(user) {
  const profileBtn = document.getElementById('profile-btn');
  const bottomNav  = document.getElementById('bottom-nav');

  if (user) {
    state.user            = user;
    state.isAuthenticated = true;

    profileBtn?.classList.remove('hidden');
    bottomNav?.classList.remove('hidden');

    const displayName = user.displayName ?? '名無し';
    setText('greeting-name',   `${displayName} さん`);
    setText('profile-initial', displayName.charAt(0) || 'U');

    try {
      const data = await ensureUserDoc(user);
      state.userData = data;
      applyProgressToUI(data?.progress);
    } catch (err) {
      console.error('user doc load error:', err);
      showToast(authErrorMessage(err), 4000);
    }

    if (state.currentScreen === 'login') showScreen('home');

    // PWA ショートカット (?screen=vocabulary 等) を反映
    const params = new URLSearchParams(location.search);
    const target = params.get('screen');
    if (target && SCREENS.includes(target) && target !== 'login') {
      showScreen(target);
    }

    refreshDueCount(); // 即座にホームの「期日 N 語」を更新
  } else {
    state.user            = null;
    state.userData        = null;
    state.isAuthenticated = false;
    vocabState.pulledFromFirestore = false;
    vocabState.queue = [];
    vocabState.index = 0;

    profileBtn?.classList.add('hidden');
    bottomNav?.classList.add('hidden');

    // ローカル SRS をクリア（別アカウントとの混在防止）
    clearLocalSrs().catch(() => {});

    showScreen('login');
  }
}

function applyProgressToUI(progress) {
  if (!progress) return;
  setText('stat-streak',    progress.streak ?? 0);
  setText('stat-words',     progress.totalWordsLearned ?? 0);
  setText('stat-scenarios', `${progress.completedScenarios ?? 0}`);
  setText('stat-phase',     PHASE_LABELS[progress.currentPhase] ?? '日常');
  if (progress.currentLanguage) vocabState.lang = progress.currentLanguage;
}

async function refreshHomeStats() {
  if (!state.isAuthenticated) return;
  try {
    const stats = await getStudyStats(vocabState.lang, vocabState.deck);
    setText('stat-words', stats.mastered + stats.review);
    setText('due-count',  stats.dueCount);
  } catch (err) {
    console.warn('home stats refresh failed:', err);
  }
}

async function refreshDueCount() {
  try {
    const stats = await getStudyStats(vocabState.lang, vocabState.deck);
    setText('due-count', stats.dueCount);
  } catch {
    /* ignore */
  }
}

// ---------- 単語帳画面 ----------

async function activateVocabularyScreen() {
  if (vocabState.loading) return;
  vocabState.loading = true;
  try {
    if (!vocabState.pulledFromFirestore && state.user) {
      try {
        await pullSrsFromFirestore();
        vocabState.pulledFromFirestore = true;
      } catch (err) {
        console.warn('SRS pull failed (using local cache):', err);
      }
    }
    syncDeckUi();
    await loadVocabulary(vocabState.lang, vocabState.deck);
    await rebuildVocabQueue();
    showCurrentCard();
  } catch (err) {
    console.error('vocab screen activate failed:', err);
    showToast('単語データの読み込みに失敗しました');
  } finally {
    vocabState.loading = false;
  }
}

async function rebuildVocabQueue() {
  vocabState.queue   = await buildQueue(vocabState.lang, vocabState.filter, vocabState.deck);
  vocabState.index   = 0;
  vocabState.flipped = false;
}

// デッキ切替時に言語タブの表示・選択状態を整える
function syncDeckUi() {
  const deck = getDeck(vocabState.deck);
  const langs = deck.languages;

  // 現在の言語が deck に未対応なら deck の先頭言語に切替
  if (!langs.includes(vocabState.lang)) {
    vocabState.lang = langs[0];
  }

  // 言語タブ：単一言語デッキでは非表示、複数言語デッキでは表示
  const langTabs = document.getElementById('vocab-lang-tabs');
  if (langTabs) {
    langTabs.classList.toggle('hidden', langs.length <= 1);
    langTabs.querySelectorAll('.tab').forEach((t) => {
      t.classList.toggle('tab-active', t.dataset.lang === vocabState.lang);
    });
  }

  // デッキチップの選択状態
  document.querySelectorAll('#vocab-deck-row .chip').forEach((c) => {
    c.classList.toggle('chip-active', c.dataset.deck === vocabState.deck);
  });
}

function showCurrentCard() {
  const total       = vocabState.queue.length;
  const remaining   = Math.max(0, total - vocabState.index);
  const cardArea    = document.getElementById('flashcard-area');
  const counter     = document.getElementById('vocab-counter');
  const empty       = document.getElementById('vocab-empty');
  const flashcardEl = document.querySelector('.flashcard');

  setText('vocab-remaining', remaining);

  if (total === 0 || vocabState.index >= total) {
    cardArea?.classList.add('hidden');
    counter?.classList.add('hidden');
    empty?.classList.remove('hidden');
    populateEmptyStats();
    return;
  }

  cardArea?.classList.remove('hidden');
  counter?.classList.remove('hidden');
  empty?.classList.add('hidden');

  const word = vocabState.queue[vocabState.index];
  setText('card-word',       word.word ?? '—');
  setText('card-reading',    word.reading ?? '');
  setText('card-meaning',    word.meaning ?? '');
  setText('card-example',    word.example ?? '');
  setText('card-example-tr', word.exampleTranslation ?? '');

  flashcardEl?.classList.remove('flipped');
  vocabState.flipped = false;
}

async function populateEmptyStats() {
  try {
    const stats = await getStudyStats(vocabState.lang, vocabState.deck);
    setText(
      'vocab-stats',
      `新規 ${stats.new} ・ 学習中 ${stats.learning} ・ 復習 ${stats.review} ・ 習得 ${stats.mastered}`
    );
  } catch {
    /* ignore */
  }
}

async function onRate(quality) {
  if (vocabState.queue.length === 0 || vocabState.index >= vocabState.queue.length) return;
  if (!vocabState.flipped) {
    showToast('カードをタップして意味を確認してください');
    return;
  }

  const word = vocabState.queue[vocabState.index];
  try {
    await rateWord(word.id, quality);
  } catch (err) {
    console.error('rate failed:', err);
    showToast('評価の保存に失敗しました');
    return;
  }

  vocabState.index += 1;
  showCurrentCard();
  refreshDueCount();
}

// ---------- TOEIC リスニング画面 ----------

async function activateListeningScreen() {
  try {
    tlState.questions = await getQuestionsByPart(tlState.part);
    tlState.index    = 0;
    tlState.correct  = 0;
    tlState.total    = 0;
    tlState.answered = false;
    showListeningQuestion();
  } catch (err) {
    console.error('listening activate failed:', err);
    showToast('リスニングデータの読み込みに失敗しました');
  }
}

function showListeningQuestion() {
  const result      = document.getElementById('tl-result');
  const empty       = document.getElementById('tl-empty');
  const choices     = document.getElementById('tl-choices');
  const playerCard  = document.getElementById('tl-play-btn')?.closest('.card');
  const imageCard   = document.getElementById('tl-image-card');
  const promptCard  = document.getElementById('tl-prompt-card');
  const questionCard = document.getElementById('tl-question-card');

  result?.classList.add('hidden');
  tlState.answered = false;

  if (tlState.index >= tlState.questions.length) {
    empty?.classList.remove('hidden');
    choices?.classList.add('hidden');
    playerCard?.classList.add('hidden');
    imageCard?.classList.add('hidden');
    promptCard?.classList.add('hidden');
    questionCard?.classList.add('hidden');
    const titles = { 1: 'Part 1 完了！', 2: 'Part 2 完了！', 3: 'Part 3 完了！', 4: 'Part 4 完了！' };
    setText('tl-empty-title', titles[tlState.part] ?? '完了！');
    setText('tl-summary', `${tlState.correct} / ${tlState.total} 問正解`);
    return;
  }

  empty?.classList.add('hidden');
  choices?.classList.remove('hidden');
  playerCard?.classList.remove('hidden');

  const q = tlState.questions[tlState.index];
  setText('tl-progress', `${tlState.index + 1} / ${tlState.questions.length}`);

  const scoreTag = (q.tags ?? []).find((t) => t.startsWith('score-'));
  setText('tl-score-tag', scoreTag ? scoreTag.replace('score-', '') + '点レベル' : '');

  // Part ごとのカード切り替え
  imageCard?.classList.add('hidden');
  promptCard?.classList.add('hidden');
  questionCard?.classList.add('hidden');

  if (tlState.part === 1) {
    imageCard?.classList.remove('hidden');
    setText('tl-image-desc-ja', q.imageDescriptionJa ?? '—');
    setText('tl-image-desc-en', q.imageDescription ?? '—');
  } else if (tlState.part === 2) {
    promptCard?.classList.remove('hidden');
  } else if (tlState.part === 3) {
    questionCard?.classList.remove('hidden');
    document.getElementById('tl-talk-type-label')?.classList.add('hidden');
    setText('tl-question-text', q.q ?? '—');
    if (typeof q.subIndex === 'number' && typeof q.totalSub === 'number') {
      setText('tl-sub-progress', `この会話の設問 ${q.subIndex + 1} / ${q.totalSub}`);
    } else {
      setText('tl-sub-progress', '');
    }
  } else if (tlState.part === 4) {
    questionCard?.classList.remove('hidden');
    const typeLabel = document.getElementById('tl-talk-type-label');
    if (typeLabel) {
      typeLabel.classList.remove('hidden');
      typeLabel.textContent = q.talkTypeJa ? `タイプ: ${q.talkTypeJa}` : '';
    }
    setText('tl-question-text', q.q ?? '—');
    if (typeof q.subIndex === 'number' && typeof q.totalSub === 'number') {
      setText('tl-sub-progress', `このトークの設問 ${q.subIndex + 1} / ${q.totalSub}`);
    } else {
      setText('tl-sub-progress', '');
    }
  }

  // 選択肢ボタンの数を Part に応じて調整
  const choiceCount = q.choices.length;
  document.querySelectorAll('#tl-choices .tl-choice-btn').forEach((b) => {
    const idx = parseInt(b.dataset.tlChoice, 10);
    b.classList.remove('tl-choice-correct', 'tl-choice-incorrect');
    b.disabled = false;
    b.style.display = idx < choiceCount ? '' : 'none';
  });

  stopListeningAudio();
}

function onListeningPlay() {
  const q = tlState.questions[tlState.index];
  if (!q) return;
  if (tlState.part === 1) playPart1(q, tlState.speed);
  else if (tlState.part === 2) playPart2(q, tlState.speed);
  else if (tlState.part === 3) playPart3(q, tlState.speed);
  else if (tlState.part === 4) playPart4(q, tlState.speed);
}

async function onListeningPartChange(part) {
  if (part === tlState.part) return;
  tlState.part = part;
  document.querySelectorAll('#screen-toeic-listening .tab[data-tl-part]').forEach((t) => {
    t.classList.toggle('tab-active', parseInt(t.dataset.tlPart, 10) === part);
  });
  // 画面サブタイトル更新
  const labels = { 1: 'Part 1 — 写真描写問題', 2: 'Part 2 — 応答問題', 3: 'Part 3 — 会話問題', 4: 'Part 4 — 説明文問題' };
  const subEl = document.querySelector('#screen-toeic-listening .screen-sub');
  if (subEl) subEl.textContent = labels[part] ?? '';
  await activateListeningScreen();
}

function onListeningChoice(choiceIdx) {
  if (tlState.answered) return;
  const q = tlState.questions[tlState.index];
  if (!q) return;

  tlState.answered = true;
  tlState.total += 1;
  const isCorrect = choiceIdx === q.correct;
  if (isCorrect) tlState.correct += 1;

  // ボタンの色付け
  document.querySelectorAll('#tl-choices .tl-choice-btn').forEach((b) => {
    const idx = parseInt(b.dataset.tlChoice, 10);
    b.disabled = true;
    if (idx === q.correct) b.classList.add('tl-choice-correct');
    else if (idx === choiceIdx) b.classList.add('tl-choice-incorrect');
  });

  // 結果カード
  const result = document.getElementById('tl-result');
  result?.classList.remove('hidden');
  setText('tl-result-icon', isCorrect ? '◯' : '✗');
  setText('tl-result-text', isCorrect ? `正解です（${String.fromCharCode(65 + q.correct)}）` : `不正解 — 正解は ${String.fromCharCode(65 + q.correct)}`);

  // スクリプト
  const scriptOl = document.getElementById('tl-script');
  if (scriptOl) {
    scriptOl.innerHTML = '';
    // Part 3: 会話スクリプトを先に表示
    if (tlState.part === 3 && Array.isArray(q.conversation)) {
      q.conversation.forEach((turn) => {
        const li = document.createElement('li');
        li.className = 'mb-1';
        const speakerLabel = turn.speaker === 'M' ? '👨 M' : turn.speaker === 'W' ? '👩 W' : turn.speaker;
        li.innerHTML = `<span class="text-sumi-soft font-semibold">${escapeHtml(speakerLabel)}:</span> ${escapeHtml(turn.line)}`;
        scriptOl.appendChild(li);
      });
      const sep = document.createElement('li');
      sep.className = 'border-t border-sumi/10 my-2 pt-2';
      sep.textContent = '';
      scriptOl.appendChild(sep);
    }
    // Part 4: トーク本文を先に表示
    if (tlState.part === 4 && q.talk) {
      const talkLi = document.createElement('li');
      talkLi.className = 'mb-2 italic';
      talkLi.innerHTML = `<span class="text-sumi-soft font-semibold">📢 Talk:</span> ${escapeHtml(q.talk)}`;
      scriptOl.appendChild(talkLi);
      const sep = document.createElement('li');
      sep.className = 'border-t border-sumi/10 my-2 pt-2';
      sep.textContent = '';
      scriptOl.appendChild(sep);
    }
    // Part 2/3: 設問を表示
    if ((tlState.part === 2 || tlState.part === 3) && q.q) {
      const qLi = document.createElement('li');
      qLi.className = 'mb-2 font-semibold';
      qLi.textContent = `Q: ${q.q}`;
      scriptOl.appendChild(qLi);
    } else if (tlState.part === 2 && q.question) {
      const qLi = document.createElement('li');
      qLi.className = 'mb-2 font-semibold';
      qLi.textContent = `Q: ${q.question}`;
      scriptOl.appendChild(qLi);
    }
    q.choices.forEach((c, i) => {
      const li = document.createElement('li');
      const label = String.fromCharCode(65 + i);
      const isAns = i === q.correct;
      li.innerHTML = `<span class="${isAns ? 'text-koke font-semibold' : 'text-sumi-soft'}">(${label})</span> ${escapeHtml(c)}`;
      scriptOl.appendChild(li);
    });
  }

  setText('tl-explanation', q.explanation ?? '');
  stopListeningAudio();
}

function onListeningNext() {
  tlState.index += 1;
  showListeningQuestion();
}

function onListeningRestart() {
  tlState.index    = 0;
  tlState.correct  = 0;
  tlState.total    = 0;
  tlState.answered = false;
  showListeningQuestion();
}

function onListeningSpeedChange(speed) {
  tlState.speed = speed;
  document.querySelectorAll('#screen-toeic-listening .chip[data-tl-speed]').forEach((c) => {
    c.classList.toggle('chip-active', parseFloat(c.dataset.tlSpeed) === speed);
  });
}

// ---------- TOEIC リーディング画面 ----------

async function activateReadingScreen() {
  try {
    trState.questions = await getReadingByPart(trState.part);
    trState.index    = 0;
    trState.correct  = 0;
    trState.total    = 0;
    trState.answered = false;
    showReadingQuestion();
  } catch (err) {
    console.error('reading activate failed:', err);
    showToast('リーディングデータの読み込みに失敗しました');
  }
}

function showReadingQuestion() {
  const result       = document.getElementById('tr-result');
  const empty        = document.getElementById('tr-empty');
  const choices      = document.getElementById('tr-choices');
  const sentenceCard = document.getElementById('tr-sentence-card');
  const passageCard  = document.getElementById('tr-passage-card');

  result?.classList.add('hidden');
  trState.answered = false;

  if (trState.index >= trState.questions.length) {
    empty?.classList.remove('hidden');
    choices?.classList.add('hidden');
    sentenceCard?.classList.add('hidden');
    passageCard?.classList.add('hidden');
    const titles = { 5: 'Part 5 完了！', 6: 'Part 6 完了！', 7: 'Part 7 完了！' };
    setText('tr-empty-title', titles[trState.part] ?? '完了！');
    setText('tr-summary', `${trState.correct} / ${trState.total} 問正解`);
    return;
  }

  empty?.classList.add('hidden');
  choices?.classList.remove('hidden');

  const q = trState.questions[trState.index];
  setText('tr-progress', `${trState.index + 1} / ${trState.questions.length}`);

  const scoreTag = (q.tags ?? []).find((t) => t.startsWith('score-'));
  setText('tr-score-tag', scoreTag ? scoreTag.replace('score-', '') + '点レベル' : '');

  // Part 別の表示切替
  if (trState.part === 5) {
    passageCard?.classList.add('hidden');
    sentenceCard?.classList.remove('hidden');

    const sentenceEl = document.getElementById('tr-sentence');
    if (sentenceEl) {
      const blank = q.blank ?? '___';
      const parts = (q.sentence ?? '').split(blank);
      sentenceEl.innerHTML = parts.map(escapeHtml).join('<span class="tr-blank">_____</span>');
    }
  } else if (trState.part === 6) {
    sentenceCard?.classList.add('hidden');
    passageCard?.classList.remove('hidden');

    setText('tr-passage-type', q.passageTypeJa ?? '長文');
    if (typeof q.subIndex === 'number' && typeof q.totalSub === 'number') {
      setText('tr-current-blank', `空欄 [${q.subIndex + 1}] / ${q.totalSub} を選択`);
    } else {
      setText('tr-current-blank', '');
    }

    // パッセージ内の現在の空欄を強調表示
    const passageEl = document.getElementById('tr-passage');
    if (passageEl) {
      let html = escapeHtml(q.passage ?? '');
      // [1] [2] [3] [4] のマーカーを置換
      html = html.replace(/\[(\d+)\]/g, (m, n) => {
        const idx = parseInt(n, 10) - 1;
        if (idx === q.subIndex) {
          return `<span class="tr-blank-active">[${n}]</span>`;
        }
        return `<span class="tr-blank-other">[${n}]</span>`;
      });
      passageEl.innerHTML = html;
    }
  }

  // 選択肢
  document.querySelectorAll('#tr-choices .tr-choice-btn').forEach((b) => {
    const idx = parseInt(b.dataset.trChoice, 10);
    b.classList.remove('tr-choice-correct', 'tr-choice-incorrect');
    b.disabled = false;
    b.textContent = q.choices[idx] ?? '—';
    b.style.display = idx < q.choices.length ? '' : 'none';
  });
}

function onReadingChoice(choiceIdx) {
  if (trState.answered) return;
  const q = trState.questions[trState.index];
  if (!q) return;

  trState.answered = true;
  trState.total += 1;
  const isCorrect = choiceIdx === q.correct;
  if (isCorrect) trState.correct += 1;

  document.querySelectorAll('#tr-choices .tr-choice-btn').forEach((b) => {
    const idx = parseInt(b.dataset.trChoice, 10);
    b.disabled = true;
    if (idx === q.correct) b.classList.add('tr-choice-correct');
    else if (idx === choiceIdx) b.classList.add('tr-choice-incorrect');
  });

  const result = document.getElementById('tr-result');
  result?.classList.remove('hidden');
  setText('tr-result-icon', isCorrect ? '◯' : '✗');
  setText('tr-result-text', isCorrect ? `正解（${String.fromCharCode(65 + q.correct)}）` : `不正解 — 正解は ${String.fromCharCode(65 + q.correct)}`);

  // 完成文（Part 5 = 文、Part 6 = パッセージ全体に当てはめ）
  const completedEl = document.getElementById('tr-completed');
  if (completedEl) {
    if (trState.part === 5) {
      const blank = q.blank ?? '___';
      const filled = (q.sentence ?? '').replace(blank, q.choices[q.correct]);
      completedEl.textContent = filled;
    } else if (trState.part === 6) {
      const marker = q.marker ?? `[${(q.subIndex ?? 0) + 1}]`;
      const filled = (q.passage ?? '').replace(marker, `「${q.choices[q.correct]}」`);
      completedEl.textContent = filled;
    } else {
      completedEl.textContent = q.choices[q.correct] ?? '';
    }
  }

  // 全選択肢
  const optionsList = document.getElementById('tr-options-list');
  if (optionsList) {
    optionsList.innerHTML = '';
    q.choices.forEach((c, i) => {
      const li = document.createElement('li');
      const label = String.fromCharCode(65 + i);
      const isAns = i === q.correct;
      li.innerHTML = `<span class="${isAns ? 'text-koke font-semibold' : 'text-sumi-soft'}">(${label})</span> ${escapeHtml(c)}`;
      optionsList.appendChild(li);
    });
  }

  setText('tr-explanation', q.explanation ?? '');
}

function onReadingNext() {
  trState.index += 1;
  showReadingQuestion();
}

function onReadingRestart() {
  trState.index    = 0;
  trState.correct  = 0;
  trState.total    = 0;
  trState.answered = false;
  showReadingQuestion();
}

async function onReadingPartChange(part) {
  if (part === trState.part) return;
  trState.part = part;
  document.querySelectorAll('#screen-toeic-reading .tab[data-tr-part]').forEach((t) => {
    t.classList.toggle('tab-active', parseInt(t.dataset.trPart, 10) === part);
  });
  const labels = { 5: 'Part 5 — 短文穴埋め問題', 6: 'Part 6 — 長文穴埋め問題', 7: 'Part 7 — 読解問題' };
  const subEl = document.querySelector('#screen-toeic-reading .screen-sub');
  if (subEl) subEl.textContent = labels[part] ?? '';
  await activateReadingScreen();
}

// ---------- シナリオ画面 ----------

async function activateScenariosScreen() {
  await loadScenarios();
  await renderScenarioList(scenarioState.phase);
  showListView();
}

async function renderScenarioList(phase) {
  scenarioState.phase = phase;
  const grid  = document.getElementById('scenario-grid');
  const empty = document.getElementById('scenario-empty');
  if (!grid) return;

  const scenarios = await getScenariosByPhase(phase);

  if (scenarios.length === 0) {
    grid.innerHTML = '';
    grid.classList.add('hidden');
    empty?.classList.remove('hidden');
    return;
  }

  grid.classList.remove('hidden');
  empty?.classList.add('hidden');

  grid.innerHTML = scenarios.map((s) => `
    <button class="scenario-card" data-id="${s.id}">
      <div class="scenario-num">${String(s.order).padStart(2, '0')}</div>
      <div class="scenario-title">${escapeHtml(s.title)}</div>
      <div class="scenario-desc">${escapeHtml(s.description)}</div>
      <div class="text-[10px] text-sumi-soft mt-2 font-cormorant tracking-widest">${s.level}</div>
    </button>
  `).join('');

  grid.querySelectorAll('[data-id]').forEach((btn) => {
    btn.addEventListener('click', () => showScenarioDetail(btn.dataset.id));
  });
}

async function showScenarioDetail(id) {
  const s = await getScenarioById(id);
  if (!s) return;
  scenarioState.current = s;

  setText('detail-title', s.title);
  setText('detail-num',   String(s.order).padStart(2, '0'));
  setText('detail-desc',  s.description);
  setText('detail-level', s.level);
  setText('detail-tags',  (s.tags ?? []).join(' · '));

  renderDialogue(s, scenarioState.detailLang);
  hideAiResponse();
  showDetailView();
}

function renderDialogue(scenario, lang) {
  const box = document.getElementById('detail-dialogue');
  if (!box) return;
  const dialogue = scenario.dialogue ?? [];

  box.innerHTML = dialogue.map((turn, i) => `
    <div class="dialogue-turn" data-speaker="${turn.speaker}">
      <div class="dialogue-speaker">${turn.speaker}</div>
      <div class="dialogue-content">
        <div class="dialogue-target">${escapeHtml(turn[lang] ?? '—')}</div>
        <div class="dialogue-translation">${escapeHtml(turn.ja ?? '')}</div>
      </div>
      <button class="dialogue-tts" data-i="${i}" aria-label="読み上げ">♪</button>
    </div>
  `).join('');

  if (!SpeechSupport.tts) {
    box.querySelectorAll('.dialogue-tts').forEach((b) => {
      b.disabled = true;
      b.title    = 'お使いのブラウザは音声合成に未対応です';
    });
  }

  box.querySelectorAll('.dialogue-tts').forEach((btn) => {
    btn.addEventListener('click', () => {
      const i    = parseInt(btn.dataset.i, 10);
      const turn = dialogue[i];
      if (!turn) return;
      stopSpeaking();
      btn.classList.add('speaking');
      speak(turn[lang], lang);
      // 1.5 秒後にハイライト解除（音声長は推定困難なのでざっくり）
      setTimeout(() => btn.classList.remove('speaking'), 1500);
    });
  });
}

function showListView() {
  document.getElementById('scenario-list-view')?.classList.remove('hidden');
  document.getElementById('scenario-detail-view')?.classList.add('hidden');
  stopSpeaking();
}

function showDetailView() {
  document.getElementById('scenario-list-view')?.classList.add('hidden');
  document.getElementById('scenario-detail-view')?.classList.remove('hidden');
  window.scrollTo({ top: 0, behavior: 'instant' });
}

function hideAiResponse() {
  const box = document.getElementById('scenario-ai-response');
  if (box) { box.classList.add('hidden'); box.textContent = ''; }
}

async function onPlayAll() {
  if (!scenarioState.current) return;
  if (!SpeechSupport.tts) {
    showToast('お使いのブラウザは音声合成に未対応です');
    return;
  }
  scenarioState.playback?.stop();
  scenarioState.playback = speakDialogue(
    scenarioState.current.dialogue,
    scenarioState.detailLang,
    { gapMs: 600 }
  );
}

function onStopAll() {
  scenarioState.playback?.stop();
  scenarioState.playback = null;
  stopSpeaking();
}

async function onScenarioAi() {
  const s = scenarioState.current;
  if (!s) return;

  const prompt = buildPrompt('scenario', scenarioState.selectedAi, {
    title:       s.title,
    description: s.description,
    language:    scenarioState.detailLang,
  });

  if (scenarioState.selectedAi === 'ollama') {
    await runOllamaScenario(prompt);
    return;
  }

  let result;
  try {
    result = await launchProvider(scenarioState.selectedAi, prompt);
  } catch (err) {
    console.error('scenario launch failed:', err);
    showToast('AI の起動に失敗しました');
    return;
  }

  if (!result.opened) {
    showToast('ポップアップがブロックされました', 4000);
  } else if (!result.copied) {
    showToast('クリップボードへのコピーに失敗しました', 4000);
  } else {
    showToast(`${result.provider.name} を開きました（Ctrl+V で貼り付け）`, 2500);
  }
}

async function runOllamaScenario(prompt) {
  const box  = document.getElementById('scenario-ai-response');
  const btn  = document.getElementById('btn-scenario-ai');
  if (!box) return;

  box.classList.remove('hidden');
  box.textContent = '応答を生成中...';
  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '生成中...'; }

  const ok = await checkOllamaAvailable();
  if (!ok) {
    box.textContent = 'Ollama に接続できません — ollama serve が起動していますか？';
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label ?? 'AI と会話練習を始める'; }
    return;
  }

  box.textContent = '';
  try {
    await callOllama(prompt, {
      onToken: (_tok, full) => { box.textContent = full; box.scrollTop = box.scrollHeight; },
    });
  } catch (err) {
    console.error('ollama scenario call failed:', err);
    box.textContent += `\n\n[エラー] ${err.message ?? err}`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label ?? 'AI と会話練習を始める'; }
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------- トースト ----------

let toastTimer = null;
function showToast(msg, ms = 1800) {
  const t = document.getElementById('toast');
  if (!t) return;
  t.textContent = msg;
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), ms);
}

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

// ---------- ログイン UI ----------

async function onLoginClick() {
  const btn = document.getElementById('btn-google-login');
  if (!btn || btn.disabled) return;

  const originalHTML = btn.innerHTML;
  btn.disabled  = true;
  btn.innerHTML = '<span class="font-mincho">サインイン中...</span>';

  try {
    await signInWithGoogle();
  } catch (err) {
    console.error('sign-in error:', err);
    showToast(authErrorMessage(err), 4000);
  } finally {
    if (!state.isAuthenticated) {
      btn.disabled  = false;
      btn.innerHTML = originalHTML;
    }
  }
}

// ---------- イベント結線 ----------

function bindEvents() {
  document.getElementById('btn-google-login')?.addEventListener('click', onLoginClick);

  document.getElementById('profile-btn')?.addEventListener('click', async () => {
    if (!confirm('ログアウトしますか？')) return;
    try {
      await signOutUser();
    } catch (err) {
      console.error('sign-out error:', err);
      showToast(authErrorMessage(err));
    }
  });

  document.querySelectorAll('#bottom-nav .nav-item').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target) showScreen(target);
    });
  });

  document.querySelectorAll('.action-card').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.target;
      if (target) showScreen(target);
    });
  });

  // フラッシュカード裏返し
  document.querySelector('.flashcard')?.addEventListener('click', (e) => {
    e.currentTarget.classList.toggle('flipped');
    vocabState.flipped = e.currentTarget.classList.contains('flipped');
  });

  // 評価ボタン
  document.querySelectorAll('.rating-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const q = parseInt(btn.dataset.quality, 10);
      if (!Number.isNaN(q)) onRate(q);
    });
  });

  // デッキチップ（日常会話 / TOEIC / VI 検定3級）
  document.querySelectorAll('#vocab-deck-row .chip').forEach((chip) => {
    chip.addEventListener('click', async () => {
      const newDeck = chip.dataset.deck;
      if (!newDeck || newDeck === vocabState.deck) return;
      vocabState.deck = newDeck;
      syncDeckUi();
      await loadVocabulary(vocabState.lang, vocabState.deck);
      await rebuildVocabQueue();
      showCurrentCard();
      refreshDueCount();
    });
  });

  // 言語タブ（複数言語対応デッキのみ表示）
  document.querySelectorAll('#vocab-lang-tabs .tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      const newLang = tab.dataset.lang;
      if (!newLang || newLang === vocabState.lang) return;
      vocabState.lang = newLang;
      syncDeckUi();
      await loadVocabulary(vocabState.lang, vocabState.deck);
      await rebuildVocabQueue();
      showCurrentCard();
      refreshDueCount();
    });
  });

  // フィルタチップ（all/learning/review/mastered）— デッキ chip と区別するため data-filter のあるものだけ
  document.querySelectorAll('#screen-vocabulary .chip[data-filter]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      document.querySelectorAll('#screen-vocabulary .chip[data-filter]').forEach((c) => c.classList.remove('chip-active'));
      chip.classList.add('chip-active');
      vocabState.filter = chip.dataset.filter ?? 'all';
      await rebuildVocabQueue();
      showCurrentCard();
    });
  });

  // TOEIC リスニング: Part タブ
  document.querySelectorAll('#screen-toeic-listening .tab[data-tl-part]').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      const part = parseInt(tab.dataset.tlPart, 10);
      if (!Number.isNaN(part)) onListeningPartChange(part);
    });
  });

  // TOEIC リスニング: 再生 / リプレイ / 停止
  document.getElementById('tl-play-btn')?.addEventListener('click', onListeningPlay);
  document.getElementById('tl-replay-btn')?.addEventListener('click', onListeningPlay);
  document.getElementById('tl-stop-btn')?.addEventListener('click', stopListeningAudio);

  // TOEIC リスニング: 速度チップ
  document.querySelectorAll('#screen-toeic-listening .chip[data-tl-speed]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const sp = parseFloat(chip.dataset.tlSpeed);
      if (!Number.isNaN(sp)) onListeningSpeedChange(sp);
    });
  });

  // TOEIC リスニング: 選択肢ボタン
  document.querySelectorAll('#tl-choices .tl-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.tlChoice, 10);
      if (!Number.isNaN(idx)) onListeningChoice(idx);
    });
  });

  // TOEIC リスニング: 次の問題 / 最初から
  document.getElementById('tl-next-btn')?.addEventListener('click', onListeningNext);
  document.getElementById('tl-restart-btn')?.addEventListener('click', onListeningRestart);

  // TOEIC リーディング: Part タブ
  document.querySelectorAll('#screen-toeic-reading .tab[data-tr-part]').forEach((tab) => {
    tab.addEventListener('click', () => {
      if (tab.disabled) return;
      const part = parseInt(tab.dataset.trPart, 10);
      if (!Number.isNaN(part)) onReadingPartChange(part);
    });
  });

  // TOEIC リーディング: 選択肢ボタン
  document.querySelectorAll('#tr-choices .tr-choice-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const idx = parseInt(btn.dataset.trChoice, 10);
      if (!Number.isNaN(idx)) onReadingChoice(idx);
    });
  });

  // TOEIC リーディング: 次へ / 最初から
  document.getElementById('tr-next-btn')?.addEventListener('click', onReadingNext);
  document.getElementById('tr-restart-btn')?.addEventListener('click', onReadingRestart);

  // シナリオ: Phase タブ
  document.querySelectorAll('#scenario-list-view .tab').forEach((tab) => {
    tab.addEventListener('click', async () => {
      document.querySelectorAll('#scenario-list-view .tab').forEach((t) => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      const phase = parseInt(tab.dataset.phase, 10);
      if (!Number.isNaN(phase)) await renderScenarioList(phase);
    });
  });

  // シナリオ: 戻るボタン
  document.getElementById('scenario-back')?.addEventListener('click', showListView);

  // シナリオ: 詳細の言語切替
  document.querySelectorAll('.detail-lang-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.detail-lang-tab').forEach((t) => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
      const lang = tab.dataset.lang;
      if (lang) {
        scenarioState.detailLang = lang;
        if (scenarioState.current) renderDialogue(scenarioState.current, lang);
      }
    });
  });

  // シナリオ: 全文読み上げ / 停止
  document.getElementById('btn-play-all')?.addEventListener('click', onPlayAll);
  document.getElementById('btn-stop-all')?.addEventListener('click', onStopAll);

  // シナリオ: AI 選択
  document.querySelectorAll('.ai-chip-scenario').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('.ai-chip-scenario').forEach((c) => c.classList.remove('ai-chip-active'));
      chip.classList.add('ai-chip-active');
      scenarioState.selectedAi = chip.dataset.ai;
    });
  });

  // シナリオ: AI 練習開始
  document.getElementById('btn-scenario-ai')?.addEventListener('click', onScenarioAi);

  // 添削: AI 選択（シナリオ側 .ai-chip-scenario とは別グループ）
  document.querySelectorAll('#screen-grammar .ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#screen-grammar .ai-chip').forEach((c) => c.classList.remove('ai-chip-active'));
      chip.classList.add('ai-chip-active');
      state.selectedAi = chip.dataset.ai;
    });
  });

  document.getElementById('btn-grammar-check')?.addEventListener('click', onGrammarCheck);
  document.getElementById('btn-copy-again')?.addEventListener('click', onCopyAgain);
}

// ---------- 文法添削（AI 起動） ----------

let lastPrompt = '';

async function onGrammarCheck() {
  const text = document.getElementById('grammar-input')?.value?.trim();
  if (!text) { showToast('文章を入力してください'); return; }

  const language = detectLanguage(text);
  const prompt   = buildPrompt('grammar', state.selectedAi, { text, language });
  lastPrompt = prompt;

  if (state.selectedAi === 'ollama') {
    await runOllamaGrammar(prompt);
    return;
  }

  let result;
  try {
    result = await launchProvider(state.selectedAi, prompt);
  } catch (err) {
    console.error('launch failed:', err);
    showToast('AI の起動に失敗しました');
    return;
  }

  showGrammarResult(result, prompt);

  if (!result.opened) {
    showToast('ポップアップがブロックされました — 手動で AI を開いてください', 4000);
  } else if (!result.copied) {
    showToast('クリップボードへのコピーに失敗 — 「再コピー」を押してください', 4000);
  } else {
    showToast(`${result.provider.name} を開きました（Ctrl+V で貼り付け）`, 2500);
  }
}

async function runOllamaGrammar(prompt) {
  const provider = getProvider('ollama');
  const panel    = document.getElementById('grammar-result');
  const respBox  = ensureOllamaResponseBox();
  const btn      = document.getElementById('btn-grammar-check');

  panel?.classList.remove('hidden');
  setText('grammar-result-ai', `${provider.name} (${provider.model})`);
  setText('grammar-result-prompt', prompt);
  const statusEl = document.getElementById('grammar-result-status');
  if (statusEl) {
    statusEl.textContent = '応答を生成中...';
    statusEl.className   = 'text-xs text-koke mt-1';
  }
  respBox.textContent = '';
  respBox.classList.remove('hidden');

  if (btn) { btn.disabled = true; btn.dataset.label = btn.textContent; btn.textContent = '生成中...'; }

  const ok = await checkOllamaAvailable();
  if (!ok) {
    showToast('Ollama に接続できません — ollama serve が起動していますか？', 5000);
    if (statusEl) {
      statusEl.textContent = 'Ollama が起動していません';
      statusEl.className   = 'text-xs text-shu mt-1';
    }
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label ?? '添削プロンプトをコピーして AI を開く'; }
    return;
  }

  try {
    await callOllama(prompt, {
      onToken: (_tok, full) => { respBox.textContent = full; },
    });
    if (statusEl) {
      statusEl.textContent = '応答完了';
      statusEl.className   = 'text-xs text-koke mt-1';
    }
  } catch (err) {
    console.error('ollama call failed:', err);
    respBox.textContent = String(err.message ?? err);
    if (statusEl) {
      statusEl.textContent = 'エラーが発生しました';
      statusEl.className   = 'text-xs text-shu mt-1';
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = btn.dataset.label ?? '添削プロンプトをコピーして AI を開く'; }
  }
}

function ensureOllamaResponseBox() {
  let box = document.getElementById('ollama-response');
  if (box) return box;
  const panel = document.getElementById('grammar-result');
  box = document.createElement('div');
  box.id = 'ollama-response';
  box.className = 'mt-3 p-3 bg-washi border border-sumi/10 rounded text-sm font-mincho whitespace-pre-wrap leading-relaxed text-sumi max-h-96 overflow-y-auto';
  panel?.appendChild(box);
  return box;
}

function showGrammarResult(result, prompt) {
  const panel = document.getElementById('grammar-result');
  if (!panel) return;
  panel.classList.remove('hidden');
  setText('grammar-result-ai', result.provider.name);
  setText('grammar-result-prompt', prompt);
  // 前回の Ollama インライン応答が残っていれば隠す
  document.getElementById('ollama-response')?.classList.add('hidden');

  const statusEl = document.getElementById('grammar-result-status');
  if (statusEl) {
    if (result.copied) {
      statusEl.textContent = 'クリップボードにコピーしました';
      statusEl.className   = 'text-xs text-koke mt-1';
    } else {
      statusEl.textContent = 'コピーできませんでした — 下の「再コピー」を押してください';
      statusEl.className   = 'text-xs text-shu mt-1';
    }
  }
}

async function onCopyAgain() {
  if (!lastPrompt) return;
  try {
    const ok = await copyToClipboard(lastPrompt);
    if (ok) {
      showToast('コピーしました');
      const statusEl = document.getElementById('grammar-result-status');
      if (statusEl) {
        statusEl.textContent = 'クリップボードにコピーしました';
        statusEl.className   = 'text-xs text-koke mt-1';
      }
    } else {
      showToast('コピーに失敗しました');
    }
  } catch (err) {
    console.error('copy failed:', err);
    showToast('コピーに失敗しました — プロンプトを手動で選択してコピーしてください');
  }
}

function bindTabGroup(selector) {
  const tabs = document.querySelectorAll(selector);
  tabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      tabs.forEach((t) => t.classList.remove('tab-active'));
      tab.classList.add('tab-active');
    });
  });
}

// ---------- 起動 ----------

function warnIfFileProtocol() {
  if (location.protocol === 'file:') {
    showToast('http://localhost で開いてください（file:// では Firebase が動きません）', 6000);
    console.warn('Firebase requires HTTP(S) — please serve via local server.');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  warnIfFileProtocol();
  bindEvents();
  await handleRedirectResult();
  onAuthChange(handleAuthChange);

  console.log('%c言の葉 v0.3', 'color:#c5382b; font-size:14px; font-weight:bold');
  console.log('Step 3: SRS 単語帳ロード完了');
});
