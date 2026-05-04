# SPEC_DAILY_REVIEW.md
## デイリータスク + 復習機能（Step 22-25）

> **対象アプリ**: 言の葉 / Kotonoha (PWA)
> **前提**: Step 1-9 + Phase B-1 (TOEIC + ベトナム語検定3級) 完成済み (v0.14.1)
> **作成日**: 2026-05-04
> **作成方針**: プロンプトの要件を、現行コードベースの実装パターンに合わせて具体化したもの。

---

## 0. 設計原則

### 0.1 既存資産を最大限に流用する
- **SRS (`js/srs.js`)** — 単語復習で実証済みの SM-2 をそのまま利用。間違いの優先度判定にも応用。
- **IndexedDB + Firestore 二層** — `js/vocabulary.js` / `js/toeic-score.js` と同じ「IDB を真実、Firestore は同期先」パターンを踏襲。
- **AI プロバイダ (`js/ai-providers.js`)** — 5AI フォールバック / Ollama 直接 API は既にあるので、新規プロンプトを `js/prompts.js` に追加するだけで済ます。
- **TOEIC 回答ログ (`js/toeic-score.js`)** — 既に `recordAnswer()` で `correct/part/scoreLevel` を記録しているので、このフックに「間違いを `mistakes` ストアにも書く」処理を 1 行追加して再利用。

### 0.2 既存機能を絶対に壊さない
- 既存の `screen-*` セクション、`bottom-nav` ボタン、`app.js` の状態管理を**追加方式**で拡張する（既存 ID/関数の rename 禁止）。
- 既存 IndexedDB スキーマは変更しない。新規ストアは別 DB か、`DB_VERSION` を上げて `onupgradeneeded` で追加。
- Firestore のコレクション構造も既存 `users/{uid}/srs/{wordId}` には触れず、サブコレクションを追加する形で拡張。

### 0.3 段階リリース
各 Phase ごとに「動作確認用の手順」を提示して、ユーザー承認を得てから次の Phase に進む。
仕様書全体を一度に実装するのではなく、Phase 1 → ユーザー確認 → Phase 2 …の順。

---

## 1. データ構造

### 1.1 Firestore スキーマ（新規追加分のみ）

```
users/{uid}/
  ├── (既存) profile, progress, settings
  ├── (既存) srs/{wordId}                   ← 単語 SRS
  ├── (新規) dailyTasks/{YYYY-MM-DD}        ← 今日のタスクリスト
  ├── (新規) mistakes/{mistakeId}            ← 間違いプール
  ├── (新規) reviewItems/{itemId}            ← 集中復習用キュー
  ├── (新規) stats/{periodId}                ← 統計サマリ (week/month)
  ├── (新規) badges/{badgeId}                ← 獲得バッジ
  └── (新規) dailySettings (single doc)     ← コース・言語設定
```

### 1.2 ドキュメントスキーマ詳細

#### `dailyTasks/{YYYY-MM-DD}`
```js
{
  date:           '2026-05-04',
  course:         'standard',          // 'short' | 'standard' | 'long' (15/30/60 分)
  language:       'en',                // 'en' | 'vi'
  generatedAt:    Timestamp,
  tasks: [
    {
      id:           'task-1',
      type:         'vocab',           // 'vocab'|'scenario'|'toeic-l'|'toeic-r'|'ielts-s'|'ielts-w'|'review'|'grammar'
      label:        '単語復習 20 語',
      target:       { deck: 'daily', count: 20 },
      estimatedMin: 5,
      completed:    false,
      completedAt:  null,
      result:       null,              // { correct: 18, total: 20 } 等
    },
    ...
  ],
  totalMin:       30,
  completedMin:   0,
  allCompleted:   false,
}
```

#### `mistakes/{mistakeId}`
```js
{
  id:           'mistake-{timestamp}-{rand}',
  source:       'vocab' | 'toeic-l' | 'toeic-r' | 'ielts-s' | 'ielts-w' | 'scenario',
  refId:        'word-123' | 'tl-q-045' | 'tr-q-022' | ...,
  language:     'en' | 'vi',
  snapshot: {                          // 復習時に必要な最小情報
    question:   '...',
    correct:    '...',
    yourAnswer: '...',
    explanation:'...',
    tags:       ['part-5', 'score-730', 'grammar'],
  },
  priority:     'critical' | 'review' | 'caution',  // 自動算出
  occurrences:  1,                     // 同じ refId で間違えた回数
  firstWrongAt: Timestamp,
  lastWrongAt:  Timestamp,
  reviewedAt:   null | Timestamp,
  resolvedAt:   null,                  // 連続 2 回正解で resolved に
  srs:          { ...SRS state },      // SM-2 を流用して優先度を更新
}
```

