// =====================================================================
// 言の葉 / Kotonoha — パラメータ最適化ワーカー
//
// 最適化は復習数によっては数十秒かかる。メインスレッドで回すと
// その間 UI が完全に固まるため、Worker に逃がして進捗だけ返す。
//
// プロトコル:
//   ← { type: 'start', logs: [...], options: {...} }
//   → { type: 'progress', iteration, total, logLoss }
//   → { type: 'done', result }
//   → { type: 'error', message }
// =====================================================================

import { optimizeFromLogs } from './fsrs-optimizer.js';

self.onmessage = (e) => {
  const msg = e.data;
  if (!msg || msg.type !== 'start') return;

  try {
    let lastPost = 0;
    const result = optimizeFromLogs(msg.logs ?? [], msg.options ?? {}, (p) => {
      // 進捗は 200ms に 1 回で十分。毎反復送ると postMessage 自体が重い。
      const now = Date.now();
      if (now - lastPost < 200 && p.iteration !== p.total) return;
      lastPost = now;
      self.postMessage({ type: 'progress', ...p });
    });
    self.postMessage({ type: 'done', result });
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message ?? String(err) });
  }
};
