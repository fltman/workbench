// voice.ts — håll-för-att-tala (CONTRACT §12): MediaRecorder (audio/webm;codecs=opus, 32 kbps) medan
// mikrofonknappen eller mellanslag i en tom inmatning hålls, eller mellanslag på skalet utan öppen HUD (fältet,
// §10.9). Inspelningar under 300 ms och tysta inspelningar kastas (voice-gate.ts), resten skrivs ut av servern
// (store.transcribe) och skickas som röstmeddelande. Mikrofonen hålls varm en kort stund efter senaste
// inspelningen och släpps när HUD:en stängs, och en mikrofon som webbläsaren ger först efter det stängs direkt.
import { mixDown, speechGate } from './voice-gate.ts';
import { stopSpeaking } from './tts.ts';

export type VoiceState = 'idle' | 'arming' | 'recording' | 'checking' | 'transcribing';
export type VoiceFailure = 'short' | 'silent' | 'denied' | 'stt' | 'unsupported';

export interface VoiceHooks {
  onState(s: VoiceState): void;
  /** 0–1, ungefärlig ljudnivå medan inspelningen pågår (för den levande ringen). */
  onLevel(level: number): void;
  onText(text: string): void;
  onFail(kind: VoiceFailure): void;
  transcribe(audio: Blob): Promise<string>;
}

export interface Voice {
  readonly state: VoiceState;
  start(): void;
  stop(): void;
  /** Avbryt utan att skicka (HUD:en stängs eller byter app). */
  cancel(): void;
  /** Släpp mikrofonen helt. */
  release(): void;
}

export const MIN_MS = 300;
/** Mikrofonen hålls öppen så här länge efter senaste inspelningen (snabb följdfråga), sedan släpps den. */
const KEEP_WARM_MS = 8_000;

export function createVoice(h: VoiceHooks): Voice {
  let state: VoiceState = 'idle';
  let stream: MediaStream | null = null;
  let ctx: AudioContext | null = null;
  let source: MediaStreamAudioSourceNode | null = null;
  let analyser: AnalyserNode | null = null;
  let rec: MediaRecorder | null = null;
  let chunks: Blob[] = [];
  let t0 = 0;
  let held = false;
  let generation = 0;
  let raf = 0;
  let warmTimer: ReturnType<typeof setTimeout> | null = null;
  /** Räknas upp av release(), så att en mikrofon som öppnas medan den släpps aldrig blir kvar. */
  let releases = 0;

  const set = (s: VoiceState) => {
    state = s;
    h.onState(s);
  };

  const mime = (): string => {
    if (typeof MediaRecorder === 'undefined') return '';
    return ['audio/webm;codecs=opus', 'audio/mp4'].find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  };

  async function getStream(): Promise<MediaStream> {
    if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
    const r = releases;
    const s = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    if (r !== releases) {
      // Släppt medan webbläsaren öppnade mikrofonen eller frågade om lov (fältet stängdes med Esc): stäng den direkt.
      for (const t of s.getTracks()) t.stop();
      throw new Error('mikrofonen släpptes');
    }
    stream = s;
    source = null;
    return stream;
  }

  function meter(s: MediaStream): void {
    try {
      ctx ??= new AudioContext();
      void ctx.resume();
      if (!source) {
        source = ctx.createMediaStreamSource(s);
        analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        source.connect(analyser);
      }
    } catch {
      return;
    }
    const buf = new Float32Array(analyser ? analyser.fftSize : 1024);
    const tick = () => {
      if (state !== 'recording' || !analyser) return;
      analyser.getFloatTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
      const db = 20 * Math.log10(Math.sqrt(sum / buf.length) + 1e-9);
      h.onLevel(Math.max(0, Math.min(1, (db + 58) / 46)));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
  }

  function warm(): void {
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = setTimeout(release, KEEP_WARM_MS);
  }

  async function start(): Promise<void> {
    if (held || state !== 'idle') return;
    held = true;
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = null;
    const gen = ++generation;
    stopSpeaking();
    const type = mime();
    if (!type || !navigator.mediaDevices?.getUserMedia) {
      held = false;
      h.onFail('unsupported');
      return;
    }
    set('arming');
    let s: MediaStream;
    try {
      s = await getStream();
    } catch {
      if (gen === generation) {
        held = false;
        set('idle');
        h.onFail('denied');
      }
      return;
    }
    if (gen !== generation) return;
    if (!held) {
      set('idle');
      h.onFail('short');
      warm();
      return;
    }
    chunks = [];
    const r = new MediaRecorder(s, { mimeType: type, audioBitsPerSecond: 32_000 });
    rec = r;
    r.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    r.start(200);
    t0 = performance.now();
    set('recording');
    meter(s);
  }

  async function stop(): Promise<void> {
    if (!held) return;
    held = false;
    const r = rec;
    if (!r) return; // start() ser att knappen släpptes medan mikrofonen öppnades
    rec = null;
    const gen = generation;
    const ms = performance.now() - t0;
    cancelAnimationFrame(raf);
    h.onLevel(0);
    const blob = await finish(r);
    if (gen !== generation) return;
    warm();
    if (ms < MIN_MS) {
      set('idle');
      h.onFail('short');
      return;
    }
    set('checking');
    if (await isSilent(blob)) {
      if (gen !== generation) return;
      set('idle');
      h.onFail('silent');
      return;
    }
    if (gen !== generation) return;
    set('transcribing');
    let text = '';
    try {
      text = (await h.transcribe(blob)).trim();
    } catch {
      text = '';
    }
    if (gen !== generation) return;
    set('idle');
    if (text) h.onText(text);
    else h.onFail('stt');
  }

  function finish(r: MediaRecorder): Promise<Blob> {
    return new Promise((resolve) => {
      const done = () => resolve(new Blob(chunks, { type: r.mimeType || mime() }));
      if (r.state === 'inactive') return done();
      r.addEventListener('stop', done, { once: true });
      r.stop();
    });
  }

  async function isSilent(blob: Blob): Promise<boolean> {
    try {
      ctx ??= new AudioContext();
      const audio = await ctx.decodeAudioData(await blob.arrayBuffer());
      const channels = Array.from({ length: audio.numberOfChannels }, (_, i) => audio.getChannelData(i));
      return speechGate(mixDown(channels), audio.sampleRate).silent;
    } catch {
      return false; // kan inte avkodas här: låt servern avgöra
    }
  }

  function cancel(): void {
    generation++;
    held = false;
    cancelAnimationFrame(raf);
    h.onLevel(0);
    const r = rec;
    rec = null;
    if (r && r.state !== 'inactive') {
      r.ondataavailable = null;
      try {
        r.stop();
      } catch {
        /* redan stoppad */
      }
    }
    if (state !== 'idle') set('idle');
  }

  function release(): void {
    releases++;
    if (warmTimer) clearTimeout(warmTimer);
    warmTimer = null;
    if (state === 'recording' || state === 'arming') cancel();
    try {
      source?.disconnect();
    } catch {
      /* redan frånkopplad */
    }
    source = null;
    analyser = null;
    for (const t of stream?.getTracks() ?? []) t.stop();
    stream = null;
    void ctx?.suspend().catch(() => {});
  }

  return {
    get state() {
      return state;
    },
    start: () => void start(),
    stop: () => void stop(),
    cancel,
    release,
  };
}
