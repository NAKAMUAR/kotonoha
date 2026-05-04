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
import { recordAnswer, getScorePrediction, clearAttempts } from './toeic-score.js';
import { loadIeltsTopics, getIeltsTopicById, buildIeltsEvalPrompt } from './ielts-speaking.js';
import { loadIeltsWritingPrompts, getIeltsWritingById, buildIeltsWritingEvalPrompt, countWords } from './ielts-writing.js';

import {
  loadSettings,
  saveSettings,
  pullSettingsFromFirestore,
  decideLanguage,
  pickLanguage,
  COURSES,
  LANGUAGE_MODES,
} from './daily-settings.js';

import {
  getOrGenerateDailyTasks,
  toggleTaskComplete,
  pullDailyTasksFromFirestore,
  todayKey,
  getBasePreset,
} from './daily-tasks.js';

import {
  getMistakes,
  getMistakeCounts,
  markReviewed,
  pullMistakesFromFirestore,
  PRIORITY_LABELS,
} from './mistakes.js';

import { getProfile, adaptPreset } from './personalization.js';
import { fetchAdvice, getCachedAdvice } from './daily-advice.js';
import { buildPrompt } from './prompts.js';

import {
  getStatsForPeriod,
  getCumulativeSummary,
  getAccuracyByCategory,
} from './stats.js';

import {
  checkAndAwardBadges,
  getAllBadgesWithStatus,
  pullBadgesFromFirestore,
} from './badges.js';

import {
  renderDailyBar,
  renderAccuracyBars,
  renderLevelRing,
} from './charts.js';

const SCREENS = ['login', 'home', 'daily', 'vocabulary', 'scenarios', 'grammar', 'toeic-listening', 'toeic-reading', 'toeic-score', 'ielts-speaking', 'ielts-writing', 'review', 'stats'];
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

const dailyState = {
  settings:  null,
  day:       null,
  course:    'standard',
  language:  'en',
  loading:   false,
  pulledFromFirestore: false,
  profile:   null,
  adviceAi:  'claude',
  adviceText: null,
  adviceFetching: false,
  adapted:   false,
};

const reviewState = {
  loading:     false,
  pulled:      false,
  filterPriority: 'all',
  focusSource: 'all',
  // 集中復習セッション
  session:     null,        // { items, index, answered, revealedMeaning }
};

const statsState = {
  loading:  false,
  pulled:   false,
  period:   'week',
  summary:  null,
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
  if (name === 'daily')            activateDailyScreen();
  if (name === 'review')           activateReviewScreen();
  if (name === 'stats')            activateStatsScreen();
  if (name === 'scenarios')        activateScenariosScreen();
  if (name === 'toeic-listening')  activateListeningScreen();
  if (name === 'toeic-reading')    activateReadingScreen();
  if (name === 'toeic-score')      activateScoreScreen();
  if (name === 'ielts-speaking')   activateIeltsSpeakingScreen();
  if (name === 'ielts-writing')    activateIeltsWritingScreen();
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
    dailyState.pulledFromFirestore = false;
    dailyState.day        = null;
    dailyState.settings   = null;
    dailyState.profile    = null;
    dailyState.adviceText = null;
    dailyState.adviceFetching = false;
    dailyState.adapted    = false;
    reviewState.pulled    = false;
    reviewState.session   = null;
    reviewState.filterPriority = 'all';
    reviewState.focusSource = 'all';
    statsState.pulled     = false;
    statsState.summary    = null;
    statsState.period     = 'week';

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
    await rateWord(word.id, quality, {
      word:    word.word ?? word.target,
      reading: word.reading ?? '',
      meaning: word.meaning ?? '',
      example: word.example ?? '',
      lang:    word.lang ?? vocabState.lang,
      deck:    word.deck ?? vocabState.deck,
    });
  } catch (err) {
    console.error('rate failed:', err);
    showToast('評価の保存に失敗しました');
    return;
  }

  vocabState.index += 1;
  showCurrentCard();
  refreshDueCount();
}

// ---------- デイリー画面 ----------

async function activateDailyScreen() {
  if (dailyState.loading) return;
  dailyState.loading = true;
  try {
    if (!dailyState.pulledFromFirestore && state.user) {
      try {
        await pullSettingsFromFirestore();
        await pullDailyTasksFromFirestore();
        dailyState.pulledFromFirestore = true;
      } catch (err) {
        console.warn('daily pull failed (using local cache):', err);
      }
    }

    dailyState.settings = await loadSettings();
    dailyState.course   = dailyState.settings.defaultCourse ?? 'standard';
    dailyState.language = decideLanguage(dailyState.settings);

    // profile はバックグラウンドで取得 (アドバイス・適応的タスクで使用)
    dailyState.profile = await getProfile({
      lang: dailyState.language,
      deck: 'daily',
    }).catch((err) => { console.warn('profile load failed:', err); return null; });

    dailyState.day = await getOrGenerateDailyTasks({
      course:   dailyState.course,
      language: dailyState.language,
    });
    dailyState.adapted = !!dailyState.day.adapted;

    // 既存のアドバイスキャッシュがあれば表示
    dailyState.adviceText = await getCachedAdvice(
      dailyState.day.date,
      dailyState.course,
      dailyState.language,
      dailyState.profile?.generatedAt
    ).catch(() => null);

    renderDailyScreen();
    renderDailyAdvice();
  } catch (err) {
    console.error('daily screen activate failed:', err);
    showToast('本日のタスク取得に失敗しました');
  } finally {
    dailyState.loading = false;
  }
}