**優先度の自動判定** (1 回計算 → 保存):
- `critical` (最重要): `occurrences >= 3` または直近 7 日以内に 2 回以上間違い
- `review` (要復習): `occurrences == 2` または直近 14 日以内
- `caution` (注意): `occurrences == 1` かつそれ以前

#### `reviewItems/{itemId}` (集中復習モード用キュー)
- `mistakes` から「今日復習すべき」ものを抽出した派生リスト。
- セッション開始時に作って、終了時に消す（一時的）。Firestore に置く理由は端末間連続性。

#### `stats/{periodId}` (例: `2026-W18`, `2026-05`)
```js
{
  periodId:    '2026-W18',
  type:        'week' | 'month',
  startDate:   '2026-04-27',
  endDate:     '2026-05-03',
  daysActive:  6,
  totalMin:    180,
  byCategory:  { vocab: 60, toeic: 80, ielts: 30, scenario: 10 },
  accuracy:    { overall: 0.78, vocab: 0.85, toeic: 0.72, ielts: 0.80 },
  mistakesAdded:    24,
  mistakesResolved: 18,
}
```

#### `badges/{badgeId}`
```js
{
  id:        '7day-streak',
  name:      '七日連続',
  iconChar:  '七',                // 1 文字漢字（既存の和テイストに合わせる）
  earnedAt:  Timestamp,
  category:  'streak' | 'volume' | 'mastery' | 'speed',
  level:     1 | 2 | 3,
}
```

#### `dailySettings` (固定 doc id `current`)
```js
{
  defaultCourse:    'standard',         // 起動時のデフォルトコース
  languageMode:     'rotate' | 'pick' | 'fixed',
  fixedLanguage:    'en',               // mode == 'fixed' のとき
  rotation:         ['en', 'vi'],       // mode == 'rotate' のとき日替わり
  notifyTime:       '21:00',            // 将来の通知用（今は記録のみ）
  weeklyGoalMin:    180,
}
```

### 1.3 IndexedDB スキーマ

オフライン優先のため、すべて IndexedDB をミラーで持つ。
- 既存 `kotonoha` DB (`vocabulary`, `srs`) はそのまま、`DB_VERSION` を 1 → 2 に上げて以下を追加:
  - `dailyTasks` (keyPath: `date`)
  - `mistakes` (keyPath: `id`, indexes: `priority`, `source`, `language`, `nextReviewDate`)
  - `badges` (keyPath: `id`)
  - `dailySettings` (keyPath: `key`, single row `key='current'`)
- `kotonoha-toeic` DB はそのまま流用。

---

## 2. UI 設計

### 2.1 ボトムナビ拡張

```
[家ホーム] [日デイリー] [単単語] [復復習] [統統計]
```
（既存の「会話 / 添削」はホーム画面のカード経由にして、ナビからは外す。再アクセス容易性は確保。）

代替案: ナビは 5 つに増やしつつ既存「単・会・添」を残し「日 / 復 / 統」を新規追加 → 7 タブは多すぎるので **5 タブに整理**。
- 家(ホーム) / 日(デイリー) / 単(単語) / 復(復習) / 統(統計)

### 2.2 新規スクリーン

#### `screen-daily` — デイリータスク画面
```
┌─────────────────────────────────┐
│ 本日の学習     [☰ コース選択]   │  ← course chips: 短15分 / 中30分 / 長60分
│                                 │
│ ┌─ 進捗バー ─────── 60% ──┐    │
│ │ ████████████░░░░░       │    │
│ │ 18 / 30 分 完了          │    │
│ └─────────────────────────┘    │
│                                 │
│ 言語: 🇬🇧 English  [切替]       │  ← 日替わり/選択/固定の indicator
│                                 │
│ □ 単語復習 20 語         5 分   │
│ ✓ TOEIC L Part 2 × 5     8 分   │
│ □ 会話練習: 空港        10 分   │
│ □ ライティング (Task 2)  7 分   │
│                                 │
│ [今日のアドバイス（AI）] ⓘ    │
└─────────────────────────────────┘
```

