// =====================================================================
// 言の葉 / Kotonoha — IELTS Writing モジュール
// Step 14: Task 1 / Task 2 のプロンプト提示と AI 添削依頼
// =====================================================================

let promptsCache = null;

export async function loadIeltsWritingPrompts() {
  if (promptsCache) return promptsCache;
  try {
    const res = await fetch('./data/ielts-writing.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    promptsCache = await res.json();
  } catch (err) {
    console.error('ielts writing load failed:', err);
    promptsCache = [];
  }
  return promptsCache;
}

export async function getIeltsWritingById(id) {
  const all = await loadIeltsWritingPrompts();
  return all.find((p) => p.id === id) ?? null;
}

/**
 * AI 添削プロンプトを生成。Task 1 と Task 2 で評価軸が変わる。
 */
export function buildIeltsWritingEvalPrompt({ task, type, prompt, userText, imageDescriptionJa }) {
  const taskAchievementLabel = task === 1 ? 'Task Achievement' : 'Task Response';
  const visualNote = task === 1 && imageDescriptionJa
    ? `\n\nなお、Task 1 のグラフ/図は次のような内容です（受験者は実際の図を見ています）:\n${imageDescriptionJa}`
    : '';

  return `You are an experienced IELTS Writing examiner. Evaluate the candidate's Task ${task} response below.

Task type: ${type}
Prompt:
"""
${prompt}
"""${visualNote}

Candidate's writing:
"""
${userText}
"""

Provide your evaluation in this exact format (in Japanese):

## バンドスコア (0-9)
- ${taskAchievementLabel}: X.X
- Coherence and Cohesion: X.X
- Lexical Resource: X.X
- Grammatical Range and Accuracy: X.X
- 総合: X.X

## 良かった点
- (2-3 specific points referring to the candidate's text)

## 改善が必要な箇所
- (3-5 specific issues, with quoted phrases from the candidate's writing and corrections)

## 語彙・表現の改善提案
- (3-5 better word/phrase choices, with native-level alternatives)

## 文法エラーの指摘
- (List specific grammar errors with corrections)

## 模範解答例 (1 段落、Band 7-8 レベル)
(Write a model paragraph in English at Band 7-8 level)`;
}

/** 簡易ワードカウント（半角空白区切り） */
export function countWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).filter(Boolean).length;
}