function renderDailyScreen() {
  const day = dailyState.day;
  const settings = dailyState.settings;
  if (!day || !settings) return;

  // 日付サブタイトル
  const dateObj = new Date(day.date + 'T00:00');
  const yobi = '日月火水木金土'[dateObj.getDay()];
  setText('daily-date-sub', `${day.date}（${yobi}）`);

  // コース chip の active 切替
  document.querySelectorAll('#daily-course-row .course-chip').forEach((c) => {
    c.classList.toggle('course-chip-active', c.dataset.course === dailyState.course);
  });

  // 進捗バー
  const pct = day.totalMin > 0 ? Math.min(100, Math.round((day.completedMin / day.totalMin) * 100)) : 0;
  const fill = document.getElementById('daily-progress-fill');
  if (fill) fill.style.width = `${pct}%`;
  setText('daily-progress-text', `${day.completedMin} / ${day.totalMin} 分（${pct}%）`);

  // 言語表示
  const langLabel = dailyState.language === 'vi' ? 'Tiếng Việt' : 'English';
  setText('daily-lang-display', langLabel);

  // 言語モード chip
  document.querySelectorAll('#daily-lang-mode-row .chip').forEach((c) => {
    c.classList.toggle('chip-active', c.dataset.langMode === settings.languageMode);
  });

  // pick モードのときだけ言語選択行を表示
  const pickRow = document.getElementById('daily-lang-pick-row');
  if (pickRow) {
    pickRow.classList.toggle('hidden', settings.languageMode !== 'pick');
    pickRow.querySelectorAll('.chip').forEach((c) => {
      c.classList.toggle('chip-active', c.dataset.pickLang === dailyState.language);
    });
  }

  // タスクリスト
  const list = document.getElementById('daily-task-list');
  const empty = document.getElementById('daily-empty');
  if (!list) return;

  if (!day.tasks.length) {
    list.innerHTML = '<p class="text-xs text-sumi-soft text-center py-4">タスクがありません</p>';
    empty?.classList.add('hidden');
    return;
  }

  list.innerHTML = '';
  for (const t of day.tasks) {
    const row = document.createElement('div');
    row.className = 'daily-task-row' + (t.completed ? ' completed' : '');
    row.dataset.taskId = t.id;
    row.dataset.target = t.target;
    row.innerHTML = `
      <button class="daily-task-icon" data-toggle="${t.id}" aria-label="完了切替">
        <span class="daily-task-icon-char">${t.icon ?? '・'}</span>
      </button>
      <div class="daily-task-label">${escapeHtml(t.label)}</div>
      <div class="daily-task-min">${t.estimatedMin} 分</div>
      <button class="daily-task-go" data-go="${t.target}">開く</button>
    `;
    list.appendChild(row);
  }

  empty?.classList.toggle('hidden', !day.allCompleted);

  // adapted インジケータ
  const adaptedNote = document.getElementById('daily-adapted-note');
  adaptedNote?.classList.toggle('hidden', !day.adapted);

  // ホーム CTA のサブテキストも更新
  const cta = document.getElementById('home-daily-sub');
  if (cta) {
    if (day.allCompleted) {
      cta.textContent = '本日はすべて完了しました';
    } else {
      cta.textContent = `${day.completedMin} / ${day.totalMin} 分 完了 — 続きをやる`;
    }
  }
}

// ---------- Daily AI Advice ----------

function renderDailyAdvice() {
  // 選んでいる AI chip の active 切替
  document.querySelectorAll('.advice-ai-chip').forEach((c) => {
    c.classList.toggle('ai-chip-active', c.dataset.adviceAi === dailyState.adviceAi);
  });

  const content = document.getElementById('daily-advice-content');
  if (!content) return;

  if (dailyState.adviceFetching) {
    content.innerHTML = '<p class="text-xs text-sumi-soft">取得中…</p>';
    return;
  }

  if (dailyState.adviceText) {
    content.textContent = dailyState.adviceText;
  } else {
    content.innerHTML = '<p class="text-xs text-sumi-soft">「アドバイスを取得」を押すと AI が今日の助言を生成します。</p>';
  }
}

async function onAdviceFetch({ force = false } = {}) {
  if (!dailyState.day) {
    showToast('タスクを先に読み込んでください');
    return;
  }
  if (dailyState.adviceFetching) return;
  dailyState.adviceFetching = true;
  setText('daily-advice-status', '');
  document.getElementById('daily-advice-status')?.classList.add('hidden');
  renderDailyAdvice();

  try {
    const taskLabels = (dailyState.day.tasks ?? []).map((t) => t.label);
    let streamed = '';
    const result = await fetchAdvice({
      dateKey:    dailyState.day.date,
      course:     dailyState.course,
      language:   dailyState.language,
      profile:    dailyState.profile,
      taskLabels,
      providerKey: dailyState.adviceAi,
      force,
      onToken:    (tok, full) => {
        streamed = full;
        const content = document.getElementById('daily-advice-content');
        if (content) content.textContent = streamed;
      },
    });

    if (result.source === 'launch') {
      const status = document.getElementById('daily-advice-status');
      if (status) {
        status.classList.remove('hidden');
        if (result.error) {
          status.textContent = `エラー: ${result.error}`;
        } else {
          status.textContent = `プロンプトをコピーして ${dailyState.adviceAi} を新タブで開きました。AI で貼り付けて結果を確認してください。`;
        }
      }
      dailyState.adviceText = null;
    } else {
      dailyState.adviceText = result.text;
      const status = document.getElementById('daily-advice-status');
      if (status && result.source === 'cache') {
        status.classList.remove('hidden');
        status.textContent = '(キャッシュ)';
      }
    }
  } catch (err) {
    console.error('advice fetch failed:', err);
    showToast('アドバイス取得に失敗しました');
  } finally {
    dailyState.adviceFetching = false;
    renderDailyAdvice();
  }
}

async function onAdaptiveTasks() {
  if (!dailyState.day) return;
  // profile を強制再計算
  dailyState.profile = await getProfile({
    force: true,
    lang:  dailyState.language,
    deck:  'daily',
  }).catch(() => null);
  if (!dailyState.profile) {
    showToast('プロファイル取得に失敗しました');
    return;
  }
  const adapted = adaptPreset(getBasePreset(dailyState.course), dailyState.profile);
  dailyState.day = await getOrGenerateDailyTasks({
    course:        dailyState.course,
    language:      dailyState.language,
    regenerate:    true,
    adaptedPreset: adapted,
  });
  dailyState.adapted = !!dailyState.day.adapted;
  renderDailyScreen();
  showToast('弱点に合わせてタスクを調整しました');
}

function onAdviceAiChange(key) {
  if (!key) return;
  dailyState.adviceAi = key;
  renderDailyAdvice();
}

async function onCourseChange(courseId) {
  if (!COURSES[courseId]) return;
  if (courseId === dailyState.course) return;
  dailyState.course = courseId;
  await saveSettings({ defaultCourse: courseId });
  dailyState.day = await getOrGenerateDailyTasks({
    course:   dailyState.course,
    language: dailyState.language,
  });
  renderDailyScreen();
}

async function onLanguageModeChange(mode) {
  if (!LANGUAGE_MODES[mode]) return;
  dailyState.settings = await saveSettings({ languageMode: mode });
  const newLang = decideLanguage(dailyState.settings);
  if (newLang !== dailyState.language) {
    dailyState.language = newLang;
    dailyState.day = await getOrGenerateDailyTasks({
      course:   dailyState.course,
      language: dailyState.language,
    });
  }
  renderDailyScreen();
}

async function onLanguagePick(lang) {
  if (lang !== 'en' && lang !== 'vi') return;
  if (lang === dailyState.language) return;
  dailyState.settings = await pickLanguage(lang);
  dailyState.language = lang;
  dailyState.day = await getOrGenerateDailyTasks({
    course:   dailyState.course,
    language: dailyState.language,
  });
  renderDailyScreen();
}

async function onTaskToggle(taskId) {
  if (!dailyState.day) return;
  dailyState.day = await toggleTaskComplete(dailyState.day.date, taskId);
  renderDailyScreen();
  // 完了で新バッジ条件を満たすかも
  checkBadgesQuiet();
}

