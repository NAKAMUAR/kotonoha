// =====================================================================
// 言の葉 / Kotonoha — マイク録音（iPhone / Android タブレット対応）
//
// 端末ごとの注意点:
//   ・iOS Safari は AudioContext をユーザー操作の中で resume() しないと
//     動かない。ボタンの click ハンドラから start() を呼ぶこと。
//   ・サンプルレートは端末が決める（iPhone は 48000 が多い）。
//     固定値を仮定せず、必ず ctx.sampleRate を解析側へ渡す。
//   ・getUserMedia は HTTPS（または localhost）でのみ動作する。
//     GitHub Pages / Firebase Hosting はどちらも HTTPS なので問題ない。
//   ・録音を止めたらトラックも stop() する。iOS は解放しないと
//     録音インジケータが出たままになる。
//   ・AudioWorklet が使えない古い端末では ScriptProcessor に落とす。
// =====================================================================

const WORKLET_URL = new URL('./recorder-worklet.js', import.meta.url);

export const RecorderSupport = {
  getUserMedia: typeof navigator !== 'undefined' &&
                Boolean(navigator.mediaDevices?.getUserMedia),
  audioContext: typeof window !== 'undefined' &&
                Boolean(window.AudioContext ?? window.webkitAudioContext),
};

export function isSupported() {
  return RecorderSupport.getUserMedia && RecorderSupport.audioContext;
}

/** 端末が HTTPS でないなど、マイクが使えない理由を日本語で返す。 */
export function unsupportedReason() {
  if (typeof window === 'undefined') return '対応していません';
  if (!window.isSecureContext) {
    return 'マイクを使うには HTTPS でのアクセスが必要です';
  }
  if (!RecorderSupport.getUserMedia) return 'このブラウザはマイク入力に対応していません';
  if (!RecorderSupport.audioContext) return 'このブラウザは音声解析に対応していません';
  return null;
}

export class Recorder {
  constructor() {
    this.ctx = null;
    this.stream = null;
    this.node = null;
    this.source = null;
    this.chunks = [];
    this.recording = false;
    this.usingWorklet = false;
  }

  get sampleRate() {
    return this.ctx?.sampleRate ?? 48000;
  }

  /**
   * マイクを開いて録音を始める。
   * 必ずユーザー操作（click / touchend）の中から呼ぶこと。
   */
  async start() {
    if (this.recording) return;

    const reason = unsupportedReason();
    if (reason) throw new Error(reason);

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        // 声調は F0 の細かな上下が命なので、信号を加工する処理は切る。
        // 自動ゲイン調整はエネルギーの急落（声門閉鎖）をならしてしまう。
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl:  false,
      },
    });

    const Ctx = window.AudioContext ?? window.webkitAudioContext;
    this.ctx = new Ctx();
    // iOS はユーザー操作内で resume しないと suspended のまま無音になる
    if (this.ctx.state === 'suspended') await this.ctx.resume();

    this.source = this.ctx.createMediaStreamSource(this.stream);
    this.chunks = [];

    if (this.ctx.audioWorklet) {
      try {
        await this.ctx.audioWorklet.addModule(WORKLET_URL);
        this.node = new AudioWorkletNode(this.ctx, 'recorder-processor');
        this.node.port.onmessage = (e) => { this.chunks.push(e.data); };
        this.node.port.postMessage('start');
        this.usingWorklet = true;
      } catch (err) {
        console.warn('AudioWorklet unavailable, falling back:', err);
        this.usingWorklet = false;
      }
    }

    if (!this.usingWorklet) {
      // 非推奨 API だが、古い端末ではこれしか手段がない
      this.node = this.ctx.createScriptProcessor(4096, 1, 1);
      this.node.onaudioprocess = (e) => {
        this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
    }

    this.source.connect(this.node);
    // ScriptProcessor は destination へつながないと発火しない端末がある。
    // 無音のゲインを挟んでスピーカーへは出さない（ハウリング防止）。
    const mute = this.ctx.createGain();
    mute.gain.value = 0;
    this.node.connect(mute);
    mute.connect(this.ctx.destination);
    this.muteNode = mute;

    this.recording = true;
  }

  /**
   * 録音を止め、連結した PCM を返す。
   * @returns {{samples: Float32Array, sampleRate: number, durationSec: number}}
   */
  async stop() {
    if (!this.recording) {
      return { samples: new Float32Array(0), sampleRate: this.sampleRate, durationSec: 0 };
    }
    this.recording = false;

    if (this.usingWorklet) this.node?.port?.postMessage('stop');
    else if (this.node) this.node.onaudioprocess = null;

    const sampleRate = this.sampleRate;
    const total = this.chunks.reduce((n, c) => n + c.length, 0);
    const samples = new Float32Array(total);
    let offset = 0;
    for (const c of this.chunks) { samples.set(c, offset); offset += c.length; }

    this.release();

    return { samples, sampleRate, durationSec: total / sampleRate };
  }

  /** マイクと AudioContext を解放する。iOS では必須。 */
  release() {
    try { this.source?.disconnect(); } catch { /* ignore */ }
    try { this.node?.disconnect(); } catch { /* ignore */ }
    try { this.muteNode?.disconnect(); } catch { /* ignore */ }
    for (const track of this.stream?.getTracks() ?? []) {
      try { track.stop(); } catch { /* ignore */ }
    }
    if (this.ctx && this.ctx.state !== 'closed') {
      this.ctx.close().catch(() => {});
    }
    this.stream = null;
    this.source = null;
    this.node = null;
    this.muteNode = null;
    this.ctx = null;
    this.chunks = [];
  }
}

/** マイク権限の状態を調べる（対応していないブラウザでは 'unknown'）。 */
export async function micPermissionState() {
  try {
    if (!navigator.permissions?.query) return 'unknown';
    const status = await navigator.permissions.query({ name: 'microphone' });
    return status.state; // 'granted' | 'denied' | 'prompt'
  } catch {
    return 'unknown';
  }
}

/** getUserMedia のエラーを日本語の案内に変換する。 */
export function micErrorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'マイクの使用が許可されませんでした。ブラウザの設定から許可してください。';
    case 'NotFoundError':
      return 'マイクが見つかりませんでした。';
    case 'NotReadableError':
      return '他のアプリがマイクを使用中の可能性があります。';
    default:
      return err?.message ?? 'マイクを起動できませんでした。';
  }
}
