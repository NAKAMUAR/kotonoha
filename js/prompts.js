// =====================================================================
// 言の葉 / Kotonoha — プロンプトテンプレート
// Step 4: 各 AI 向けに最適化されたプロンプトを生成
//
// タスク種別:
//   grammar      ... 文法添削
//   word-example ... 単語の例文生成
//   scenario     ... シナリオ会話練習
//   general      ... 自由質問
//
// AI スタイル:
//   xml        ... Claude (構造化タグ)
//   instructed ... Gemini (番号付き手順)
//   role       ... ChatGPT (ロール指定)
//   simple     ... Copilot (短く明確)
//   concise    ... Ollama  (最小限の指示)
// =====================================================================

import { getProvider } from './ai-providers.js';

const LANG_LABEL = {
  en: 'English',
  vi: 'Vietnamese (Hanoi dialect)',
};

const VI_DIACRITICS = /[ạằẵặẳằẵấầẩẫậắằẳẵặéẹẻẽêếềểễệíỉĩịòỏõọôốồổỗộơờớởỡợùủũụưứừửữựýỳỹỵỷđĂÂÊÔƠƯĐ]/;

export function detectLanguage(text) {
  return VI_DIACRITICS.test(text) ? 'vi' : 'en';
}

// ---------- ディスパッチ ----------

export function buildPrompt(task, providerKey, params = {}) {
  const builder = BUILDERS[task];
  if (!builder) throw new Error(`Unknown task: ${task}`);

  const provider = getProvider(providerKey);
  return builder(provider.promptStyle, params).trim();
}

const BUILDERS = {
  grammar:             buildGrammar,
  'word-example':      buildWordExample,
  scenario:            buildScenario,
  general:             buildGeneral,
  'weakness-analysis': buildWeaknessAnalysis,
  'daily-advice':      buildDailyAdvice,
  'mistake-explain':   buildMistakeExplain,
  'task-suggestion':   buildTaskSuggestion,
};

// ---------- 文法添削 ----------

function buildGrammar(style, { text, language }) {
  const lang = LANG_LABEL[language] ?? language ?? 'the target language';

  switch (style) {
    case 'xml':
      return `<task>language_correction</task>
<target_language>${lang}</target_language>
<learner_native>Japanese</learner_native>
<input>
${text}
</input>
<instructions>
- 自然で正確な ${lang} に修正してください
- 修正前と修正後を併記してください
- 主な変更点を3つまで、日本語で簡潔に説明してください
- 学習者向けに、なぜ間違いだったかも触れてください
</instructions>`;

    case 'instructed':
      return `あなたは ${lang} の文法教師です。日本人の学習者を支援しています。

【添削対象】
${text}

【出力フォーマット】
1. 修正後の文章
2. 修正前と修正後の対比（行ごとに）
3. 主な変更点を3つまで、日本語で説明
4. 学習者へのワンポイント・アドバイス（1文）`;

    case 'role':
      return `You are an experienced ${lang} teacher helping a Japanese learner.

Task: Correct the following text and explain the changes in Japanese.

Text:
"""
${text}
"""

Please respond with:
- **Original**: the user's text
- **Corrected**: your improved version
- **Key changes** (in Japanese): up to 3 bullet points
- **Tip** (in Japanese): one short piece of advice for the learner`;

    case 'simple':
      return `${lang} の文章を添削してください。

原文:
${text}

修正版と、日本語で主な変更点（3つまで）と一言アドバイスを教えてください。`;

    case 'concise':
    default:
      return `${lang} 文章添削。

原文:
${text}

修正版＋日本語で短い解説（変更点3つ以内）を返してください。`;
  }
}

// ---------- 単語の例文生成 ----------

function buildWordExample(style, { word, meaning, language, level = 'A1' }) {
  const lang = LANG_LABEL[language] ?? language ?? 'the target language';

  switch (style) {
    case 'xml':
      return `<task>generate_examples</task>
<target_language>${lang}</target_language>
<level>${level}</level>
<word>${word}</word>
<japanese_meaning>${meaning}</japanese_meaning>
<instructions>
- ${level} レベルの例文を3つ生成してください
- 各例文に日本語訳を付けてください
- 日常会話で実際に使える自然な文にしてください
</instructions>`;

    case 'instructed':
      return `${lang} の単語「${word}」（意味: ${meaning}）について、${level} レベルの例文を3つ作ってください。

各例文に:
1. ${lang} の文
2. 日本語訳
3. 短い使用シーンの説明（1文）`;

    case 'role':
      return `You are a ${lang} teacher creating practice examples for a Japanese learner at ${level} level.

Word: "${word}" (meaning in Japanese: ${meaning})

Please provide 3 natural example sentences. For each:
- The sentence in ${lang}
- Japanese translation
- A short note in Japanese on when to use it`;

    case 'simple':
      return `${lang} の単語「${word}」（意味: ${meaning}）の例文を3つ、${level} レベルで作ってください。日本語訳付き。`;

    case 'concise':
    default:
      return `${lang} word: ${word} (Japanese: ${meaning})

3 example sentences at ${level} level with Japanese translations.`;
  }
}