async function onDailyRegenerate() {
  if (!dailyState.day) return;
  dailyState.day = await getOrGenerateDailyTasks({
    course:    dailyState.course,
    language:  dailyState.language,
    regenerate:true,
    adaptedPreset: null,   // 標準プリセットに戻す
  });
  dailyState.adapted = false;
  renderDailyScreen();
  showToast('タスクを再生成しました');
}

// ---------- 復習画面 ----------

const SOURCE_LABELS = {
  'vocab':    '単語',
  'toeic-l':  'TOEIC L',
  'toeic-r':  'TOEIC R',
  'ielts-w':  'IELTS W',
  'ielts-s':  'IELTS S',
  'scenario': 'シナリオ',
};

const SOURCE_TARGETS = {
  'vocab':    'vocabulary',
  'toeic-l':  'toeic-listening',
  'toeic-r':  'toeic-reading',
  'ielts-w':  'ielts-writing',
  'ielts-s':  'ielts-speaking',
  'scenario': 'scenarios',
};

async function activateReviewScreen() {
  if (reviewState.loading) return;
  reviewState.loading = true;
  try {
    if (!reviewState.pulled && state.user) {
      try {
        await pullMistakesFromFirestore();
        reviewState.pulled = true;
      } catch (err) {
        console.warn('mistakes pull failed:', err);
      }
    }

    // セッション中なら継続表示、そうでなければリスト
    if (reviewState.session) {
      showReviewFocusView();
      renderReviewSessionStep();
    } else {
      showReviewListView();
      await renderReviewList();
    }
  } catch (err) {
    console.error('review activate failed:', err);
    showToast('復習データ取得に失敗しました');
  } finally {
    reviewState.loading = false;
  }
}

function showReviewListView() {
  document.getElementById('review-list-view')?.classList.remove('hidden');
  document.getElementById('review-focus-view')?.classList.add('hidden');
}

function showReviewFocusView() {
  document.getElementById('review-list-view')?.classList.add('hidden');
  document.getElementById('review-focus-view')?.classList.remove('hidden');
}

async function renderReviewList() {
  const counts = await getMistakeCounts();
  setText('rv-count-all',      counts.all      ?? 0);
  setText('rv-count-critical', counts.critical ?? 0);
  setText('rv-count-review',   counts.review   ?? 0);
  setText('rv-count-caution',  counts.caution  ?? 0);

  // 優先度 chip の active 切替
  document.querySelectorAll('#review-filter-row .chip').forEach((c) => {
    c.classList.toggle('chip-active', c.dataset.reviewPriority === reviewState.filterPriority);
  });
  // ソース chip の active 切替
  document.querySelectorAll('[data-focus-source]').forEach((c) => {
    c.classList.toggle('chip-active', c.dataset.focusSource === reviewState.focusSource);
  });

  const list  = document.getElementById('review-item-list');
  const empty = document.getElementById('review-empty');
  if (!list) return;

  const items = await getMistakes({
    priority: reviewState.filterPriority,
    source:   reviewState.focusSource === 'all' ? 'all' : reviewState.focusSource,
  });

  if (!items.length) {
    list.innerHTML = '';
    empty?.classList.remove('hidden');
    return;
  }
  empty?.classList.add('hidden');
  list.innerHTML = '';
  for (const m of items) {
    const row = document.createElement('div');
    row.className = 'review-row';
    row.dataset.mistakeId = m.id;
    const target = SOURCE_TARGETS[m.source] ?? 'home';
    const sourceLabel = SOURCE_LABELS[m.source] ?? m.source;
    const title = mistakeTitle(m);
    const occ   = m.occurrences ?? 1;
    const days  = ageDays(m.lastWrongAt ?? m.firstWrongAt);
    row.innerHTML = `
      <div class="review-row-main">
        <span class="review-priority-badge review-priority-${m.priority}">${PRIORITY_LABELS[m.priority] ?? m.priority}</span>
        <span class="review-source-tag">${sourceLabel}</span>
        <div class="review-row-title">${escapeHtml(title)}</div>
        <div class="review-row-meta">${occ} 回間違い · ${days}</div>
      </div>
      <div class="flex flex-col gap-1">
        <button class="review-row-action" data-rv-explain="${m.id}">AI 解説</button>
        <button class="review-row-action" data-rv-open="${target}">開く</button>
      </div>
    `;
    list.appendChild(row);
  }
}

function mistakeTitle(m) {
  const s = m.snapshot ?? {};
  if (m.source === 'vocab') {
    return s.word ?? m.refId;
  }
  if (m.source === 'toeic-l' || m.source === 'toeic-r') {
    const q = s.question ?? '';
    if (q) return q.slice(0, 60) + (q.length > 60 ? '…' : '');
    return `${SOURCE_LABELS[m.source]} ${m.refId}`;
  }
  return s.question ?? m.refId;
}

function ageDays(ts) {
  if (!ts) return '—';
  const days = Math.floor((Date.now() - ts) / 86400000);
  if (days === 0) return '今日';
  if (days === 1) return '昨日';
  return `${days} 日前`;
}

async function onReviewFilterChange(priority) {
  reviewState.filterPriority = priority ?? 'all';
  await renderReviewList();
}

async function onReviewSourceChange(source) {
  reviewState.focusSource = source ?? 'all';
  await renderReviewList();
}

// ---------- 集中復習セッション ----------

async function startReviewSession() {
  const items = await getMistakes({
    priority: reviewState.filterPriority,
    source:   reviewState.focusSource === 'all' ? 'all' : reviewState.focusSource,
    limit:    20,
  });
  if (!items.length) {
    showToast('復習する問題がありません');
    return;
  }
  reviewState.session = {
    items,
    index:    0,
    answered: false,
    revealed: false,
    correctCount: 0,
  };
  showReviewFocusView();
  renderReviewSessionStep();
}

function renderReviewSessionStep() {
  const sess = reviewState.session;
  if (!sess) return;
  const area = document.getElementById('rv-focus-area');
  const done = document.getElementById('rv-focus-done');
  const fill = document.getElementById('rv-focus-fill');

  setText('rv-focus-progress', `${Math.min(sess.index + 1, sess.items.length)} / ${sess.items.length}`);
  if (fill) {
    const pct = sess.items.length ? (sess.index / sess.items.length) * 100 : 0;
    fill.style.width = `${Math.min(100, pct)}%`;
  }

  if (sess.index >= sess.items.length) {
    area.innerHTML = '';
    done?.classList.remove('hidden');
    setText('rv-focus-summary', `${sess.correctCount} / ${sess.items.length} 正解`);
    if (fill) fill.style.width = '100%';
    return;
  }

  done?.classList.add('hidden');
  const m = sess.items[sess.index];
  if (m.source === 'vocab') {
    area.innerHTML = renderVocabReviewCard(m, sess.revealed);
  } else if (m.source === 'toeic-l' || m.source === 'toeic-r') {
    area.innerHTML = renderToeicReviewCard(m, sess.revealed, sess.answered);
  } else {
    // IELTS/シナリオ等は再採点不可なので「該当画面で復習」のリンクのみ
    area.innerHTML = renderUnsupportedReviewCard(m);
  }
}

