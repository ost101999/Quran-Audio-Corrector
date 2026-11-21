import { Mp3Encoder } from '@breezystack/lamejs';

const SAMPLE_RATE = 24000;
const SILENCE_THRESHOLD = 0.005;

let sharedToneCtx: AudioContext | null = null;

export function playSoftTone(frequency = 950, durationMs = 90, volume = 0.06) {
  try {
    const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
    if (!AudioCtx) return;
    if (!sharedToneCtx || sharedToneCtx.state === 'closed') {
      sharedToneCtx = new AudioCtx();
    }
    if (sharedToneCtx.state === 'suspended') {
      void sharedToneCtx.resume().catch(() => {});
    }
    const osc = sharedToneCtx.createOscillator();
    const gain = sharedToneCtx.createGain();
    osc.type = 'sine';
    osc.frequency.value = frequency;
    gain.gain.value = volume;
    osc.connect(gain);
    gain.connect(sharedToneCtx.destination);
    osc.start();
    setTimeout(() => {
      try {
        osc.stop();
        osc.disconnect();
        gain.disconnect();
      } catch { /* ignore */ }
    }, durationMs);
  } catch { /* ignore */ }
}

export class Mp3VoiceRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private collecting = false;
  private startedAt = 0;
  private warmPromise: Promise<void> | null = null;

  async warmUp(): Promise<void> {
    if (this.stream && this.stream.active && this.ctx && this.ctx.state !== 'closed' && this.processor) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume().catch(() => {});
      }
      return;
    }
    if (this.warmPromise) return this.warmPromise;

    this.warmPromise = (async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            channelCount: 1,
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioCtx({ sampleRate: SAMPLE_RATE });
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (ev) => {
          if (!this.collecting) return;
          const input = ev.inputBuffer.getChannelData(0);
          this.chunks.push(new Float32Array(input));
        };
        source.connect(processor);
        processor.connect(ctx.destination);
        this.stream = stream;
        this.ctx = ctx;
        this.source = source;
        this.processor = processor;
      } finally {
        this.warmPromise = null;
      }
    })();

    return this.warmPromise;
  }

  async start() {
    await this.warmUp();
    this.chunks = [];
    this.startedAt = Date.now();
    this.collecting = true;
  }

  async stop(): Promise<{
    silent: boolean;
    bytes: number[];
    startedAt: number;
    endedAt: number;
    durationMs: number;
  }> {
    this.collecting = false;
    const endedAt = Date.now();
    const actualRate = this.ctx?.sampleRate || SAMPLE_RATE;
    const captured = this.chunks;
    this.chunks = [];

    const totalLen = captured.reduce((acc, c) => acc + c.length, 0);
    if (totalLen === 0) {
      return { silent: true, bytes: [], startedAt: this.startedAt, endedAt, durationMs: 0 };
    }

    const merged = new Float32Array(totalLen);
    let offset = 0;
    let maxAmp = 0;
    for (const chunk of captured) {
      for (let i = 0; i < chunk.length; i++) {
        const abs = Math.abs(chunk[i]);
        if (abs > maxAmp) maxAmp = abs;
      }
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    if (maxAmp < SILENCE_THRESHOLD) {
      return { silent: true, bytes: [], startedAt: this.startedAt, endedAt, durationMs: endedAt - this.startedAt };
    }

    const gain = Math.min(0.85 / maxAmp, 3.0);
    const int16 = new Int16Array(merged.length);
    for (let i = 0; i < merged.length; i++) {
      const s = Math.max(-1, Math.min(1, merged[i] * gain));
      int16[i] = Math.round(s * 32767);
    }

    const encoder = new Mp3Encoder(1, actualRate, 64);
    const mp3Parts: Uint8Array[] = [];
    const blockSize = 1152;
    for (let i = 0; i < int16.length; i += blockSize) {
      const slice = int16.subarray(i, i + blockSize);
      const mp3buf = encoder.encodeBuffer(slice);
      if (mp3buf.length > 0) mp3Parts.push(new Uint8Array(mp3buf));
    }
    const tail = encoder.flush();
    if (tail.length > 0) mp3Parts.push(new Uint8Array(tail));

    const totalBytes = mp3Parts.reduce((s, p) => s + p.length, 0);
    const out = new Uint8Array(totalBytes);
    let pos = 0;
    for (const p of mp3Parts) {
      out.set(p, pos);
      pos += p.length;
    }

    return {
      silent: false,
      bytes: Array.from(out),
      startedAt: this.startedAt,
      endedAt,
      durationMs: Math.max(200, endedAt - this.startedAt),
    };
  }

  dispose() {
    this.collecting = false;
    this.chunks = [];
    if (this.processor) {
      this.processor.disconnect();
      this.processor.onaudioprocess = null;
      this.processor = null;
    }
    if (this.source) {
      this.source.disconnect();
      this.source = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
    }
    if (this.ctx) {
      void this.ctx.close().catch(() => {});
      this.ctx = null;
    }
  }
}