// ---------- シナリオ会話練習 ----------

function buildScenario(style, { title, description, language, userInput }) {
  const lang = LANG_LABEL[language] ?? language ?? 'the target language';

  const userTurn = userInput
    ? `\n\n【学習者の発言】\n${userInput}\n\n上記の発言を自然な ${lang} に修正し、相手役として返答してください。`
    : `\n\n${lang} で会話を始めてください。学習者は日本人で初級〜中級です。`;

  switch (style) {
    case 'xml':
      return `<task>conversation_practice</task>
<scenario>
  <title>${title}</title>
  <description>${description}</description>
</scenario>
<target_language>${lang}</target_language>
<learner_native>Japanese</learner_native>
<instructions>
- ${lang} で自然なロールプレイを行ってください
- 学習者の発言があれば、まず軽く文法フィードバック → 自然な返答
- 各ターンに日本語の補助訳を併記してください
- A1-A2 レベルの語彙を中心に
</instructions>${userTurn}`;

    case 'instructed':
      return `あなたは ${lang} の会話パートナーです。

シナリオ: ${title}
状況: ${description}

ルール:
1. ${lang} で自然なロールプレイをする
2. 各発言に日本語訳を併記する
3. A1-A2 レベルの語彙を使う
4. 学習者の発言には軽く文法アドバイスを添える${userTurn}`;

    case 'role':
      return `You are a friendly ${lang} conversation partner for a Japanese beginner.

Scenario: ${title}
Context: ${description}

Rules:
- Stay in role and converse naturally in ${lang}
- Provide a Japanese translation under each of your lines
- Use A1-A2 level vocabulary
- If the learner makes a mistake, gently correct it before continuing${userTurn}`;

    case 'simple':
      return `${lang} の会話練習をお願いします。

シナリオ: ${title} (${description})
レベル: A1-A2
日本語訳も併記してください。${userTurn}`;

    case 'concise':
    default:
      return `${lang} roleplay. Scenario: ${title} — ${description}. Level: A1-A2. Provide JP translations.${userTurn}`;
  }
}

// ---------- 自由質問 ----------

function buildGeneral(style, { question, language }) {
  const lang = LANG_LABEL[language] ?? language ?? 'language learning';

  switch (style) {
    case 'xml':
      return `<task>language_question</task>
<topic>${lang}</topic>
<learner_native>Japanese</learner_native>
<question>
${question}
</question>
<instructions>日本語で、初心者にも分かりやすく丁寧に答えてください。例文があれば添えてください。</instructions>`;

    case 'instructed':
      return `${lang} 学習についての質問です。日本語で、初心者にも分かりやすく答えてください。

質問:
${question}

例文があれば添えてください。`;

    case 'role':
      return `You are a patient ${lang} teacher answering questions from a Japanese beginner. Reply in Japanese with clear examples when helpful.

Question:
${question}`;

    case 'simple':
      return `${lang} の質問: ${question}

日本語で分かりやすく答えてください。`;

    case 'concise':
    default:
      return `${lang} question (reply in Japanese):
${question}`;
  }
}

// ---------- 弱点分析 (Phase 3 / Step 24-1) ----------