function renderVocabReviewCard(m, revealed) {
  const s = m.snapshot ?? {};
  const word     = escapeHtml(s.word ?? m.refId);
  const reading  = escapeHtml(s.reading ?? '');
  const meaning  = escapeHtml(s.meaning ?? '—');
  const example  = escapeHtml(s.example ?? '');

  if (!revealed) {
    return `
      <div class="rv-focus-question">
        <div class="text-xs text-sumi-soft tracking-widest mb-3 font-cormorant">REVIEW WORD</div>
        <div class="rv-focus-word">${word}</div>
        ${reading ? `<div class="rv-focus-reading">${reading}</div>` : ''}
      </div>
      <button class="btn-secondary w-full" data-rv-action="reveal">意味を表示</button>
    `;
  }
  return `
    <div class="rv-focus-question">
      <div class="text-xs text-sumi-soft tracking-widest mb-3 font-cormorant">REVIEW WORD</div>
      <div class="rv-focus-word">${word}</div>
      ${reading ? `<div class="rv-focus-reading">${reading}</div>` : ''}
      <div class="rv-focus-meaning">${meaning}</div>
      ${example ? `<div class="rv-focus-example">${example}</div>` : ''}
    </div>
    <div class="grid grid-cols-2 gap-2">
      <button class="btn-secondary" data-rv-action="wrong">わからなかった</button>
      <button class="btn-primary" data-rv-action="right">覚えていた</button>
    </div>
  `;
}

function renderToeicReviewCard(m, revealed, answered) {
  const s = m.snapshot ?? {};
  const q  = escapeHtml(s.question ?? '');
  const choices = s.choices ?? [];
  const correctIdx = s.correctIdx;
  const chosenIdx  = s.chosenIdx;

  if (!revealed) {
    let html = `<div class="card mb-3"><div class="card-title">設問を確認</div>
      <div class="text-sm font-mincho mt-3">${q || '(本文は復習画面では割愛)'}</div>
      <p class="text-xs text-sumi-soft mt-3">本文を読んで答えを思い出してから「答えを表示」を押してください。</p>
    </div>
    <button class="btn-secondary w-full" data-rv-action="reveal">答えを表示</button>`;
    return html;
  }

  let choicesHtml = '';
  choices.forEach((c, i) => {
    const cls = i === correctIdx ? 'snapshot-correct' : (i === chosenIdx ? 'snapshot-chosen' : 'snapshot-other');
    const label = String.fromCharCode(65 + i);
    choicesHtml += `<span class="snapshot-choice ${cls}">${label}. ${escapeHtml(c)}</span>`;
  });
  const explanation = s.explanation ? `<p class="text-xs text-sumi-soft mt-3">${escapeHtml(s.explanation)}</p>` : '';

  return `
    <div class="card mb-3">
      <div class="card-title">復習: 答え合わせ</div>
      <div class="rv-focus-snapshot mt-3">
        <div class="snapshot-q">${q}</div>
        ${choicesHtml}
      </div>
      ${explanation}
    </div>
    <div class="grid grid-cols-2 gap-2">
      <button class="btn-secondary" data-rv-action="wrong">理解できていなかった</button>
      <button class="btn-primary" data-rv-action="right">理解できた</button>
    </div>
  `;
}

function renderUnsupportedReviewCard(m) {
  const target = SOURCE_TARGETS[m.source] ?? 'home';
  return `
    <div class="card mb-3 text-center">
      <div class="text-3xl font-mincho text-shu mb-3">${SOURCE_LABELS[m.source] ?? '?'}</div>
      <p class="text-sm font-mincho mb-2">${escapeHtml(mistakeTitle(m))}</p>
      <p class="text-xs text-sumi-soft mb-4">この種別は集中復習モードでは再出題できません。元の画面で復習してください。</p>
      <button class="btn-secondary" data-rv-open="${target}">元の画面を開く</button>
    </div>
    <div class="grid grid-cols-2 gap-2">
      <button class="btn-secondary" data-rv-action="skip">スキップ</button>
      <button class="btn-primary" data-rv-action="resolve">復習済みにする</button>
    </div>
  `;
}

async function onReviewSessionAction(action) {
  const sess = reviewState.session;
  if (!sess) return;

  if (action === 'reveal') {
    sess.revealed = true;
    renderReviewSessionStep();
    return;
  }

  const m = sess.items[sess.index];
  if (!m) return;

  if (action === 'right' || action === 'resolve') {
    await markReviewed(m.id, true);
    if (action === 'right') sess.correctCount += 1;
  } else if (action === 'wrong') {
    await markReviewed(m.id, false);
  }
  // skip は何もしない（次へ）

  sess.index += 1;
  sess.revealed = false;
  sess.answered = false;
  renderReviewSessionStep();
}

function exitReviewSession() {
  reviewState.session = null;
  showReviewListView();
  renderReviewList();
}

// ---------- 統計画面 ----------

async function activateStatsScreen() {
  if (statsState.loading) return;
  statsState.loading = true;
  try {
    if (!statsState.pulled && state.user) {
      try {
        await pullBadgesFromFirestore();
        statsState.pulled = true;
      } catch (err) {
        console.warn('badges pull failed:', err);
      }
    }
    // ログイン中ならバッジ判定 (画面に来たタイミングで再評価)
    try {
      const newly = await checkAndAwardBadges();
      if (newly?.length) {
        for (const b of newly) showBadgeToast(b);
      }
    } catch (err) { /* */ }

    statsState.summary = await getCumulativeSummary();
    await renderStatsScreen();
  } catch (err) {
    console.error('stats activate failed:', err);
    showToast('統計データ取得に失敗しました');
  } finally {
    statsState.loading = false;
  }
}

