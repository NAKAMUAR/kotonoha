// =====================================================================
// 言の葉 / Kotonoha — メインエントリ
// Step 1: 画面切り替え骨格
// Step 2: Firebase 認証 + Firestore ユーザードキュメント連携
// Step 3: 単語帳（IndexedDB + FSRS-6 SRS + Firestore 同期）  ← 現在
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
  previewWord,
  getStudyStats,
  getForecast,
  getSettings,
  updateSettings,
  pullSrsFromFirestore,
  pullSettingsFromFirestore,
  clearLocalSrs,
  shouldRequeue,
  getDeck,
  formatInterval,
  optimizeParameters,
  resetParameters,
  getOptimizeReadiness,
  RATING,
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

import {
  loadToneSets,
  buildToneQueue,
  evaluateRecording,
  verdictOf,
  suggestedRating,
  recordToneAttempt,
  contourToPath,
  TONES,
} from './pronunciation.js';

import {
  Recorder,
  isSupported as micSupported,
  unsupportedReason as micUnsupportedReason,
  micErrorMessage,
} from './audio-recorder.js';
import { recordAnswer, getScorePrediction, clearAttempts } from './toeic-score.js';
import { loadIeltsTopics, getIeltsTopicById, buildIeltsEvalPrompt } from './ielts-speaking.js';
import { loadIeltsWritingPrompts, getIeltsWritingById, buildIeltsWritingEvalPrompt, countWords } from './ielts-writing.js';

const SCREENS = ['login', 'home', 'vocabulary', 'scenarios', 'grammar', 'toeic-listening', 'toeic-reading', 'toeic-score', 'ielts-speaking', 'ielts-writing', 'pronunciation'];
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
  settings:            null,
  // 当セッションの成績。終了時に振り返りとして提示する。
  session:             { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 },
};

// 学習ステップ中のカードを同一セッション内で再提示するまでに挟む枚数。
// 直後に出すと短期記憶で答えられてしまい、想起練習にならない。
const REQUEUE_GAP = 4;

const pronState = {
  sets:      [],
  setId:     null,
  queue:     [],
  index:     0,
  recorder:  null,
  recording: false,
  lastResult: null,
  rated:     false,
  done:      0,
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

  // 発音画面から離れるときはマイクを必ず解放する
  if (state.currentScreen === 'pronunciation' && name !== 'pronunciation') {
    pronState.recording = false;
    pronState.recorder?.release();
    pronState.recorder = null;
    document.getElementById('pron-record')?.classList.remove('recording');
  }

  state.currentScreen = name;
  window.scrollTo({ top: 0, behavior: 'instant' });

  if (name === 'vocabulary')       activateVocabularyScreen();
  if (name === 'home')             refreshHomeStats();
  if (name === 'scenarios')        activateScenariosScreen();
  if (name === 'toeic-listening')  activateListeningScreen();
  if (name === 'toeic-reading')    activateReadingScreen();
  if (name === 'toeic-score')      activateScoreScreen();
  if (name === 'pronunciation')    activatePronunciationScreen();
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
    // 期日総数（数千件になりうる）ではなく、1 日の上限を反映した
    // 「今日こなす量」を見せる。達成可能な数字のほうが継続率が高い。
    setText('due-count',  stats.todayCount);
  } catch (err) {
    console.warn('home stats refresh failed:', err);
  }
}

async function refreshDueCount() {
  try {
    const stats = await getStudyStats(vocabState.lang, vocabState.deck);
    setText('due-count', stats.todayCount);
    renderTodayProgress(stats);
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
        await pullSettingsFromFirestore();
        vocabState.pulledFromFirestore = true;
      } catch (err) {
        console.warn('SRS pull failed (using local cache):', err);
      }
    }
    vocabState.settings = await getSettings();
    syncSettingsUi();
    syncDeckUi();
    resetSession();
    await loadVocabulary(vocabState.lang, vocabState.deck);
    await rebuildVocabQueue();
    await showCurrentCard();
    refreshDueCount();
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