function summarizeProfile(profile) {
  if (!profile) return '(プロファイル情報なし)';
  const lines = [];
  const t = profile.totals ?? {};
  lines.push(`期間: 直近 ${profile.periodDays ?? 7} 日`);
  lines.push(`間違い件数: ${t.mistakesAdded ?? 0} 件 (最重要 ${t.mistakesByPriority?.critical ?? 0} / 要復習 ${t.mistakesByPriority?.review ?? 0} / 注意 ${t.mistakesByPriority?.caution ?? 0})`);
  lines.push(`タスク完了率: ${t.tasksCompleted ?? 0} / ${t.tasksTotal ?? 0} (${t.taskCompletionRate != null ? Math.round(t.taskCompletionRate * 100) + '%' : '—'})`);
  if (profile.vocab) {
    lines.push(`単語: 学習中 ${profile.vocab.learning} / 復習 ${profile.vocab.review} / 習得 ${profile.vocab.mastered} / 期日超過 ${profile.vocab.dueCount}`);
  }
  if (profile.toeic) {
    lines.push(`TOEIC 予測: L ${profile.toeic.listening.score ?? '—'} / R ${profile.toeic.reading.score ?? '—'} / 合計 ${profile.toeic.total ?? '—'}`);
  }
  if (profile.weakBands?.length) {
    lines.push(`苦手スコア帯: ` + profile.weakBands.map((b) => `${b.section} ${b.band} (${Math.round(b.accuracy * 100)}%)`).join(', '));
  }
  if (profile.weakSources?.length) {
    lines.push(`間違いの多いカテゴリ: ${profile.weakSources.join(', ')}`);
  }
  return lines.join('\n');
}

function buildWeaknessAnalysis(style, { profile }) {
  const summary = summarizeProfile(profile);

  switch (style) {
    case 'xml':
      return `<task>weakness_analysis</task>
<learner_native>Japanese</learner_native>
<recent_stats>
${summary}
</recent_stats>
<instructions>
- 上記データから学習者の弱点を3つまで抽出してください
- 各弱点に「なぜそう言えるのか」(根拠) と「次に取るべき行動」(具体策) を添えてください
- 出力は日本語、簡潔に。各項目 2-3 文で
- ポジティブな点も最後に1つ挙げてください
</instructions>`;

    case 'instructed':
      return `日本人の外国語学習者の最近の活動データから、弱点と改善策を提案してください。

【データ】
${summary}

【出力】
1. 弱点1 — 根拠 — 次の行動
2. 弱点2 — 根拠 — 次の行動
3. 弱点3 — 根拠 — 次の行動
4. 良い点（励まし）`;

    case 'role':
      return `You are a study coach for a Japanese learner of English/Vietnamese.

Recent activity:
${summary}

Identify up to 3 weaknesses with evidence and a concrete next action for each. Reply in Japanese, concise (2-3 sentences each). End with one positive observation.`;

    case 'simple':
      return `学習データから弱点を3つ抽出してください。

${summary}

各弱点について「根拠」と「次の行動」を1文ずつ、最後に良い点を1つ。日本語で。`;

    case 'concise':
    default:
      return `学習データ:
${summary}

弱点 3 つ + 良い点 1 つを日本語で短く。`;
  }
}

// ---------- デイリー アドバイス (Phase 3 / Step 24-2) ----------

function buildDailyAdvice(style, { profile, todayCourse, todayLanguage, todayTaskLabels = [] }) {
  const summary = summarizeProfile(profile);
  const taskList = todayTaskLabels.length ? todayTaskLabels.map((l) => `・${l}`).join('\n') : '(未確定)';
  const courseLabel = ({ short: '15分', standard: '30分', long: '60分' })[todayCourse] ?? todayCourse;
  const langLabel = todayLanguage === 'vi' ? 'ベトナム語' : '英語';

  switch (style) {
    case 'xml':
      return `<task>daily_advice</task>
<learner_native>Japanese</learner_native>
<today_plan>
コース: ${courseLabel} / 学習言語: ${langLabel}
${taskList}
</today_plan>
<recent_stats>
${summary}
</recent_stats>
<instructions>
- 今日の学習を始める学習者への「ひとことアドバイス」を日本語で 3〜5 文で
- 直近の弱点 1 つに触れる
- 今日のタスク 1 つに具体的な助言
- 励ましのメッセージで締める
</instructions>`;

    case 'instructed':
      return `日本人学習者の今日の学習を励ますアドバイスを日本語で書いてください。

今日のプラン:
コース ${courseLabel} / 言語 ${langLabel}
${taskList}

最近の状況:
${summary}

3〜5 文で。弱点 1 つ + 今日のタスクへの助言 1 つ + 励まし。`;

    case 'role':
      return `You are a warm, motivating coach. Write a short Japanese encouragement (3-5 sentences) for a Japanese learner about to start today's session.

Today's plan: ${courseLabel}, ${langLabel}
${taskList}

Recent activity:
${summary}

Mention one weakness, give one specific tip for today, end with encouragement. All in Japanese.`;

    case 'simple':
      return `今日のひとことアドバイスを日本語で 3〜5 文。

プラン: ${courseLabel} / ${langLabel}
${taskList}

最近:
${summary}`;

    case 'concise':
    default:
      return `今日の励まし (日本語、3-5 文):
プラン: ${courseLabel} ${langLabel}
${taskList}
最近: ${summary}`;
  }
}

