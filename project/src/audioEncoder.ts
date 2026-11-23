import { Mp3Encoder } from '@breezystack/lamejs';

const SAMPLE_RATE = 24000;
const SILENCE_THRESHOLD = 0.005;

export interface AudioInputDevice {
  deviceId: string;
  label: string;
}

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

export async function listAudioInputs(): Promise<AudioInputDevice[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devs = await navigator.mediaDevices.enumerateDevices();
  return devs
    .filter(d => d.kind === 'audioinput')
    .map((d, idx) => ({
      deviceId: d.deviceId,
      label: d.label || `Microphone ${idx + 1}`,
    }));
}

function findMatchingInput(
  inputs: AudioInputDevice[],
  preferred?: { deviceId?: string; label?: string } | null
): AudioInputDevice | null {
  if (inputs.length === 0) return null;

  const prefId = (preferred?.deviceId || '').trim();
  const prefLabel = (preferred?.label || '').trim().toLowerCase();

  if (prefId || prefLabel) {
    if (prefId && prefId !== 'default' && prefId !== 'communications') {
      const byId = inputs.find(d => d.deviceId === prefId);
      if (byId) return byId;
    }
    if (prefLabel) {
      const exactLabel = inputs.find(d => d.label.toLowerCase() === prefLabel);
      if (exactLabel) return exactLabel;
      const cleanPref = prefLabel.replace(/^(default|communications)\s*-\s*/i, '').trim();
      const bySub = inputs.find(d => d.label.toLowerCase().includes(cleanPref));
      if (bySub) return bySub;
    }
    if (prefId === 'default') {
      return inputs.find(d => d.deviceId === 'default') || inputs[0];
    }
  }

  // First-run default: automatically prefer Voicemeeter Out B1 if available
  const vmB1 = inputs.find(d => /voicemeeter\s+out\s+b1/i.test(d.label));
  if (vmB1) return vmB1;
  return inputs.find(d => d.deviceId === 'default') || inputs[0];
}

export class Mp3VoiceRecorder {
  private stream: MediaStream | null = null;
  private ctx: AudioContext | null = null;
  private processor: ScriptProcessorNode | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private chunks: Float32Array[] = [];
  private collecting = false;
  private startedAt = 0;
  private lastSampleAt = 0;
  private heardAudio = false;
  private warmPromise: Promise<void> | null = null;
  private activeMic: AudioInputDevice | null = null;
  private preferredMic: { deviceId?: string; label?: string } | null = null;

  getActiveMic(): AudioInputDevice | null {
    return this.activeMic;
  }

  async warmUp(preferred?: { deviceId?: string; label?: string } | null): Promise<void> {
    if (preferred !== undefined) {
      this.preferredMic = preferred;
    }
    if (this.stream && this.stream.active && this.ctx && this.ctx.state !== 'closed' && this.processor) {
      if (this.ctx.state === 'suspended') {
        await this.ctx.resume().catch(() => {});
      }
      return;
    }
    if (this.warmPromise) return this.warmPromise;

    this.warmPromise = (async () => {
      try {
        let inputs = await listAudioInputs();
        // If labels aren't unlocked yet, grant permission once then re-enumerate
        if (inputs.length === 0 || inputs.every(d => !d.label || /^Microphone \d+$/.test(d.label))) {
          const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
          probe.getTracks().forEach(t => t.stop());
          inputs = await listAudioInputs();
        }

        const chosen = findMatchingInput(inputs, this.preferredMic);
        const chosenLabel = chosen?.label || '';
        const isVirtualMixer = /voicemeeter|vb-audio|sonar/i.test(chosenLabel);

        const audioConstraints: MediaTrackConstraints = {
          channelCount: 1,
          echoCancellation: !isVirtualMixer,
          noiseSuppression: !isVirtualMixer,
          autoGainControl: !isVirtualMixer,
        };
        if (chosen?.deviceId) {
          audioConstraints.deviceId = { exact: chosen.deviceId };
        }

        const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints });
        const trackLabel = stream.getAudioTracks()[0]?.label || chosenLabel || 'Default';
        const trackDeviceId = stream.getAudioTracks()[0]?.getSettings?.().deviceId || chosen?.deviceId || 'default';
        this.activeMic = { deviceId: trackDeviceId, label: trackLabel };

        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        const ctx = new AudioCtx({ sampleRate: SAMPLE_RATE });
        const source = ctx.createMediaStreamSource(stream);
        const processor = ctx.createScriptProcessor(2048, 1, 1);
        processor.onaudioprocess = (ev) => {
          if (!this.collecting) return;
          this.lastSampleAt = Date.now();
          const input = ev.inputBuffer.getChannelData(0);
          if (!this.heardAudio) this.heardAudio = input.some(sample => Math.abs(sample) >= SILENCE_THRESHOLD);
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

  async switchMic(preferred: { deviceId: string; label: string }): Promise<AudioInputDevice | null> {
    this.dispose();
    await this.warmUp(preferred);
    return this.activeMic;
  }

  isReady(): boolean {
    return Boolean(this.stream && this.stream.active && this.ctx && this.ctx.state === 'running' && this.processor);
  }

  async start() {
    if (!this.isReady()) {
      await this.warmUp();
      if (this.ctx?.state === 'suspended') await this.ctx.resume();
    }
    if (!this.isReady()) throw new Error('Microphone audio stream is unavailable');
    this.chunks = [];
    this.startedAt = Date.now();
    this.lastSampleAt = this.startedAt;
    this.heardAudio = false;
    this.collecting = true;
  }

  hasCaptureInterrupted() {
    return this.collecting && (!this.isReady() || Date.now() - this.lastSampleAt > 2500);
  }

  isMissingAudioSignal() {
    return this.collecting && !this.heardAudio && Date.now() - this.startedAt > 5000;
  }

  discard() {
    this.collecting = false;
    this.chunks = [];
  }

  async stop(): Promise<{
    silent: boolean;
    bytes: Uint8Array | number[];
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
      bytes: out,
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
