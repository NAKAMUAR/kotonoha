// =====================================================================
// 言の葉 / Kotonoha — AI プロバイダ定義
// Step 4: 5 AI 自動フォールバック
//
// 各プロバイダは「URL を新タブで開く」ことを基本とし、
// プロンプトはクリップボードに事前コピーしておく方式。
// =====================================================================

export const PROVIDERS = Object.freeze({
  claude: {
    key:         'claude',
    name:        'Claude',
    url:         'https://claude.ai/new',
    accent:      '#cc9b7a',
    description: 'Anthropic Claude — XML 風の構造化プロンプトに最適',
    promptStyle: 'xml',
    priority:    1,
  },
  gemini: {
    key:         'gemini',
    name:        'Gemini',
    url:         'https://gemini.google.com/app',
    accent:      '#4285f4',
    description: 'Google Gemini — 番号付き手順に最適',
    promptStyle: 'instructed',
    priority:    2,
  },
  chatgpt: {
    key:         'chatgpt',
    name:        'ChatGPT',
    url:         'https://chatgpt.com/',
    accent:      '#10a37f',
    description: 'OpenAI ChatGPT — ロール指定型に最適',
    promptStyle: 'role',
    priority:    3,
  },
  copilot: {
    key:         'copilot',
    name:        'Copilot',
    url:         'https://copilot.microsoft.com/',
    accent:      '#0078d4',
    description: 'Microsoft Copilot — シンプルな指示に最適',
    promptStyle: 'simple',
    priority:    4,
  },
  ollama: {
    key:         'ollama',
    name:        'Ollama',
    url:         'http://localhost:11434',
    apiUrl:      'http://localhost:11434/api/chat',
    model:       'qwen2.5:7b',
    accent:      '#3a3a3a',
    description: 'ローカル Ollama — 簡潔な指示に最適（直接 API 呼び出し）',
    promptStyle: 'concise',
    priority:    5,
    local:       true,
  },
});

export const PROVIDER_ORDER = ['claude', 'gemini', 'chatgpt', 'copilot', 'ollama'];

export function getProvider(key) {
  return PROVIDERS[key] ?? PROVIDERS.claude;
}

// ---------- クリップボード ----------

export async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Fallback: 一時 textarea 経由
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity  = '0';
  document.body.appendChild(ta);
  ta.select();
  try {
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch (err) {
    document.body.removeChild(ta);
    throw err;
  }
}

// ---------- 起動 ----------

/**
 * プロンプトをコピーして AI を新タブで開く（クラウド AI 用）。
 * Ollama はこの関数ではなく callOllama() を直接呼び出す。
 * 戻り値: { provider, copied: boolean, opened: boolean }
 */
export async function launchProvider(providerKey, prompt) {
  const provider = getProvider(providerKey);

  let copied = false;
  try {
    copied = await copyToClipboard(prompt);
  } catch (err) {
    console.warn('clipboard write failed:', err);
  }

  return { provider, copied, opened: openTab(provider.url) };
}

function openTab(url) {
  const win = window.open(url, '_blank', 'noopener,noreferrer');
  return !!win;
}

// ---------- Ollama 直接 API ----------

/**
 * Ollama の /api/chat にストリーミング POST。
 * onToken(chunk) でトークンごとにコールバック。
 *
 * 必要なセットアップ:
 *   ・ollama serve が稼働
 *   ・OLLAMA_ORIGINS に http://localhost:8000 等を含む
 *   ・モデル（例: qwen2.5:7b）が pull 済み
 */
export async function callOllama(prompt, { model, onToken, signal } = {}) {
  const provider = PROVIDERS.ollama;
  const useModel = model ?? provider.model;

  let res;
  try {
    res = await fetch(provider.apiUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({
        model:    useModel,
        messages: [{ role: 'user', content: prompt }],
        stream:   true,
      }),
      signal,
    });
  } catch (err) {
    throw new Error(
      `Ollama に接続できません: ${err.message}\n` +
      `・Ollama は起動していますか？ (http://localhost:11434)\n` +
      `・OLLAMA_ORIGINS にこのオリジンが含まれていますか？`
    );
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama API エラー (${res.status}): ${body}`);
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let full = '';
  let buf  = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    // NDJSON: 1 行 = 1 JSON
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        const tok = obj.message?.content ?? '';
        if (tok) {
          full += tok;
          onToken?.(tok, full);
        }
        if (obj.done) return full;
      } catch (err) {
        console.warn('Ollama stream parse error:', err, line);
      }
    }
  }
  return full;
}

export async function checkOllamaAvailable() {
  try {
    const res = await fetch('http://localhost:11434/api/version', { method: 'GET' });
    return res.ok;
  } catch {
    return false;
  }
}

// ---------- フォールバック ----------

/**
 * 優先プロバイダから順に試行して、最初に成功したものを返す。
 * （現行は新タブ起動なので「ブロックされた」場合だけフォールバック）
 */
export async function launchWithFallback(preferredKey, prompt) {
  const order = [
    preferredKey,
    ...PROVIDER_ORDER.filter((k) => k !== preferredKey),
  ];

  for (const key of order) {
    const result = await launchProvider(key, prompt);
    if (result.opened) return result;
  }

  // 全てブロックされた
  return { provider: getProvider(preferredKey), copied: false, opened: false };
}