async function renderStatsScreen() {
  const summary = statsState.summary;
  if (!summary) return;

  // 連続日数 / 累計分 / レベル
  setText('stats-streak',    summary.streak ?? 0);
  setText('stats-total-min', summary.totalMin ?? 0);
  const ringEl = document.getElementById('stats-level-ring');
  if (ringEl && summary.level) {
    ringEl.innerHTML = renderLevelRing(summary.level, { size: 90 });
    setText('stats-level-label', summary.level.label ?? '');
    if (summary.level.nextThreshold) {
      const need = Math.max(0, summary.level.nextThreshold - summary.totalMin);
      setText('stats-level-progress', `次レベル「${summary.level.nextLabel ?? '—'}」まで ${need} 分`);
    } else {
      setText('stats-level-progress', '最高レベルに到達しました');
    }
  }

  // 単語サマリ
  const byDeck = summary.byDeck ?? {};
  setText('stats-vocab-daily',  byDeck.daily ?? 0);
  setText('stats-vocab-toeic',  byDeck.toeic ?? 0);
  setText('stats-vocab-vi3kyu', byDeck.vi3kyu ?? 0);
  setText('stats-vocab-total',  summary.mastered ?? 0);

  // 期間別棒グラフ
  const periodStats = await getStatsForPeriod(statsState.period);
  setText('stats-period-summary',
    `${periodStats.daysActive} 日 学習 / 合計 ${periodStats.totalMin} 分`);
  const chartEl = document.getElementById('stats-bar-chart');
  if (chartEl) {
    if (periodStats.dailyMin?.length) {
      chartEl.innerHTML = renderDailyBar(periodStats.dailyMin);
    } else if (statsState.period === 'all') {
      chartEl.innerHTML = '<div class="text-xs text-sumi-soft text-center py-6">全期間グラフは「今週」「今月」をご利用ください</div>';
    } else {
      chartEl.innerHTML = '<div class="text-xs text-sumi-soft text-center py-6">データがありません</div>';
    }
  }

  // 正答率
  const accuracy = await getAccuracyByCategory();
  const accEl = document.getElementById('stats-accuracy-chart');
  if (accEl) {
    accEl.innerHTML = renderAccuracyBars(accuracy);
  }

  // バッジ
  await renderBadgeGrid();

  // ホーム画面の連続日数表示も更新
  setText('stat-streak', summary.streak ?? 0);
}

async function renderBadgeGrid() {
  const list = await getAllBadgesWithStatus();
  const grid = document.getElementById('stats-badge-grid');
  if (!grid) return;
  const earned = list.filter((b) => b.earned).length;
  setText('stats-badge-count', `${earned} / ${list.length}`);
  grid.innerHTML = '';
  for (const b of list) {
    const tile = document.createElement('div');
    tile.className = 'badge-tile ' + (b.earned ? 'earned' : 'locked');
    tile.title = b.desc ?? '';
    const dateStr = b.earned && b.earnedAt
      ? new Date(b.earnedAt).toISOString().slice(2, 10).replace(/-/g, '/')
      : '—';
    tile.innerHTML = `
      <div class="badge-kanji">${escapeHtml(b.kanji ?? '?')}</div>
      <div class="badge-name">${escapeHtml(b.name ?? '')}</div>
      <div class="badge-date">${b.earned ? dateStr : 'LOCKED'}</div>
    `;
    grid.appendChild(tile);
  }
}

async function onStatsPeriodChange(period) {
  if (!['week', 'month', 'all'].includes(period)) return;
  statsState.period = period;
  document.querySelectorAll('.stats-tab').forEach((t) => {
    t.classList.toggle('tab-active', t.dataset.statsPeriod === period);
  });
  await renderStatsScreen();
}

function showBadgeToast(badge) {
  if (!badge) return;
  const el = document.createElement('div');
  el.className = 'badge-toast';
  el.innerHTML = `
    <div class="badge-kanji">${escapeHtml(badge.kanji ?? '?')}</div>
    <div class="badge-meta">
      <div class="badge-meta-sub">BADGE EARNED</div>
      <div class="badge-meta-title">${escapeHtml(badge.name ?? '')}</div>
    </div>
  `;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

async function checkBadgesQuiet() {
  // 完了タスク後などに呼ばれて静かに判定 (新規があればトースト)
  try {
    const newly = await checkAndAwardBadges();
    for (const b of newly) showBadgeToast(b);
  } catch { /* */ }
}

async function onMistakeExplain(mistakeId) {
  if (!mistakeId) return;
  // mistakes IDB から該当を取得 (簡便のため getMistakes で全取得して find)
  const all = await getMistakes({ priority: 'all', source: 'all' });
  const m = all.find((x) => x.id === mistakeId);
  if (!m) {
    showToast('対象が見つかりませんでした');
    return;
  }
  const provider = state.selectedAi ?? 'claude';
  const prompt = buildPrompt('mistake-explain', provider, { mistake: m });
  const result = await launchProvider(provider, prompt);
  if (result.opened) {
    showToast(`${result.provider.name} を開きました — Ctrl+V で貼り付け`);
  } else {
    showToast('AI を開けませんでした (ポップアップブロック?)');
  }
}

// ---------- 間違い snapshot ビルダー ----------

function buildListeningSnapshot(q, chosenIdx) {
  // 復習画面で「設問・正解・選んだ答え」が再現できる最小情報を保存
  const choices = q.choices ?? [];
  // Part 1: imageDescriptionJa が「設問」の役割。Part 2/3/4 は q.q
  const question = q.q ?? q.imageDescriptionJa ?? '';
  return {
    type:        'toeic-l',
    part:        q.part,
    question,
    questionEn:  q.imageDescription ?? '',
    choices,
    correctIdx:  q.correct,
    chosenIdx,
    correctText: choices[q.correct] ?? '',
    chosenText:  choices[chosenIdx] ?? '',
    explanation: q.explanation ?? '',
    script:      q.script ?? null,
  };
}

function buildReadingSnapshot(q, chosenIdx) {
  const choices = q.choices ?? [];
  return {
    type:        'toeic-r',
    part:        q.part,
    question:    q.q ?? q.sentence ?? '',
    passage:     q.passage ?? '',
    choices,
    correctIdx:  q.correct,
    chosenIdx,
    correctText: choices[q.correct] ?? '',
    chosenText:  choices[chosenIdx] ?? '',
    explanation: q.explanation ?? '',
  };
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

  // スコア予測用に記録 + 不正解なら mistakes プールにも記録 (best-effort)
  const tlSnapshot = !isCorrect ? buildListeningSnapshot(q, choiceIdx) : null;
  recordAnswer({ questionId: q.id, correct: isCorrect, part: q.part, tags: q.tags ?? [], snapshot: tlSnapshot })
    .catch((err) => console.warn('record answer failed:', err));

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

// ---------- IELTS Speaking 画面 ----------

const isState = {
  topics: [],
  current: null,
  selectedAi: 'claude',
  recognition: null,
  recognizing: false,
};

async function activateIeltsSpeakingScreen() {
  try {
    isState.topics = await loadIeltsTopics();
    showIeltsListView();
  } catch (err) {
    console.error('ielts speaking activate failed:', err);
    showToast('IELTS データの読み込みに失敗しました');
  }
}

function showIeltsListView() {
  document.getElementById('is-list-view')?.classList.remove('hidden');
  document.getElementById('is-detail-view')?.classList.add('hidden');

  const list = document.getElementById('is-topic-list');
  if (!list) return;
  list.innerHTML = '';
  isState.topics.forEach((t, i) => {
    const btn = document.createElement('button');
    btn.className = 'scenario-card';
    btn.innerHTML = `
      <div class="scenario-num">${String(i + 1).padStart(2, '0')}</div>
      <div class="text-sm font-mincho mb-1">${escapeHtml(t.topic)}</div>
      <div class="text-xs text-sumi-soft">${escapeHtml(t.topicJa)}</div>
    `;
    btn.addEventListener('click', () => showIeltsDetailView(t.id));
    list.appendChild(btn);
  });
}

async function showIeltsDetailView(topicId) {
  const t = await getIeltsTopicById(topicId);
  if (!t) return;
  isState.current = t;

  document.getElementById('is-list-view')?.classList.add('hidden');
  document.getElementById('is-detail-view')?.classList.remove('hidden');

  setText('is-topic-title', t.topic);
  setText('is-topic-title-ja', t.topicJa);
  setText('is-part2-cue', t.part2?.cueCard ?? '—');

  const p1 = document.getElementById('is-part1-list');
  if (p1) {
    p1.innerHTML = '';
    (t.part1 ?? []).forEach((q) => {
      const li = document.createElement('li');
      li.textContent = q;
      p1.appendChild(li);
    });
  }

  const p3 = document.getElementById('is-part3-list');
  if (p3) {
    p3.innerHTML = '';
    (t.part3 ?? []).forEach((q) => {
      const li = document.createElement('li');
      li.textContent = q;
      p3.appendChild(li);
    });
  }

  // 質問選択ドロップダウン
  const sel = document.getElementById('is-question-select');
  if (sel) {
    sel.innerHTML = '<option value="">— 評価したい質問を選択 —</option>';
    (t.part1 ?? []).forEach((q, i) => {
      const opt = document.createElement('option');
      opt.value = `Part 1 Q${i + 1}|||${q}`;
      opt.textContent = `Part 1 Q${i + 1}: ${q.slice(0, 60)}${q.length > 60 ? '…' : ''}`;
      sel.appendChild(opt);
    });
    if (t.part2?.cueCard) {
      const opt = document.createElement('option');
      opt.value = `Part 2 Long Turn|||${t.part2.cueCard}`;
      opt.textContent = `Part 2 (Cue Card): ${t.part2.title ?? 'Long turn'}`;
      sel.appendChild(opt);
    }
    (t.part3 ?? []).forEach((q, i) => {
      const opt = document.createElement('option');
      opt.value = `Part 3 Q${i + 1}|||${q}`;
      opt.textContent = `Part 3 Q${i + 1}: ${q.slice(0, 60)}${q.length > 60 ? '…' : ''}`;
      sel.appendChild(opt);
    });
  }

  const ans = document.getElementById('is-answer-input');
  if (ans) ans.value = '';
}

function onIeltsBack() {
  isStopRecognition();
  showIeltsListView();
}

function onIeltsAiSelect(chip) {
  document.querySelectorAll('#screen-ielts-speaking .ai-chip').forEach((c) => c.classList.remove('ai-chip-active'));
  chip.classList.add('ai-chip-active');
  isState.selectedAi = chip.dataset.isAi;
}

function isStartRecognition() {
  if (!('SpeechRecognition' in window) && !('webkitSpeechRecognition' in window)) {
    showToast('お使いのブラウザは音声認識に対応していません');
    return;
  }
  if (isState.recognizing) {
    isStopRecognition();
    return;
  }
  const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  const rec = new Ctor();
  rec.lang = 'en-US';
  rec.interimResults = true;
  rec.continuous = true;

  const ans = document.getElementById('is-answer-input');
  let finalText = ans?.value ? ans.value + ' ' : '';

  rec.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const transcript = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += transcript + ' ';
      else interim += transcript;
    }
    if (ans) ans.value = finalText + interim;
  };
  rec.onend = () => { isState.recognizing = false; setText('is-mic-btn', '🎤 音声入力'); };
  rec.onerror = (e) => { console.warn('STT error:', e.error); isState.recognizing = false; setText('is-mic-btn', '🎤 音声入力'); };

  rec.start();
  isState.recognition = rec;
  isState.recognizing = true;
  setText('is-mic-btn', '⏹ 停止');
}

