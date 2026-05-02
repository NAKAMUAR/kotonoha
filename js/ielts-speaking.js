// =====================================================================
// 言の葉 / Kotonoha — IELTS Speaking モジュール
// Step 13: 10 トピックの問題提示 + AI 試験官による評価依頼
// =====================================================================

let topicsCache = null;

export async function loadIeltsTopics() {
  if (topicsCache) return topicsCache;
  try {
    const res = await fetch('./data/ielts-speaking.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    topicsCache = await res.json();
  } catch (err) {
    console.error('ielts speaking load failed:', err);
    topicsCache = [];
  }
  return topicsCache;
}

export async function getIeltsTopicById(id) {
  const all = await loadIeltsTopics();
  return all.find((t) => t.id === id) ?? null;
}

/**
 * AI 試験官への評価依頼プロンプトを生成。
 * 既存の AI プロバイダ（ai-providers.js / prompts.js）の延長として使う想定。
 */
export function buildIeltsEvalPrompt({ topic, partLabel, question, userAnswer }) {
  return `You are an experienced IELTS Speaking examiner. Evaluate the following response from a candidate.

Topic: ${topic}
Section: ${partLabel}
Question / Cue card: ${question}

Candidate's answer:
"""
${userAnswer}
"""

Provide your evaluation in this exact format (in Japanese):

## バンドスコア (0-9)
- Fluency & Coherence: X.X
- Lexical Resource: X.X
- Grammar Range & Accuracy: X.X
- Pronunciation: 音声情報なしのため評価対象外
- 総合: X.X

## 良かった点
- (2-3 points, in Japanese)

## 改善点
- (2-3 specific suggestions, in Japanese, with example phrases)

## 模範解答例 (1 短い段落)
(One-paragraph model answer in English, B2-C1 level)`;
}
