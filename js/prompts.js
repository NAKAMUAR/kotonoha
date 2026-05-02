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
  grammar:        buildGrammar,
  'word-example': buildWordExample,
  scenario:       buildScenario,
  general:        buildGeneral,
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