function isStopRecognition() {
  if (isState.recognition && isState.recognizing) {
    try { isState.recognition.stop(); } catch { /* ignore */ }
  }
  isState.recognizing = false;
  setText('is-mic-btn', '🎤 音声入力');
}

async function onIeltsEvaluate() {
  const sel = document.getElementById('is-question-select');
  const ans = document.getElementById('is-answer-input');
  const value = sel?.value;
  const userAnswer = ans?.value?.trim();

  if (!value) { showToast('評価したい質問を選択してください'); return; }
  if (!userAnswer || userAnswer.length < 10) { showToast('回答が短すぎます（10 文字以上）'); return; }
  if (!isState.current) return;

  const [partLabel, question] = value.split('|||');
  const prompt = buildIeltsEvalPrompt({
    topic: isState.current.topic,
    partLabel,
    question,
    userAnswer,
  });

  try {
    const result = await launchProvider(isState.selectedAi, prompt);
    showToast(result.copied ? 'プロンプトをコピー → AI を起動しました' : 'AI を起動しました（手動でプロンプトをコピーしてください）', 2500);
  } catch (err) {
    console.error('launchProvider failed:', err);
    showToast('AI 起動に失敗しました');
  }
}

// ---------- IELTS Writing 画面 ----------

const iwState = {
  prompts: [],
  current: null,
  task: 1,
  selectedAi: 'claude',
};

async function activateIeltsWritingScreen() {
  try {
    iwState.prompts = await loadIeltsWritingPrompts();
    showIwListView();
  } catch (err) {
    console.error('ielts writing activate failed:', err);
    showToast('IELTS Writing データの読み込みに失敗しました');
  }
}

function showIwListView() {
  document.getElementById('iw-list-view')?.classList.remove('hidden');
  document.getElementById('iw-detail-view')?.classList.add('hidden');
  renderIwPromptList();
}

function renderIwPromptList() {
  const list = document.getElementById('iw-prompt-list');
  if (!list) return;
  list.innerHTML = '';
  const filtered = iwState.prompts.filter((p) => p.task === iwState.task);
  filtered.forEach((p, i) => {
    const btn = document.createElement('button');
    btn.className = 'scenario-card';
    const preview = p.prompt.split('\n')[0].slice(0, 80);
    btn.innerHTML = `
      <div class="scenario-num">${String(i + 1).padStart(2, '0')}</div>
      <div class="text-xs text-sumi-soft mb-1">${escapeHtml(p.typeJa ?? p.type)}</div>
      <div class="text-sm font-mincho">${escapeHtml(preview)}…</div>
    `;
    btn.addEventListener('click', () => showIwDetailView(p.id));
    list.appendChild(btn);
  });
  document.querySelectorAll('#screen-ielts-writing .tab[data-iw-task]').forEach((t) => {
    t.classList.toggle('tab-active', parseInt(t.dataset.iwTask, 10) === iwState.task);
  });
}

