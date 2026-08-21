# Kotonoha Project

## Next Steps

### 1. Firebase Setup (Required)
1. Visit https://console.firebase.google.com/
2. Create project: kotonoha-app
3. Register Web app
4. Paste config to firebase-config.js
5. Enable Google login in Authentication
6. Create Firestore Database

See SETUP_GUIDE.md for details

### 2. Place SPEC_v4.md and AUTO_BUILD_GUIDE.md
Place these files in this folder

### 3. Start Claude Code
Double-click start-claude.bat
Or run in PowerShell:
`
cd C:\Users\kein4\OneDrive\デスクトップ\kotonoha-app
claude
`

### 4. Copy implementation prompt
Copy the prompt from AUTO_BUILD_GUIDE.md Step 3.5

---

## 学習エンジン（v2 — FSRS-6）

単語帳の間隔反復を SM-2（1988年の SuperMemo）から **FSRS-6** へ移行しました。
同じ復習回数でより高い記憶保持率を得るための変更です。

### アルゴリズム

`js/fsrs.js` に DSR モデルを実装しています。

| 変数 | 意味 |
|---|---|
| **D** — Difficulty | その単語の覚えにくさ（1–10） |
| **S** — Stability | 想起率が 90% まで落ちるまでの日数 |
| **R** — Retrievability | 今この瞬間に思い出せる推定確率 |

SM-2 は「間隔 × ease」の乗算だけで忘却曲線を持たず、復習が遅れた／早すぎた
情報を捨てていました。FSRS は経過日数から R を推定し、**R が目標記憶率まで
落ちる日**を次回復習日とします。遅れた復習が記憶をより強化する効果
（spacing effect）も係数に取り込まれます。

### 導入した仕組み

1. **4 段階評価** — 「もう一度 / 難しい / 普通 / 簡単」。
   3 段階では「思い出せなかった」と「苦しかったが思い出せた」を区別できず、
   両者が同じラプス扱いになっていました。
2. **学習ステップ**（1分 → 10分）— 初回学習日に当日中に複数回想起させて定着させる。
3. **再学習ステップ**（10分）— 忘れた単語は当日中に立て直してから間隔を再開する。
4. **想起率順の出題** — 期日順ではなく「最も忘れかけている単語」から出す。
5. **1 日の上限**（新規 20 / 復習 150）— 復習の雪崩を防ぎ、継続率を上げる。
6. **交互出題（インターリービング）** — 新規と復習を混ぜて長期保持を上げる。
7. **リーチ検出** — 8 回以上忘れた単語を隔離候補として通知する。
8. **目標記憶率の可変化** — 80 / 85 / 90 / 95% から選択。復習量とのトレードオフを学習者が決められる。
9. **間隔プレビュー** — 各ボタンに次回出題時期を表示（メタ認知支援）。
10. **キーボード操作** — `1`–`4` で評価、`Space` で裏返し。
11. **復習ログ記録** — IndexedDB `reviewLog` に生ログを蓄積。将来の FSRS パラメータ個人最適化に使えます。

### 既存データの移行

旧 SM-2 の状態は読み出し時に自動変換されます（破壊的変更なし）。

- `interval`（日） → 安定度 S の初期値
- `easeFactor` → 難易度 D へ反転写像（EF 2.5 → D 3.5 / EF 1.3 → D 10）

IndexedDB は v1 → v2 へ自動アップグレードし、`reviewLog` と `settings` ストアを追加します。

### ファイル構成

| ファイル | 役割 |
|---|---|
| `js/fsrs.js` | FSRS-6 コア（忘却曲線・メモリ状態更新・間隔算出） |
| `js/srs.js` | スケジューラ（学習ステップ・リーチ・SM-2 移行） |
| `js/vocabulary.js` | 学習キュー・上限制御・復習ログ・設定同期 |
