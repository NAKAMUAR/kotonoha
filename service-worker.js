// =====================================================================
// 言の葉 / Kotonoha — Service Worker
// Step 7: PWA オフラインキャッシュ
//
// 戦略:
//   ・同一オリジンの静的アセット → cache-first（オフライン継続可）
//   ・Google Fonts (gstatic) → stale-while-revalidate
//   ・Firebase / Firestore / Ollama 等の動的 API → バイパス（SW 介入なし）
//
// バージョンを上げると古いキャッシュは activate 時に削除される。
// =====================================================================

const VERSION = 'kotonoha-v0.18.0';
const STATIC_CACHE = `${VERSION}-static`;
const RUNTIME_CACHE = `${VERSION}-runtime`;

const PRECACHE = [
  './',
  './index.html',
  './styles.css',
  './manifest.json',
  './firebase-config.js',
  './js/app.js',
  './js/firebase-init.js',
  './js/vocabulary.js',
  './js/srs.js',
  './js/ai-providers.js',
  './js/prompts.js',
  './js/scenarios.js',
  './js/toeic-listening.js',
  './js/toeic-reading.js',
  './js/toeic-score.js',
  './js/ielts-speaking.js',
  './js/ielts-writing.js',
  './js/daily-settings.js',
  './js/daily-tasks.js',
  './js/mistakes.js',
  './js/personalization.js',
  './js/daily-advice.js',
  './js/stats.js',
  './js/charts.js',
  './js/badges.js',
  './data/badges.json',
  './data/vocabulary-en.json',
  './data/vocabulary-vi.json',
  './data/vocabulary-toeic.json',
  './data/vocabulary-vi-3kyu.json',
  './data/scenarios.json',
  './data/toeic-listening.json',
  './data/toeic-reading.json',
  './data/ielts-speaking.json',
  './data/ielts-writing.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

// SW 介入をバイパスすべきホスト（動的 API）
const BYPASS_HOSTS = [
  'firebaseapp.com',
  'firebase.com',
  'firebaseio.com',
  'googleapis.com',
  'identitytoolkit.googleapis.com',
  'firestore.googleapis.com',
  'accounts.google.com',
];

// ---------- install ----------

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(STATIC_CACHE);
    // 個別に try/catch — 1 ファイル失敗でも全体を止めない
    await Promise.all(
      PRECACHE.map(async (url) => {
        try { await cache.add(url); }
        catch (err) { console.warn('[SW] precache failed:', url, err); }
      })
    );
    self.skipWaiting();
  })());
});

// ---------- activate ----------

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => !k.startsWith(VERSION)).map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

// ---------- fetch ----------

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Ollama は常にネットワーク（介入しない）
  if (url.hostname === 'localhost' && url.port === '11434') return;
  if (url.hostname === '127.0.0.1' && url.port === '11434') return;

  // 動的 API（Firebase 等）はバイパス
  if (BYPASS_HOSTS.some((h) => url.hostname.endsWith(h))) return;

  // 同一オリジン → cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // gstatic / 外部 CDN → stale-while-revalidate
  if (url.hostname.includes('gstatic.com') ||
      url.hostname.includes('googleapis.com') ||
      url.hostname === 'cdn.tailwindcss.com' ||
      url.hostname === 'fonts.googleapis.com' ||
      url.hostname === 'fonts.gstatic.com') {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // それ以外は介入しない
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  try {
    const response = await fetch(request);
    if (response.ok && response.type === 'basic') {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    // ナビゲーションのオフラインフォールバック
    if (request.mode === 'navigate') {
      const fallback = await caches.match('./index.html');
      if (fallback) return fallback;
    }
    throw err;
  }
}

async function staleWhileRevalidate(request) {
  const cached = await caches.match(request);
  const fetchPromise = fetch(request).then((response) => {
    if (response.ok) {
      caches.open(RUNTIME_CACHE).then((c) => c.put(request, response.clone())).catch(() => {});
    }
    return response;
  }).catch(() => null);
  return cached || (await fetchPromise) || Response.error();
}

// ---------- メッセージ（クライアントから skipWaiting 等） ----------

self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