async function showIwDetailView(promptId) {
  const p = await getIeltsWritingById(promptId);
  if (!p) return;
  iwState.current = p;

  document.getElementById('iw-list-view')?.classList.add('hidden');
  document.getElementById('iw-detail-view')?.classList.remove('hidden');

  setText('iw-task-label', `Task ${p.task}`);
  setText('iw-type-label', p.typeJa ?? p.type);
  setText('iw-prompt-text', p.prompt);

  const imgEl = document.getElementById('iw-image-desc');
  if (imgEl) {
    if (p.imageDescriptionJa) {
      imgEl.classList.remove('hidden');
      imgEl.textContent = `[図の内容] ${p.imageDescriptionJa}`;
    } else {
      imgEl.classList.add('hidden');
    }
  }

  setText('iw-word-target', `${p.wordTarget} 語以上`);
  setText('iw-time', `${p.timeMinutes} 分`);

  const ans = document.getElementById('iw-answer-input');
  if (ans) {
    ans.value = '';
    setText('iw-word-count', '0');
  }
}

function onIwBack() { showIwListView(); }

function onIwTaskChange(task) {
  iwState.task = task;
  renderIwPromptList();
}

function onIwAiSelect(chip) {
  document.querySelectorAll('#screen-ielts-writing .ai-chip').forEach((c) => c.classList.remove('ai-chip-active'));
  chip.classList.add('ai-chip-active');
  iwState.selectedAi = chip.dataset.iwAi;
}

function onIwInputChange() {
  const ans = document.getElementById('iw-answer-input');
  setText('iw-word-count', String(countWords(ans?.value ?? '')));
}

async function onIwEvaluate() {
  if (!iwState.current) return;
  const ans = document.getElementById('iw-answer-input');
  const userText = ans?.value?.trim();
  if (!userText || countWords(userText) < 50) {
    showToast('解答が短すぎます（50 語以上）');
    return;
  }

  const prompt = buildIeltsWritingEvalPrompt({
    task: iwState.current.task,
    type: iwState.current.type,
    prompt: iwState.current.prompt,
    userText,
    imageDescriptionJa: iwState.current.imageDescriptionJa,
  });

  try {
    const result = await launchProvider(iwState.selectedAi, prompt);
    showToast(result.copied ? 'プロンプトをコピー → AI を起動しました' : 'AI を起動しました（手動でプロンプトをコピーしてください）', 2500);
  } catch (err) {
    console.error('launchProvider failed:', err);
    showToast('AI 起動に失敗しました');
  }
}

// ---------- TOEIC スコア予測画面 ----------

const TOTAL_LISTENING_QS = 180;
const TOTAL_READING_QS   = 114;

async function activateScoreScreen() {
  try {
    const stats = await getScorePrediction();
    renderScoreScreen(stats);
  } catch (err) {
    console.error('score screen activate failed:', err);
    showToast('スコア予測の読み込みに失敗しました');
  }
}

function renderScoreScreen(stats) {
  const empty   = document.getElementById('ts-empty');
  const content = document.getElementById('ts-content');

  if (!stats || stats.totalAnswered === 0) {
    empty?.classList.remove('hidden');
    content?.classList.add('hidden');
    return;
  }
  empty?.classList.add('hidden');
  content?.classList.remove('hidden');

  setText('ts-total-score', stats.total);
  setText('ts-total-progress', `${stats.totalAnswered} / ${TOTAL_LISTENING_QS + TOTAL_READING_QS} 問回答済`);
  setText('ts-l-score', stats.listening.score ?? '—');
  setText('ts-l-progress', `${stats.listening.answered} / ${TOTAL_LISTENING_QS}`);
  setText('ts-r-score', stats.reading.score ?? '—');
  setText('ts-r-progress', `${stats.reading.answered} / ${TOTAL_READING_QS}`);

  renderBandList('ts-band-listening-list', stats.listening.byBand);
  renderBandList('ts-band-reading-list',   stats.reading.byBand);
}

function renderBandList(containerId, byBand) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  for (const band of ['600', '730', '860', '990']) {
    const b = byBand[band] ?? { answered: 0, correct: 0, accuracy: null };
    const pct = b.accuracy === null ? '—' : `${Math.round(b.accuracy * 100)}%`;
    const row = document.createElement('div');
    row.className = 'flex items-center justify-between';
    row.innerHTML = `
      <span class="text-sumi-soft">${band} 点レベル</span>
      <span class="font-cormorant">${b.correct} / ${b.answered} <span class="text-sumi-soft ml-2">${pct}</span></span>
    `;
    el.appendChild(row);
  }
}