#### `screen-review` — 復習タブ
```
┌─────────────────────────────────┐
│ 復習                            │
│ [全 42] [最重要 5] [要復習 12] │ ← フィルタ chips
│ [注意 25]                       │
│                                 │
│ ┌──── 集中復習を始める ─────┐  │
│ │ 最重要 5 問を 5 分で      │  │
│ └───────────────────────────┘  │
│                                 │
│ ── 個別に復習 ──                │
│ ⚠ TOEIC R Part 5 #023          │
│   "He ___ the report."          │
│   3 回間違い · 最終 5/2         │
│                                 │
│ ⚠ 単語: ambiguous               │
│   2 回間違い · 最終 5/3         │
└─────────────────────────────────┘
```

#### `screen-stats` — 統計画面
```
┌─────────────────────────────────┐
│ 統計                            │
│ [今週] [今月] [全期間]          │
│                                 │
│ ┌─ 連続学習日数 ──────┐          │
│ │      七 日           │ ← バッジ表示
│ └─────────────────────┘          │
│                                 │
│ 学習時間（分）                  │
│ ┌──────────────────────┐         │
│ │ ▁▃▅▂▆▇▄  ← 7 日 bar  │         │
│ └──────────────────────┘         │
│                                 │
│ 正答率                          │
│ 単語     ████████░░ 85%         │
│ TOEIC    ███████░░░ 72%         │
│ IELTS    ████████░░ 80%         │
│                                 │
│ ── 獲得バッジ ──                │
│ [七] [百] [達] [読]              │
└─────────────────────────────────┘
```

### 2.3 ホーム画面のリニューアル
- ヘッダーに「今日の達成」サマリ (◯/◯ 分・連続日数・残り復習数) を追加。
- 「日常 / TOEIC / IELTS」セクションは保持しつつ、最上部に「本日のタスクを始める」CTA カードを追加。

