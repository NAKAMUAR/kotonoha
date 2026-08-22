// =====================================================================
// 言の葉 / Kotonoha — 録音用 AudioWorklet
//
// マイク入力の生 PCM をそのままメインスレッドへ送るだけの処理。
// MediaRecorder を使うとコーデックが端末ごとに違い（iOS は audio/mp4、
// Android は audio/webm）、デコードの手間と誤差が入る。
// 声調解析には生の波形が要るので、ここでは圧縮を挟まない。
// =====================================================================

class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.recording = false;
    this.port.onmessage = (e) => {
      if (e.data === 'start') this.recording = true;
      if (e.data === 'stop')  this.recording = false;
    };
  }

  process(inputs) {
    if (!this.recording) return true;
    const input = inputs[0];
    if (!input || !input[0]) return true;
    // 転送のたびにコピーを作る（次の process で再利用されるため）
    this.port.postMessage(new Float32Array(input[0]));
    return true;
  }
}

registerProcessor('recorder-processor', RecorderProcessor);
