// tts.ts — uppläsning av Claudes svar (CONTRACT §12). Bara när användarens senaste meddelande kom med röst.
// Den bästa svenska rösten väljs: Tilde/Axel (Apples premiumröster) före Premium/Enhanced, före Alva, före
// övriga svenska. Uppläsningen avbryts när användaren börjar prata.

export interface VoiceLike {
  name: string;
  lang: string;
  localService: boolean;
}

/** Poäng för en röst; högst vinner. Ren funktion, enhetstestad. */
export function voiceScore(v: VoiceLike): number {
  if (!/^sv([-_]|$)/i.test(v.lang)) return -1;
  return (
    (/\b(tilde|axel)\b/i.test(v.name) ? 40 : 0) +
    (/premium/i.test(v.name) ? 30 : /enhanced|förbättrad/i.test(v.name) ? 20 : 0) +
    (/\balva\b/i.test(v.name) ? 8 : 0) +
    (/^sv[-_]SE$/i.test(v.lang) ? 5 : 0) +
    (v.localService ? 2 : 0)
  );
}

export function pickSwedishVoice<V extends VoiceLike>(voices: readonly V[]): V | null {
  let best: V | null = null;
  let bestScore = -1;
  for (const v of voices) {
    const s = voiceScore(v);
    if (s > bestScore) {
      best = v;
      bestScore = s;
    }
  }
  return bestScore >= 0 ? best : null;
}

function voicesReady(timeoutMs = 1500): Promise<SpeechSynthesisVoice[]> {
  return new Promise((resolve) => {
    const v = speechSynthesis.getVoices();
    if (v.length) return resolve(v);
    const done = () => resolve(speechSynthesis.getVoices());
    speechSynthesis.addEventListener('voiceschanged', done, { once: true });
    setTimeout(done, timeoutMs);
  });
}

/** Läs upp en kort text. Returnerar false om ingen svensk röst finns. */
export async function speak(text: string): Promise<boolean> {
  if (!text || typeof speechSynthesis === 'undefined') return false;
  const voice = pickSwedishVoice(await voicesReady());
  if (!voice) return false;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  u.voice = voice;
  u.lang = voice.lang;
  u.rate = 1.04;
  speechSynthesis.speak(u);
  return true;
}

export function stopSpeaking(): void {
  if (typeof speechSynthesis !== 'undefined' && (speechSynthesis.speaking || speechSynthesis.pending)) speechSynthesis.cancel();
}