function resetSession() {
  vocabState.session = { reviewed: 0, again: 0, hard: 0, good: 0, easy: 0 };
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

const STATUS_BADGE = {
  new:      { label: 'NEW',      cls: 'card-badge-new' },
  learning: { label: 'LEARNING', cls: 'card-badge-learning' },
  review:   { label: 'REVIEW',   cls: 'card-badge-review' },
  mastered: { label: 'MASTERED', cls: 'card-badge-mastered' },
};

async function showCurrentCard() {
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

  updateCardBadges(word);

  flashcardEl?.classList.remove('flipped');
  vocabState.flipped = false;

  // 「今どれを押すと次はいつか」をボタンに表示する。
  // 自分の記憶状態を見積もる作業自体が学習効果を持つ（メタ認知）。
  await updateIntervalPreview(word.id);
}

function updateCardBadges(word) {
  const badge  = document.getElementById('card-status-badge');
  const recall = document.getElementById('card-recall-badge');

  if (badge) {
    const info = STATUS_BADGE[word.status] ?? STATUS_BADGE.new;
    badge.textContent = info.label;
    badge.className = `card-badge ${info.cls}`;
  }

  if (recall) {
    // 想起率＝いま思い出せる推定確率。忘れかけている単語ほど低い。
    const hasMemory = word.srs && word.srs.stability > 0;
    if (hasMemory && word.status !== 'new') {
      recall.textContent = `想起率 ${Math.round(word.retrievability * 100)}%`;
      recall.classList.remove('hidden');
    } else {
      recall.classList.add('hidden');
    }
  }
}

/** カードを裏返す。想起 → 答え合わせ の順を守らせるための単一の入口。 */
function flipCurrentCard() {
  const el = document.querySelector('.flashcard');
  if (!el) return;
  el.classList.toggle('flipped');
  vocabState.flipped = el.classList.contains('flipped');
}

async function updateIntervalPreview(wordId) {
  const nodes = document.querySelectorAll('.rating-interval');
  if (!nodes.length) return;
  try {
    const preview = await previewWord(wordId);
    nodes.forEach((el) => {
      const rating = Number(el.dataset.interval);
      el.textContent = formatInterval(preview[rating]);
    });
  } catch {
    nodes.forEach((el) => { el.textContent = '—'; });
  }
}

async function populateEmptyStats() {
  try {
    const stats = await getStudyStats(vocabState.lang, vocabState.deck);

    setText(
      'vocab-stats',
      `新規 ${stats.new} ・ 学習中 ${stats.learning} ・ 復習 ${stats.review} ・ 習得 ${stats.mastered}`
      + (stats.leeches > 0 ? ` ・ 要注意 ${stats.leeches}` : '')
    );

    // 平均安定度＝この単語群を平均どれだけの間隔で覚えていられるか。
    // 学習が進むほど伸びるので、進捗の実感につながる。
    setText(
      'vocab-memory-stats',
      stats.avgStability > 0
        ? `平均定着 ${formatInterval(stats.avgStability)} ・ 平均難易度 ${stats.avgDifficulty}/10`
        : ''
    );

    renderSessionSummary(stats);
  } catch {
    /* ignore */
  }
}

function renderSessionSummary(stats) {
  const el = document.getElementById('vocab-session-summary');
  if (!el) return;

  const { reviewed, again } = vocabState.session;
  if (reviewed === 0) { el.innerHTML = ''; return; }

  const accuracy = Math.round((1 - again / reviewed) * 100);
  const target   = Math.round((stats.settings?.desiredRetention ?? 0.9) * 100);

  el.innerHTML = `
    <div class="session-stat">
      <div class="session-stat-value">${reviewed}</div>
      <div class="session-stat-label">今回の復習</div>
    </div>
    <div class="session-stat">
      <div class="session-stat-value">${accuracy}%</div>
      <div class="session-stat-label">正答率 (目標 ${target}%)</div>
    </div>
    <div class="session-stat">
      <div class="session-stat-value">${stats.today.newDone}</div>
      <div class="session-stat-label">本日の新規</div>
    </div>`;
}

/** 今日の進捗を「12 / 20 新規」の形でヘッダに出す。 */
function renderTodayProgress(stats) {
  const el = document.getElementById('vocab-today-progress');
  if (!el || !stats?.settings) return;
  const { newDone, reviewDone } = stats.today;
  el.textContent = `｜新規 ${newDone}/${stats.settings.newPerDay} ・ 復習 ${reviewDone}/${stats.settings.reviewPerDay}`;
}

const SESSION_KEY_BY_RATING = {
  [RATING.AGAIN]: 'again',
  [RATING.HARD]:  'hard',
  [RATING.GOOD]:  'good',
  [RATING.EASY]:  'easy',
};

async function onRate(rating) {
  if (vocabState.queue.length === 0 || vocabState.index >= vocabState.queue.length) return;
  if (!vocabState.flipped) {
    showToast('カードをタップして意味を確認してください');
    return;
  }

  const word = vocabState.queue[vocabState.index];
  let updated;
  try {
    updated = await rateWord(word.id, rating);
  } catch (err) {
    console.error('rate failed:', err);
    showToast('評価の保存に失敗しました');
    return;
  }

  vocabState.session.reviewed += 1;
  const key = SESSION_KEY_BY_RATING[rating];
  if (key) vocabState.session[key] += 1;

  vocabState.index += 1;

  // 学習ステップ中（新規・忘れた単語）は当日中にもう一度出す。
  // 1 回見ただけで数日先に送ると、そのまま忘れて定着しない。
  if (shouldRequeue(updated)) {
    const insertAt = Math.min(vocabState.index + REQUEUE_GAP, vocabState.queue.length);
    vocabState.queue.splice(insertAt, 0, {
      ...word,
      srs: updated,
      status: 'learning',
      retrievability: 1,
    });
    if (updated.leech) {
      showToast(`「${word.word}」は何度も忘れています。例文ごと覚え直しましょう`);
    }
  }

  await showCurrentCard();
  refreshDueCount();
}

// ---------- 学習設定 ----------

function syncSettingsUi() {
  const s = vocabState.settings;
  if (!s) return;

  document.querySelectorAll('#vocab-settings [data-retention]').forEach((chip) => {
    chip.classList.toggle('chip-active', Number(chip.dataset.retention) === s.desiredRetention);
  });

  const newSlider = document.getElementById('setting-new-per-day');
  if (newSlider) { newSlider.value = s.newPerDay; setText('setting-new-per-day-val', s.newPerDay); }

  const revSlider = document.getElementById('setting-review-per-day');
  if (revSlider) { revSlider.value = s.reviewPerDay; setText('setting-review-per-day-val', s.reviewPerDay); }

  const interleaveBox = document.getElementById('setting-interleave');
  if (interleaveBox) interleaveBox.checked = Boolean(s.interleave);
}

async function applySettings(patch) {
  vocabState.settings = await updateSettings(patch);
  syncSettingsUi();
  await rebuildVocabQueue();
  await showCurrentCard();
  await refreshForecast();
  refreshDueCount();
}

// ---------- FSRS パラメータの個人最適化 ----------

let optimizerRunning = false;

/** 履歴が足りているかを見て、ボタンの有効／無効と説明文を更新する。 */
async function refreshOptimizerStatus() {
  const statusEl = document.getElementById('optimizer-status');
  const runBtn   = document.getElementById('optimizer-run');
  const resetBtn = document.getElementById('optimizer-reset');
  if (!statusEl || !runBtn) return;

  const s = vocabState.settings;
  const optimized = Array.isArray(s?.params);
  resetBtn?.classList.toggle('hidden', !optimized);

  try {
    const { reviews, required, ready } = await getOptimizeReadiness();
    runBtn.disabled = !ready || optimizerRunning;

    if (!ready) {
      statusEl.textContent =
        `復習履歴 ${reviews} / ${required} 件。あと ${required - reviews} 件たまると最適化できます。`;
      return;
    }

    if (optimized && s.optimizedAt) {
      const when = new Date(s.optimizedAt).toLocaleDateString('ja-JP');
      statusEl.textContent = `${when} に最適化済み（履歴 ${reviews} 件）。履歴が増えたら再実行できます。`;
    } else {
      statusEl.textContent = `復習履歴 ${reviews} 件。いま最適化できます（数十秒かかります）。`;
    }
  } catch (err) {
    console.warn('optimizer readiness failed:', err);
    statusEl.textContent = '履歴を読み込めませんでした';
    runBtn.disabled = true;
  }
}

async function onOptimizeClick() {
  if (optimizerRunning) return;

  const runBtn      = document.getElementById('optimizer-run');
  const progressBox = document.getElementById('optimizer-progress');
  const barFill     = document.getElementById('optimizer-bar-fill');
  const resultBox   = document.getElementById('optimizer-result');

  optimizerRunning = true;
  if (runBtn) { runBtn.disabled = true; runBtn.textContent = '最適化中…'; }
  progressBox?.classList.remove('hidden');
  resultBox?.classList.add('hidden');
  if (barFill) barFill.style.width = '0%';

  try {
    const result = await optimizeParameters(({ iteration, total, logLoss }) => {
      const pct = Math.min(100, Math.round((iteration / total) * 100));
      if (barFill) barFill.style.width = `${pct}%`;
      setText('optimizer-progress-text', `${pct}% (${logLoss.toFixed(4)})`);
    });

    if (barFill) barFill.style.width = '100%';
    vocabState.settings = await getSettings();
    renderOptimizeResult(result);

    // 新しい係数で間隔が変わるので、キューと予測を引き直す
    await rebuildVocabQueue();
    await showCurrentCard();
    await refreshForecast();
  } catch (err) {
    console.error('optimize failed:', err);
    showToast('最適化に失敗しました');
    resultBox?.classList.add('hidden');
  } finally {
    optimizerRunning = false;
    if (runBtn) { runBtn.textContent = '最適化する'; }
    progressBox?.classList.add('hidden');
    setText('optimizer-progress-text', '');
    await refreshOptimizerStatus();
  }
}

function renderOptimizeResult(result) {
  const el = document.getElementById('optimizer-result');
  if (!el) return;
  el.classList.remove('hidden');

  if (!result.ok) {
    el.innerHTML = `履歴が足りません（${result.reviews} / ${result.required} 件）。`;
    return;
  }

  if (!result.improved) {
    // 検証データで既定値を上回れなかったので採用しない。
    // 「変化なし」を正直に出したほうが、次に何をすべきかが伝わる。
    const why = result.rejectedFor === 'calibration'
      ? '予測日付の当たり具合がむしろ悪くなったため、採用を見送りました。'
      : '既定パラメータと比べて意味のある差が出ませんでした。';
    el.innerHTML = `
      ${why}既定値のまま続けます。復習履歴が増えてから再実行してください。<br>
      <span class="optimizer-result-metric">
        検証 ${result.validReviews} 件 ・
        logLoss ${result.before.logLoss.toFixed(4)} → ${result.after.logLoss.toFixed(4)} ・
        RMSE ${result.before.rmse.toFixed(4)} → ${result.after.rmse.toFixed(4)}
      </span>`;
    return;
  }

  const lossGain = (1 - result.after.logLoss / result.before.logLoss) * 100;
  const rmseGain = (1 - result.after.rmse / result.before.rmse) * 100;

  el.innerHTML = `
    <span class="optimizer-result-good">あなた専用のパラメータを適用しました。</span><br>
    予測のずれが ${lossGain.toFixed(1)}%${rmseGain > 0 ? `、日付の当たり具合が ${rmseGain.toFixed(0)}%` : ''} 改善しました。<br>
    <span class="optimizer-result-metric">
      学習 ${result.trainReviews} 件 / 検証 ${result.validReviews} 件 ・
      logLoss ${result.before.logLoss.toFixed(4)} → ${result.after.logLoss.toFixed(4)} ・
      RMSE ${result.before.rmse.toFixed(4)} → ${result.after.rmse.toFixed(4)}
    </span>`;
}

async function onResetParameters() {
  if (!confirm('個人最適化したパラメータを破棄して既定値に戻しますか？')) return;
  vocabState.settings = await resetParameters();
  document.getElementById('optimizer-result')?.classList.add('hidden');
  await rebuildVocabQueue();
  await showCurrentCard();
  await refreshForecast();
  await refreshOptimizerStatus();
  showToast('既定パラメータに戻しました');
}

/** 今後 14 日の復習予定を棒グラフで描く。学習負荷の可視化。 */
async function refreshForecast() {
  const el = document.getElementById('vocab-forecast');
  if (!el) return;
  try {
    const buckets = await getForecast(vocabState.lang, vocabState.deck, 14);
    const max = Math.max(...buckets, 1);
    if (buckets.every((b) => b === 0)) {
      el.innerHTML = '<span class="forecast-empty">まだ復習予定はありません</span>';
      return;
    }
    el.innerHTML = buckets
      .map((n, i) => {
        const h = Math.max(2, Math.round((n / max) * 100));
        const cls = i === 0 ? 'forecast-bar forecast-bar-today' : 'forecast-bar';
        return `<div class="${cls}" style="height:${h}%" title="${i === 0 ? '今日' : i + '日後'}: ${n} 語"></div>`;
      })
      .join('');
  } catch {
    el.innerHTML = '';
  }
}

// ---------- 発音練習画面（ベトナム語の声調） ----------

async function activatePronunciationScreen() {
  const reason = micUnsupportedReason();
  const box = document.getElementById('pron-unsupported');
  const main = document.getElementById('pron-main');

  if (reason || !micSupported()) {
    setText('pron-unsupported-text', reason ?? 'この端末では発音練習を利用できません');
    box?.classList.remove('hidden');
    main?.classList.add('hidden');
    return;
  }
  box?.classList.add('hidden');
  main?.classList.remove('hidden');

  try {
    if (!pronState.sets.length) {
      pronState.sets = await loadToneSets();
      pronState.setId = pronState.sets[0]?.id ?? null;
      renderToneSetChips();
    }
    await rebuildToneQueue();
    showToneItem();
  } catch (err) {
    console.error('pronunciation activate failed:', err);
    showToast('発音データの読み込みに失敗しました');
  }
}

function renderToneSetChips() {
  const row = document.getElementById('pron-set-row');
  if (!row) return;
  row.innerHTML = pronState.sets
    .map((set) => `<button class="chip${set.id === pronState.setId ? ' chip-active' : ''}" data-pron-set="${set.id}">${set.title}</button>`)
    .join('');

  row.querySelectorAll('[data-pron-set]').forEach((chip) => {
    chip.addEventListener('click', async () => {
      if (chip.dataset.pronSet === pronState.setId) return;
      pronState.setId = chip.dataset.pronSet;
      pronState.done = 0;
      renderToneSetChips();
      await rebuildToneQueue();
      showToneItem();
    });
  });
}

async function rebuildToneQueue() {
  pronState.queue = await buildToneQueue(pronState.setId);
  pronState.index = 0;
}

function currentToneItem() {
  return pronState.queue[pronState.index] ?? null;
}

function showToneItem() {
  const item = currentToneItem();
  const result = document.getElementById('pron-result');
  result?.classList.add('hidden');
  pronState.lastResult = null;
  pronState.rated = false;

  if (!item) {
    setText('pron-word', '完');
    setText('pron-meaning', 'このセットは一巡しました');
    setText('pron-hint', '別のセットを選ぶか、時間をおいて復習してください');
    setText('pron-tone-label', '—');
    setText('pron-tone-mark', '');
    setPath('pron-target-path', '');
    setPath('pron-user-path', '');
    setText('pron-status', '');
    document.getElementById('pron-record')?.setAttribute('disabled', 'true');
    renderToneProgress();
    return;
  }

  document.getElementById('pron-record')?.removeAttribute('disabled');

  const tone = TONES[item.tone];
  setText('pron-word', item.word);
  setText('pron-meaning', item.meaning ?? '');
  setText('pron-tone-label', tone?.label ?? item.tone);
  setText('pron-tone-mark', tone?.mark ?? '');
  setText('pron-hint', tone?.description ?? '');
  setText('pron-status', 'ボタンを押しながら発音してください');

  // お手本の輪郭を先に描いておく（何を目指すのか見えてから発音させる）
  setPath('pron-target-path', contourToPath(toneTargetShape(item.tone)));
  setPath('pron-user-path', '');
  renderToneProgress();
}

/** 表示用のお手本輪郭。記述用の contour をそのまま使う。 */
function toneTargetShape(toneId) {
  const c = TONES[toneId]?.contour ?? [];
  const mean = c.reduce((a, b) => a + b, 0) / (c.length || 1);
  return c.map((v) => v - mean);
}

function setPath(id, d) {
  const el = document.getElementById(id);
  if (el) el.setAttribute('d', d);
}

function renderToneProgress() {
  const total = pronState.queue.length;
  setText('pron-progress', total ? `${Math.min(pronState.index + 1, total)} / ${total}　（練習 ${pronState.done} 回）` : '');
}

// --- 録音 ---

async function startToneRecording() {
  if (pronState.recording) return;
  const item = currentToneItem();
  if (!item) return;

  const btn = document.getElementById('pron-record');
  try {
    pronState.recorder = new Recorder();
    await pronState.recorder.start();
    pronState.recording = true;
    btn?.classList.add('recording');
    setText('pron-record-label', '録音中…');
    setText('pron-status', '母音を少し長めに伸ばしてください');
  } catch (err) {
    console.error('mic start failed:', err);
    pronState.recording = false;
    pronState.recorder?.release();
    pronState.recorder = null;
    btn?.classList.remove('recording');
    setText('pron-record-label', '押しながら発音');
    showToast(micErrorMessage(err));
    setText('pron-status', micErrorMessage(err));
  }
}

async function stopToneRecording() {
  if (!pronState.recording || !pronState.recorder) return;
  const btn = document.getElementById('pron-record');
  pronState.recording = false;
  btn?.classList.remove('recording');
  setText('pron-record-label', '押しながら発音');
  setText('pron-status', '解析中…');

  let captured;
  try {
    captured = await pronState.recorder.stop();
  } catch (err) {
    console.error('mic stop failed:', err);
    setText('pron-status', '録音を取得できませんでした');
    return;
  } finally {
    pronState.recorder = null;
  }

  const item = currentToneItem();
  if (!item) return;

  if (captured.durationSec < 0.2) {
    setText('pron-status', '短すぎます。ボタンを押したまま、はっきり発音してください');
    return;
  }

  const { result } = evaluateRecording(captured.samples, captured.sampleRate, item.tone);
  pronState.lastResult = result;
  renderToneResult(result);
}

function renderToneResult(result) {
  const box = document.getElementById('pron-result');
  if (!box) return;

  if (!result.ok) {
    setText('pron-status', result.advice ?? '判定できませんでした');
    box.classList.add('hidden');
    return;
  }

  setText('pron-status', '');
  box.classList.remove('hidden');

  setText('pron-score', String(result.score));
  setText('pron-advice', result.advice);
  setPath('pron-user-path', contourToPath(result.userShape));

  const verdict = verdictOf(result);
  const el = document.getElementById('pron-verdict');
  if (el) {
    el.textContent = verdict.label;
    el.className = `pron-verdict pron-verdict-${verdict.key}`;
  }

  // 自己申告がないまま次へ進んだ場合に備え、機械判定を既定値として持っておく
  pronState.suggested = suggestedRating(result);
  pronState.done += 1;
  renderToneProgress();
}

async function onToneRate(rating) {
  const item = currentToneItem();
  if (!item || !pronState.lastResult || pronState.rated) return;
  pronState.rated = true;

  try {
    await recordToneAttempt(item.id, rating);
  } catch (err) {
    console.error('tone rating failed:', err);
    showToast('評価の保存に失敗しました');
  }

  pronState.index += 1;
  showToneItem();
}

function speakCurrentTone() {
  const item = currentToneItem();
  if (!item) return;
  // 端末に vi-VN の音声が無い場合は無音になるため、その旨を伝える
  const ok = speak(item.word, 'vi', { rate: 0.75 });
  if (!ok) setText('pron-status', 'この端末にベトナム語の音声が入っていません');
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

  // スコア予測用に記録（best-effort）
  recordAnswer({ questionId: q.id, correct: isCorrect, part: q.part, tags: q.tags ?? [] })
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

  recordAnswer({ questionId: q.id, correct: isCorrect, part: q.part, tags: q.tags ?? [] })
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
      <div class="scenario-meta">
        <span class="font-cormorant tracking-widest">${s.level}</span>
        ${(s.tags ?? []).includes('native') ? '<span class="scenario-badge">ネイティブ表現</span>' : ''}
      </div>
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
        ${turn.note ? `<div class="dialogue-note">${escapeHtml(turn.note)}</div>` : ''}
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
  document.querySelector('.flashcard')?.addEventListener('click', () => flipCurrentCard());

  // 評価ボタン（4 段階）。旧 data-quality も後方互換で受け付ける。
  document.querySelectorAll('.rating-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const raw = btn.dataset.rating ?? btn.dataset.quality;
      const r = parseInt(raw, 10);
      if (!Number.isNaN(r)) onRate(r);
    });
  });

  // キーボード操作。マウスへ手を伸ばす往復がなくなるだけで
  // 1 セッションの復習枚数がはっきり増える。
  document.addEventListener('keydown', (e) => {
    if (state.currentScreen !== 'vocabulary') return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      flipCurrentCard();
      return;
    }
    if (e.key >= '1' && e.key <= '4') {
      e.preventDefault();
      // 裏返す前は、まず自力で想起させる（active recall）
      if (!vocabState.flipped) { flipCurrentCard(); return; }
      onRate(Number(e.key));
    }
  });

  // 学習設定パネルの開閉
  const settingsToggle = document.getElementById('vocab-settings-toggle');
  settingsToggle?.addEventListener('click', async () => {
    const panel = document.getElementById('vocab-settings');
    if (!panel) return;
    const nowHidden = panel.classList.toggle('hidden');
    settingsToggle.setAttribute('aria-expanded', String(!nowHidden));
    if (!nowHidden) {
      await refreshForecast();
      await refreshOptimizerStatus();
    }
  });

  // 目標記憶率
  document.querySelectorAll('#vocab-settings [data-retention]').forEach((chip) => {
    chip.addEventListener('click', () => {
      applySettings({ desiredRetention: Number(chip.dataset.retention) });
    });
  });

  // 1 日の上限スライダー（ドラッグ中は表示だけ、確定時に保存）
  const newSlider = document.getElementById('setting-new-per-day');
  newSlider?.addEventListener('input', () => setText('setting-new-per-day-val', newSlider.value));
  newSlider?.addEventListener('change', () => applySettings({ newPerDay: Number(newSlider.value) }));

  const revSlider = document.getElementById('setting-review-per-day');
  revSlider?.addEventListener('input', () => setText('setting-review-per-day-val', revSlider.value));
  revSlider?.addEventListener('change', () => applySettings({ reviewPerDay: Number(revSlider.value) }));

  const interleaveBox = document.getElementById('setting-interleave');
  interleaveBox?.addEventListener('change', () => applySettings({ interleave: interleaveBox.checked }));

  // パラメータ最適化
  document.getElementById('optimizer-run')?.addEventListener('click', onOptimizeClick);
  document.getElementById('optimizer-reset')?.addEventListener('click', onResetParameters);

  // --- 発音練習 ---
  document.getElementById('pron-listen')?.addEventListener('click', speakCurrentTone);

  // 録音ボタンは「押している間だけ録る」。
  // iOS Safari は pointerdown をユーザー操作として扱うので、
  // ここから AudioContext を resume できる（click を待つと録り逃す）。
  const recBtn = document.getElementById('pron-record');
  if (recBtn) {
    const begin = (e) => {
      e.preventDefault();
      startToneRecording();
    };
    const end = (e) => {
      e.preventDefault();
      stopToneRecording();
    };

    if (window.PointerEvent) {
      recBtn.addEventListener('pointerdown', begin);
      recBtn.addEventListener('pointerup', end);
      recBtn.addEventListener('pointercancel', end);
      // 押したまま指がボタンの外へ出ても録音を止める
      recBtn.addEventListener('pointerleave', (e) => { if (pronState.recording) end(e); });
    } else {
      // 古い iOS 向けフォールバック
      recBtn.addEventListener('touchstart', begin, { passive: false });
      recBtn.addEventListener('touchend', end);
      recBtn.addEventListener('touchcancel', end);
      recBtn.addEventListener('mousedown', begin);
      recBtn.addEventListener('mouseup', end);
    }

    // 長押しによるテキスト選択・コンテキストメニューを抑止
    recBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // 発音の自己評価
  document.querySelectorAll('[data-pron-rating]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const r = parseInt(btn.dataset.pronRating, 10);
      if (!Number.isNaN(r)) onToneRate(r);
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
      await showCurrentCard();
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
      await showCurrentCard();
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
      await showCurrentCard();
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
