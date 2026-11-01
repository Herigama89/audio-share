// Plays raw stereo PCM chunks (from the DAW capture helper) into the Web Audio
// graph, with a small jitter buffer (~60 ms) so the music never stutters.
// The worklet code is kept as a function and loaded from memory (a blob URL),
// because audio worklets can't be loaded straight from the app's local files.
window.DAW_WORKLET_SRC = '(' + function () {
  class PcmPlayer extends AudioWorkletProcessor {
    constructor() {
      super();
      this.size = sampleRate * 2;               // 2 seconds of room
      this.L = new Float32Array(this.size);
      this.R = new Float32Array(this.size);
      this.r = 0; this.w = 0; this.count = 0;
      this.target = Math.round(sampleRate * 0.06);
      this.max = Math.round(sampleRate * 0.25);
      this.playing = false;
      this.port.onmessage = (e) => {
        const d = e.data;
        if (!(d instanceof Float32Array)) return;
        const frames = d.length >> 1;
        for (let i = 0; i < frames; i++) {
          this.L[this.w] = d[2 * i];
          this.R[this.w] = d[2 * i + 1];
          this.w = (this.w + 1) % this.size;
        }
        this.count = Math.min(this.size, this.count + frames);
        if (this.count > this.max) {               // falling behind: skip ahead
          const drop = this.count - this.target;
          this.r = (this.r + drop) % this.size;
          this.count -= drop;
        }
      };
    }
    process(_inputs, outputs) {
      const out = outputs[0];
      const l = out[0], r = out[1] || out[0];
      const n = l.length;
      if (!this.playing) {
        if (this.count < this.target) { l.fill(0); r.fill(0); return true; }
        this.playing = true;
      }
      for (let i = 0; i < n; i++) {
        if (this.count > 0) {
          l[i] = this.L[this.r]; r[i] = this.R[this.r];
          this.r = (this.r + 1) % this.size;
          this.count--;
        } else {
          l[i] = 0; r[i] = 0;
          this.playing = false;                     // ran dry: rebuffer
        }
      }
      return true;
    }
  }
  registerProcessor('pcm-player', PcmPlayer);
}.toString() + ')();';