async function onScoreReset() {
  if (!confirm('回答記録を全て消去しますか？この操作は取り消せません。')) return;
  try {
    await clearAttempts();
    await activateScoreScreen();
    showToast('記録を消去しました');
  } catch (err) {
    console.error('reset failed:', err);
    showToast('消去に失敗しました');
  }
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
  const questionCard = document.getElementById('tr-question-card');

  result?.classList.add('hidden');
  trState.answered = false;

  if (trState.index >= trState.questions.length) {
    empty?.classList.remove('hidden');
    choices?.classList.add('hidden');
    sentenceCard?.classList.add('hidden');
    passageCard?.classList.add('hidden');
    questionCard?.classList.add('hidden');
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

  // 全カード非表示にしてから Part 別に再表示
  sentenceCard?.classList.add('hidden');
  passageCard?.classList.add('hidden');
  questionCard?.classList.add('hidden');

  if (trState.part === 5) {
    sentenceCard?.classList.remove('hidden');

    const sentenceEl = document.getElementById('tr-sentence');
    if (sentenceEl) {
      const blank = q.blank ?? '___';
      const parts = (q.sentence ?? '').split(blank);
      sentenceEl.innerHTML = parts.map(escapeHtml).join('<span class="tr-blank">_____</span>');
    }
  } else if (trState.part === 6) {
    passageCard?.classList.remove('hidden');

    setText('tr-passage-type', q.passageTypeJa ?? '長文');
    if (typeof q.subIndex === 'number' && typeof q.totalSub === 'number') {
      setText('tr-current-blank', `空欄 [${q.subIndex + 1}] / ${q.totalSub} を選択`);
    } else {
      setText('tr-current-blank', '');
    }

    const passageEl = document.getElementById('tr-passage');
    if (passageEl) {
      let html = escapeHtml(q.passage ?? '');
      html = html.replace(/\[(\d+)\]/g, (m, n) => {
        const idx = parseInt(n, 10) - 1;
        if (idx === q.subIndex) {
          return `<span class="tr-blank-active">[${n}]</span>`;
        }
        return `<span class="tr-blank-other">[${n}]</span>`;
      });
      passageEl.innerHTML = html;
    }
  } else if (trState.part === 7) {
    passageCard?.classList.remove('hidden');
    questionCard?.classList.remove('hidden');

    setText('tr-passage-type', q.passageTypeJa ?? '読解');
    setText('tr-current-blank', '');

    const passageEl = document.getElementById('tr-passage');
    if (passageEl) {
      if (Array.isArray(q.passages) && q.passages.length > 0) {
        // 複数パッセージを区切って表示
        passageEl.innerHTML = '';
        q.passages.forEach((p, i) => {
          const titleDiv = document.createElement('div');
          titleDiv.className = 'font-semibold mt-3 mb-1';
          titleDiv.style.color = 'var(--shu)';
          titleDiv.textContent = `[${i + 1}] ${p.title ?? ''}`;
          passageEl.appendChild(titleDiv);
          const contentDiv = document.createElement('div');
          contentDiv.className = 'mb-2';
          contentDiv.textContent = p.content ?? '';
          passageEl.appendChild(contentDiv);
        });
      } else {
        passageEl.textContent = q.passage ?? '';
      }
    }

    setText('tr-question-text', q.q ?? '');
    if (typeof q.subIndex === 'number' && typeof q.totalSub === 'number') {
      setText('tr-question-sub', `この長文の設問 ${q.subIndex + 1} / ${q.totalSub}`);
    } else {
      setText('tr-question-sub', '');
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

  const trSnapshot = !isCorrect ? buildReadingSnapshot(q, choiceIdx) : null;
  recordAnswer({ questionId: q.id, correct: isCorrect, part: q.part, tags: q.tags ?? [], snapshot: trSnapshot })
    .catch((err) => console.warn('record answer failed:', err));

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

  // 完成文（Part 5 = 文、Part 6 = パッセージに当てはめ、Part 7 = 設問+正答）
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
    } else if (trState.part === 7) {
      completedEl.textContent = `Q: ${q.q ?? ''}\n正答: ${q.choices[q.correct] ?? ''}`;
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

  // ホーム CTA (本日の学習を始める)
  document.getElementById('home-daily-cta')?.addEventListener('click', () => {
    showScreen('daily');
  });

  // コース選択 (短/中/長)
  document.querySelectorAll('#daily-course-row .course-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const c = chip.dataset.course;
      if (c) onCourseChange(c);
    });
  });

  // 言語モード (rotate/pick/fixed)
  document.querySelectorAll('#daily-lang-mode-row .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const m = chip.dataset.langMode;
      if (m) onLanguageModeChange(m);
    });
  });

  // 言語選択 (pick モード時のみ表示)
  document.querySelectorAll('#daily-lang-pick-row .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      const l = chip.dataset.pickLang;
      if (l) onLanguagePick(l);
    });
  });

  // タスクリスト (event delegation)
  document.getElementById('daily-task-list')?.addEventListener('click', (e) => {
    const toggleBtn = e.target.closest('[data-toggle]');
    if (toggleBtn) {
      e.stopPropagation();
      const taskId = toggleBtn.dataset.toggle;
      onTaskToggle(taskId);
      return;
    }
    const goBtn = e.target.closest('[data-go]');
    if (goBtn) {
      const target = goBtn.dataset.go;
      if (target) showScreen(target);
      return;
    }
    // 行全体をタップ → 該当画面へ
    const row = e.target.closest('.daily-task-row');
    if (row?.dataset.target) {
      showScreen(row.dataset.target);
    }
  });

  // タスク再生成
  document.getElementById('daily-regenerate-btn')?.addEventListener('click', onDailyRegenerate);

  // 適応的タスク (★)
  document.getElementById('daily-adapt-btn')?.addEventListener('click', onAdaptiveTasks);

  // AI アドバイス: AI 選択 chip
  document.querySelectorAll('.advice-ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => onAdviceAiChange(chip.dataset.adviceAi));
  });
  // AI アドバイス: 取得 / 再生成
  document.getElementById('btn-advice-fetch')?.addEventListener('click', () => onAdviceFetch({ force: false }));
  document.getElementById('btn-advice-refresh')?.addEventListener('click', () => onAdviceFetch({ force: true }));

  // 統計画面: 期間タブ
  document.querySelectorAll('.stats-tab').forEach((tab) => {
    tab.addEventListener('click', () => onStatsPeriodChange(tab.dataset.statsPeriod));
  });

  // 復習画面: 優先度フィルタ
  document.querySelectorAll('#review-filter-row .chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      onReviewFilterChange(chip.dataset.reviewPriority);
    });
  });

  // 復習画面: ソースフィルタ
  document.querySelectorAll('[data-focus-source]').forEach((chip) => {
    chip.addEventListener('click', () => {
      onReviewSourceChange(chip.dataset.focusSource);
    });
  });

  // 集中復習開始
  document.getElementById('btn-review-focus-start')?.addEventListener('click', startReviewSession);

  // 集中復習: 戻る
  document.getElementById('rv-focus-back')?.addEventListener('click', exitReviewSession);
  document.getElementById('rv-focus-restart')?.addEventListener('click', exitReviewSession);

  // 集中復習: 動的に生成されるアクションボタン (delegation)
  document.getElementById('rv-focus-area')?.addEventListener('click', (e) => {
    const actBtn = e.target.closest('[data-rv-action]');
    if (actBtn) {
      onReviewSessionAction(actBtn.dataset.rvAction);
      return;
    }
    const openBtn = e.target.closest('[data-rv-open]');
    if (openBtn) {
      const t = openBtn.dataset.rvOpen;
      if (t) showScreen(t);
    }
  });

  // 個別復習リストの「開く」/「AI 解説」ボタン (delegation)
  document.getElementById('review-item-list')?.addEventListener('click', async (e) => {
    const explainBtn = e.target.closest('[data-rv-explain]');
    if (explainBtn) {
      e.stopPropagation();
      await onMistakeExplain(explainBtn.dataset.rvExplain);
      return;
    }
    const openBtn = e.target.closest('[data-rv-open]');
    if (openBtn) {
      const t = openBtn.dataset.rvOpen;
      if (t) showScreen(t);
    }
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

  // TOEIC スコア予測: リセット
  document.getElementById('ts-reset-btn')?.addEventListener('click', onScoreReset);

  // IELTS Speaking
  document.getElementById('is-back-btn')?.addEventListener('click', onIeltsBack);
  document.getElementById('is-mic-btn')?.addEventListener('click', isStartRecognition);
  document.getElementById('is-evaluate-btn')?.addEventListener('click', onIeltsEvaluate);
  document.querySelectorAll('#screen-ielts-speaking .ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => onIeltsAiSelect(chip));
  });

  // IELTS Writing
  document.getElementById('iw-back-btn')?.addEventListener('click', onIwBack);
  document.getElementById('iw-evaluate-btn')?.addEventListener('click', onIwEvaluate);
  document.getElementById('iw-answer-input')?.addEventListener('input', onIwInputChange);
  document.querySelectorAll('#screen-ielts-writing .tab[data-iw-task]').forEach((tab) => {
    tab.addEventListener('click', () => {
      const task = parseInt(tab.dataset.iwTask, 10);
      if (!Number.isNaN(task)) onIwTaskChange(task);
    });
  });
  document.querySelectorAll('#screen-ielts-writing .ai-chip').forEach((chip) => {
    chip.addEventListener('click', () => onIwAiSelect(chip));
  });

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