### 2.4 デザイン原則（既存準拠）
- **色**: `--shu` (#c5382b) アクセント、`--washi-light` 背景、`--koke` 完了色。
- **フォント**: 見出しは Shippori Mincho、数字は Cormorant Garamond、ナビアイコンは漢字 1 文字。
- **アイコン**: 絵文字を避け、漢字 1 文字 (`日`, `復`, `統`, `達`, `七` 等)。バッジは特に和テイスト重視。

---

## 3. Phase 別実装計画

### Phase 1 — Step 22: デイリータスク基本機能

| ID  | タスク                          | 主な変更ファイル                                      |
| --- | ------------------------------- | ----------------------------------------------------- |
| 22-1 | コース選択 UI（15/30/60 分）    | `index.html` (新スクリーン), `styles.css`             |
| 22-2 | タスク自動生成                  | `js/daily-tasks.js` (新規), `data/task-templates.json` (新規) |
| 22-3 | 完了管理                        | `js/daily-tasks.js`, `js/app.js`                      |
| 22-4 | 進捗表示                        | `js/app.js` (renderDaily), `styles.css`               |
| 22-5 | 言語切替（日替り/選択/固定）   | `js/daily-settings.js` (新規)                         |

#### 22-2 タスク自動生成ロジック
- **コース別の合計時間**: short=15, standard=30, long=60 分。
- **比率テンプレート** (デフォルト):
  - 単語復習 30%、会話/シナリオ 20%、TOEIC L+R 30%、IELTS 10%、復習 10%
  - 復習タスクが 0 件の日は単語 / TOEIC に按分
- **生成タイミング**: その日初めて画面を開いたとき (or ユーザーが「今日のタスクを再生成」を押したとき)。`dailyTasks/{YYYY-MM-DD}` が無ければ生成。
- **再現性**: 生成は決定的（日付 + uid を seed にして shuffle）。同じ日に再ロードしても同じ並び。

#### 22-5 言語切替モード
- `rotate`: 月水金=en、火木土日=vi のように `dailySettings.rotation` に従う。
- `pick`: 毎朝デイリー画面で chips から選ぶ (前回選択を記憶)。
- `fixed`: 常に `fixedLanguage`。

### Phase 2 — Step 23: 復習システム

| ID  | タスク                  | 主な変更ファイル                                                              |
| --- | ----------------------- | ----------------------------------------------------------------------------- |
| 23-1 | 間違い自動記録          | `js/mistakes.js` (新規), `js/toeic-score.js` (recordAnswer に hook), `js/app.js` (vocab/ielts hook) |
| 23-2 | 優先度システム (3 段階) | `js/mistakes.js` (priorityOf 関数)                                            |
| 23-3 | 復習タブ UI             | `index.html` (新スクリーン), `styles.css`                                     |
| 23-4 | 集中復習モード          | `js/review-session.js` (新規)                                                 |
| 23-5 | 既存機能との統合        | TOEIC L/R, IELTS S/W, 単語の「間違えた」イベントを `mistakes.recordMistake()` で吸収 |

#### 23-1 記録フック
- TOEIC: `js/toeic-score.js#recordAnswer()` で `correct === false` のとき `mistakes.recordMistake({ source:'toeic-l'|'toeic-r', refId: questionId, ... })` を呼ぶ。
- 単語: `js/vocabulary.js#rateWord()` で `quality === 2 (HARD)` のとき同様に記録。
- IELTS: AI 評価結果を保存する箇所が無いので、当面はユーザーが「これは間違いだった」と手動マークできるボタンを追加 (Phase 3 で AI 自動判定に拡張)。
- シナリオ: AI ロールプレイには「正解」が無いので Phase 1-2 の対象外。

#### 23-4 集中復習モード
- `mistakes` から優先度順に N 件抽出 → 単語ならフラッシュカード、TOEIC なら設問再表示、で順に表示。
- 連続 2 回正解で `resolvedAt` を立てて mistakes プールから外す（IDB レベルで delete）。
- セッション中の SRS 更新は既存 `applySrs()` を流用。

### Phase 3 — Step 24: AI 連携

| ID  | タスク              | 主な変更ファイル                                              |
| --- | ------------------- | ------------------------------------------------------------- |
| 24-1 | 弱点分析            | `js/prompts.js` (weakness-analysis テンプレート追加)          |
| 24-2 | アドバイス生成      | `js/daily-advice.js` (新規)                                   |
| 24-3 | 適応的タスク生成    | `js/daily-tasks.js` (アドバイス結果でテンプレート比率を調整)  |
| 24-4 | パーソナライゼーション | `js/personalization.js` (新規) — ユーザーの履歴から目標予測 |

#### 24-1 弱点分析プロンプト概要
- 入力: 直近 7 日の `mistakes` サマリ（カテゴリ別件数、頻出タグ、TOEIC band 別正答率）
- 出力: 「リスニング Part 3 のスコア帯 730 が苦手」「単語の learning ステータスが滞留」等の自然文 + 推奨タスク (JSON ブロック)
- AI: 既存 `launchProvider()` でクラウドへ流すか、Ollama がある場合は `callOllama()` で自動取得

### Phase 4 — Step 25: 視覚化

| ID  | タスク       | 主な変更ファイル                                       |
| --- | ------------ | ------------------------------------------------------ |
| 25-1 | 統計画面     | `index.html` (新スクリーン), `js/stats.js` (新規)      |
| 25-2 | グラフ表示   | `js/charts.js` (新規, SVG inline で軽量実装)           |
| 25-3 | バッジシステム | `js/badges.js` (新規), `data/badges.json` (新規)       |
| 25-4 | レベルアップ | `js/badges.js` (累計学習時間でレベル昇格)              |

#### 25-2 グラフは SVG 自前実装で軽量化
Chart.js 等の追加依存は避け、既存の Tailwind + SVG で 7 日棒グラフ・正答率横棒・累計線グラフ程度を自作。

#### 25-3 バッジ一覧（初期）
| ID | 名 | 条件 |
|----|----|------|
| `3day-streak` | 三 | 3 日連続 |
| `7day-streak` | 七 | 7 日連続 |
| `30day-streak` | 卅 | 30 日連続 |
| `100words` | 百 | 累計 100 語 mastered |
| `500words` | 五 | 累計 500 語 mastered |
| `toeic-600` | 六 | 予測スコア 600 達成 |
| `toeic-730` | 七 | 予測スコア 730 達成 |
| `vi-3kyu-50` | 越 | ベトナム語検定3級 50 語 mastered |
| `ielts-first-write` | 作 | IELTS Writing 初投稿 |
| `mistake-master` | 復 | 間違い 50 件 resolved |

---

## 4. AI プロバイダ統合

既存 `js/ai-providers.js` の 5AI フォールバックを使い、以下の新規プロンプトタスクを `js/prompts.js` に追加:

| タスク                | 用途                                   |
| --------------------- | -------------------------------------- |
| `weakness-analysis`   | 直近 7 日の mistakes から弱点を抽出    |
| `daily-advice`        | 今日のタスクに対する一言アドバイス     |
| `mistake-explain`     | 個別の間違いの解説 (オンデマンド)      |
| `task-suggestion`     | 適応的タスク調整の根拠提示             |

Ollama が利用可能なら `callOllama()` でストリーミング表示、無ければ既存の「コピー → 新タブで AI を開く」フローにフォールバック。

---

## 5. データ同期方針

- **書き込み**: ローカル IndexedDB → 即時、Firestore → best-effort で並行 (既存 `syncSrsToFirestore` パターン踏襲、失敗時は `console.warn` のみ)。
- **読み込み**: ログイン直後に Firestore → IDB へ pull (`pullSrsFromFirestore` と同じ方式の `pullDailyData`, `pullMistakes`)。以降は IDB から読む。
- **競合解決**: 同じ key に対する更新は「`lastReviewedAt` が新しい方が勝ち」（vocab と同じ）。

---

## 6. 既存機能との整合チェックリスト

実装中に必ず確認:
- [ ] ボトムナビ 5 タブ化で既存「会話 / 添削」アクセスがホームから残っているか
- [ ] `DB_VERSION 1 → 2` への upgrade で既存データ (vocabulary/srs) が消えないか
- [ ] `recordAnswer()` への hook 追加で既存スコア予測が壊れないか
- [ ] サービスワーカー (`service-worker.js`) のキャッシュ対象に新規 JS / JSON を追加
- [ ] manifest.json の更新（バージョン文字列）

---

## 7. 段階確認プロトコル

各 Phase 完了時に以下を実行:
1. **完了報告**: 「Phase X 完了しました」+ 実装したファイル一覧
2. **動作確認手順**: ユーザーが iPhone / PC で試せる手順を箇条書き (e.g. 「1. ホーム画面下部の『日』タブを押す」「2. コース chip を『中 30 分』に変更」)
3. **既知の制約**: その Phase 時点で未実装の機能の明示
4. **次フェーズ確認**: 「次の Phase X+1 に進みますか？」

---

## 8. 非対応事項（明示的に Out of Scope）

- プッシュ通知（PWA notification API）— `notifyTime` フィールドだけ用意、実装は将来。
- バックエンド推論（自前 LLM ホスト）— Ollama ローカルで足りる範囲のみ。
- 課金 / Pro プラン分岐。
- データエクスポート / インポート（CSV）。

---

## 9. ファイル変更サマリ

```
新規:
  js/daily-tasks.js
  js/daily-settings.js
  js/daily-advice.js
  js/mistakes.js
  js/review-session.js
  js/personalization.js
  js/stats.js
  js/charts.js
  js/badges.js
  data/task-templates.json
  data/badges.json

変更:
  index.html              — 新規 3 スクリーン (daily/review/stats), ナビ更新, ホーム CTA
  styles.css              — 新スクリーン用スタイル
  js/app.js               — 新スクリーン import / 状態管理 / ナビ
  js/vocabulary.js        — DB_VERSION 2, mistakes hook
  js/toeic-score.js       — recordAnswer 内で mistakes hook
  js/prompts.js           — weakness/advice/mistake-explain プロンプト追加
  js/firebase-init.js     — dailySettings/mistakes/badges 用の helpers
  service-worker.js       — キャッシュリスト更新, バージョン bump
  manifest.json           — バージョン bump
```

おおむね追加ファイル 11、変更ファイル 8 程度の規模。既存の screen 増設 + IDB DB_VERSION upgrade パターンに沿うため、リスクは限定的。