// ---------- 個別ミス解説 (Phase 3 / Step 24-5) ----------

function buildMistakeExplain(style, { mistake }) {
  const m = mistake ?? {};
  const s = m.snapshot ?? {};
  const head = `カテゴリ: ${m.source ?? '?'} / 言語: ${m.language ?? 'en'} / 間違い回数: ${m.occurrences ?? 1}`;

  let detail = '';
  if (m.source === 'vocab') {
    detail = `単語: ${s.word ?? m.refId}\n読み: ${s.reading ?? '—'}\n意味: ${s.meaning ?? '—'}\n例文: ${s.example ?? '—'}`;
  } else if (m.source === 'toeic-l' || m.source === 'toeic-r') {
    const choices = (s.choices ?? []).map((c, i) => `${String.fromCharCode(65 + i)}. ${c}`).join('\n');
    detail = `Part ${s.part ?? '?'}\n設問: ${s.question ?? '—'}\n選択肢:\n${choices}\n正解: ${String.fromCharCode(65 + (s.correctIdx ?? 0))} (${s.correctText ?? ''})\n選んだ答え: ${String.fromCharCode(65 + (s.chosenIdx ?? 0))} (${s.chosenText ?? ''})`;
  } else {
    detail = JSON.stringify(s, null, 2);
  }

  switch (style) {
    case 'xml':
      return `<task>mistake_explanation</task>
<learner_native>Japanese</learner_native>
<mistake>
${head}

${detail}
</mistake>
<instructions>
- なぜ間違えたかを日本語で 2-3 文で説明
- 正解を覚えるためのコツや関連する知識を 1 つ
- 似た問題を 1 つ提示 (同じパターンで練習できるもの)
</instructions>`;

    case 'instructed':
      return `次の間違いを日本語で解説してください。

${head}

${detail}

【出力】
1. なぜ間違えたか (2-3 文)
2. 覚えるコツ (1 文)
3. 類似問題を 1 つ`;

    case 'role':
      return `You are a tutor explaining a Japanese learner's mistake. Reply entirely in Japanese.

${head}

${detail}

Provide:
- Why this mistake happened (2-3 sentences)
- A memorization tip (1 sentence)
- One similar practice question`;

    case 'simple':
      return `この間違いを日本語で解説:
${head}

${detail}

なぜ間違えたか + 覚えるコツ + 類似問題 1 つ。`;

    case 'concise':
    default:
      return `間違い解説 (日本語):
${detail}
理由 + コツ + 類題 1 つ。`;
  }
}

// ---------- 適応的タスク提案 (Phase 3 / Step 24-3 補助) ----------

function buildTaskSuggestion(style, { profile, course, language }) {
  const summary = summarizeProfile(profile);
  const courseLabel = ({ short: '15分', standard: '30分', long: '60分' })[course] ?? course;
  const langLabel = language === 'vi' ? 'ベトナム語' : '英語';

  switch (style) {
    case 'xml':
      return `<task>task_plan_suggestion</task>
<course>${courseLabel}</course>
<language>${langLabel}</language>
<recent_stats>
${summary}
</recent_stats>
<instructions>
- 今日のおすすめタスク構成を日本語で提案
- 弱点に基づいてバランスを調整
- 各タスクに目安時間と狙いを記載
- 5 タスク以内で
</instructions>`;

    case 'instructed':
      return `${courseLabel}・${langLabel} の学習プランを提案してください。

最近の状況:
${summary}

弱点を補うバランスで、5 タスク以内に絞って各タスクの「内容・目安時間・狙い」を日本語で。`;

    case 'role':
      return `You are a Japanese language tutor designing today's ${courseLabel} session in ${langLabel}.

Recent stats:
${summary}

Suggest up to 5 tasks (in Japanese) with duration and purpose, weighted to address the learner's weaknesses.`;

    case 'simple':
      return `${courseLabel} ${langLabel} のタスク 5 個以内、日本語で提案。
${summary}`;

    case 'concise':
    default:
      return `今日の ${courseLabel}/${langLabel} タスク提案 5 個まで:
${summary}`;
  }
}
