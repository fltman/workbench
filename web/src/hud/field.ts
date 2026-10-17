// field.ts — fältet (CONTRACT §10.9). Anders 16 oktober: "det borde finnas ett kontext aware inputfält så om jag
// skriver en webadress så zoomar den in på webbläsaren och visar sidan. skriver jag in ett datum så går den till
// kalendern osv. hittar den inget som passar innehållet så föreslår den att den ska bygga något". Hans val: fältet
// öppnas när man skriver på tom yta och ingen HUD är öppen.
//
// En adress eller ett datum känns igen direkt (shared/open.ts) och går till en app som anger slaget i opens. Annars
// avgör Claude (POST /api/route, §8.13): öppna i en av apparna, eller ett förslag att bygga en ny. En app som passar men
// ännu inte tar emot något utifrån får önskemålet i sin HUD, och när den lärt sig det (opens) lämnas det fram.
//
// Håll mellanslag utan öppen HUD så talar man in i fältet: det öppnas tomt, hud.ts spelar in (rösten är en, §12),
// och det talade går vidare som skriven text. Ett byggförslag till talad text läses upp. I det öppna fältet talar
// mellanslaget in igen.
import type { OpenItem } from '../../../shared/protocol.ts';
import { classifyInput } from '../../../shared/open.ts';
import { bus } from '../bus.ts';
import { pushEscape } from '../escape.ts';
import { store } from '../store.ts';
import type { World } from '../types.ts';
import { button, el } from './asks.ts';
import { guardFocus } from './focusguard.ts';
import type { VoiceFailure, VoiceState } from './voice.ts';

export interface Field {
  readonly open: boolean;
  /** Öppna fältet med det första tecknet (skriv var som helst utan öppen HUD). */
  start(first: string): void;
  /** Öppna fältet tomt för att tala in (håll mellanslag utan öppen HUD), eller tala in igen i det öppna. Rösten kommer sedan via voice*. */
  listen(): void;
  close(): void;
  voiceState(s: VoiceState): void;
  voiceLevel(level: number): void;
  voiceText(text: string): void;
  voiceFail(kind: VoiceFailure): void;
}

/** Det fältet behöver av rösten, som hud.ts äger. */
export interface FieldVoice {
  /** Mellanslag i det öppna fältet (den tomma inmatningen eller kortet): tala in igen. */
  talk(): void;
  /** Fältet stängdes: en inspelning i det avbryts, och mikrofonen släpps om ingen HUD är öppen. */
  closed(): void;
  /** Läs upp ett byggförslag till talad text. */
  speak(text: string): void;
}

/** Fältets rader för röstens fel. Ett kort tryck och en tyst inspelning ändrar ingenting (§10.9). */
const VOICE_FAIL: Record<VoiceFailure, string | null> = {
  short: null,
  silent: null,
  denied: 'Ingen åtkomst till mikrofonen.',
  stt: 'Kunde inte tolka talet.',
  unsupported: 'Röstinmatning stöds inte här.',
};

/** Önskemålet till en app som passar men ännu inte tar emot något från fältet. Claude vet hur (app-rules). */
export function askToOpen(item: OpenItem): string {
  if (item.kind === 'url') return `Öppna ${item.url} här, och gör så att adresser från Workbench-fältet öppnas direkt nästa gång: lägg till url i opens i app.json och ta emot dem med wb.onOpen. En egen backend-route räcker inte.`;
  if (item.kind === 'date') return `Visa ${item.date} här, och gör så att datum från Workbench-fältet visas direkt nästa gång: lägg till date i opens i app.json och ta emot dem med wb.onOpen. En egen backend-route räcker inte.`;
  return `Ta emot det här från Workbench-fältet: ”${item.text}”. Gör så att text från fältet hamnar här direkt nästa gång: lägg till text i opens i app.json och ta emot den med wb.onOpen. En egen backend-route räcker inte.`;
}

export function createField(root: HTMLElement, world: World, recentApp: () => string | null, voice: FieldVoice): Field {
  const wrap = el('div', 'wbf');
  wrap.hidden = true;
  const pill = el('div', 'wbf-pill');
  const input = el('input', 'wbf-input');
  input.type = 'text';
  input.autocomplete = 'off';
  input.spellcheck = false;
  input.setAttribute('aria-label', 'Öppna eller bygg');
  const led = el('i', 'wbf-led');
  led.hidden = true;
  pill.append(input, led);
  const card = el('div', 'wbf-card');
  card.hidden = true;
  wrap.append(pill, card);
  root.append(wrap);

  let isOpen = false;
  guardFocus(input, () => isOpen);
  // Ett klick i en app (bryggans focus) stänger fältet: pekaren i en iframe syns inte för skalets pointerdown.
  bus.on('app:focus', () => {
    if (isOpen && !document.activeElement?.closest?.('.wbf')) close();
  });
  let popEsc: (() => void) | null = null;
  let gen = 0;
  /** Mellanslaget som talar in nu öppnade fältet: ett kort tryck eller en tyst inspelning stänger det igen. */
  let fresh = false;
  /** Appar som fått önskemålet i sin HUD: det lämnas fram när appen anger slaget i opens efter turen. */
  const pending = new Map<string, { item: OpenItem; rev: number }>();

  function busy(on: boolean): void {
    led.hidden = !on;
    wrap.classList.toggle('is-busy', on);
  }

  function showCard(kind: 'build' | 'error', text: string, onBuild?: () => void): void {
    const lead = el('div', 'wbf-lead', kind === 'build' ? 'Ingen app passar.' : text || 'Kunde inte avgöra vart det ska.');
    const nodes: Node[] = [lead];
    if (kind === 'build') {
      nodes.push(el('div', 'wbf-text', text));
      const row = el('div', 'wbf-actions');
      const yes = button('Bygg', 'wbh-btn is-primary');
      const no = button('Avbryt');
      yes.addEventListener('click', () => onBuild?.());
      no.addEventListener('click', () => close());
      row.append(yes, no);
      nodes.push(row);
      card.replaceChildren(...nodes);
      card.hidden = false;
      yes.focus({ preventScroll: true });
      return;
    }
    card.replaceChildren(...nodes);
    card.hidden = false;
  }

  /** Öppna i appen: lämna fram direkt om den kan ta emot slaget, annars önskemålet i dess HUD (och lämna sedan). */
  function openIn(appId: string, item: OpenItem): void {
    world.show(appId);
    if (!world.deliver(appId, item)) {
      const rev = store.apps.get(appId)?.rev ?? -1;
      pending.set(appId, { item, rev });
      bus.emit('hud:send', { appId, text: askToOpen(item) });
    }
    close();
  }

  /** En app som anger slaget: den i fokus om den kan, annars den första. */
  function declared(item: OpenItem): string | null {
    const able = [...store.apps.values()].filter((a) => a.built && a.opens?.includes(item.kind)).map((a) => a.id);
    if (!able.length) return null;
    const r = recentApp();
    return r && able.includes(r) ? r : able[0];
  }

  async function submit(spoken = false): Promise<void> {
    const text = input.value.trim();
    if (!text || wrap.classList.contains('is-busy')) return;
    card.hidden = true;
    const known = classifyInput(text, new Date());
    if (known) {
      const target = declared(known);
      if (target) {
        openIn(target, known);
        return;
      }
    }
    const g = ++gen;
    busy(true);
    let r: Awaited<ReturnType<typeof store.route>>;
    try {
      r = await store.route(text, known);
    } catch {
      if (g !== gen) return;
      busy(false);
      showCard('error', '');
      return;
    }
    if (g !== gen || !isOpen) return;
    busy(false);
    if (r.action === 'open' && store.apps.has(r.appId)) {
      openIn(r.appId, r.item);
      return;
    }
    if (r.action === 'build') {
      const prompt = r.prompt;
      showCard('build', prompt, () => {
        close();
        void world.createApp().then((id) => {
          if (id) bus.emit('hud:send', { appId: id, text: prompt });
        });
      });
      // Talat in: förslaget läses upp (§12). Skriven text läses aldrig upp.
      if (spoken) voice.speak(prompt);
    }
  }

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      void submit();
    }
  });
  // Mellanslag talar in igen i den tomma inmatningen, som i en HUD (§12), och på kortet, där bara Enter trycker på
  // knapparna: ett mellanslag som hålls efter ett uppläst förslag bygger aldrig (§10.9).
  wrap.addEventListener('keydown', (e) => {
    if (e.key !== ' ' || e.isComposing || e.metaKey || e.ctrlKey || e.altKey) return;
    const t = e.target;
    if (t === input ? input.value !== '' : !(t instanceof Node && card.contains(t))) return;
    e.preventDefault();
    if (!e.repeat) voice.talk();
  });
  input.addEventListener('input', () => {
    // En ny text gör ett gammalt förslag inaktuellt.
    if (!card.hidden) card.hidden = true;
  });
  // Ett tryck utanför fältet stänger det.
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (isOpen && !(e.target instanceof Node && wrap.contains(e.target))) close();
    },
    true,
  );

  // Appar som fått önskemålet: när turen är klar och appen nu anger slaget lämnas det fram, annars glöms det.
  store.on('app', (appId) => {
    const p = pending.get(appId);
    const app = store.apps.get(appId);
    if (!p || !app || app.status !== 'idle' || app.rev === p.rev) return;
    pending.delete(appId);
    if (app.opens?.includes(p.item.kind)) world.deliver(appId, p.item);
  });

  function show(): void {
    isOpen = true;
    gen++;
    wrap.hidden = false;
    card.hidden = true;
    busy(false);
    // Glaset själv tonar in, inte föräldern: en förälder med opacitet under 1 blir backdrop root, och då är glaset
    // klart och ljust under toningen (CLAUDE.md, Glas).
    pill.animate([{ opacity: 0, transform: 'translateY(6px) scale(0.98)' }, { opacity: 1, transform: 'none' }], {
      duration: 200,
      easing: 'cubic-bezier(.2,.8,.2,1)',
    });
    popEsc = pushEscape(() => {
      popEsc = null;
      close();
    });
  }

  function start(first: string): void {
    if (isOpen) return;
    show();
    input.value = first;
    input.focus({ preventScroll: true });
    input.setSelectionRange(first.length, first.length);
  }

  /**
   * Tomt och utan fokus medan man talar: mellanslaget som hålls ska inte skriva i fältet. Ett fält som redan är öppet
   * står kvar som det är tills det talade kommer.
   */
  function listen(): void {
    fresh = !isOpen;
    if (isOpen) return;
    show();
    input.value = '';
  }

  /* Rösten (§10.9): LED:en lyser stilla och följer ljudnivån medan mikrofonen öppnas och inspelningen pågår, och andas
     som när Claude avgör medan talet tolkas. */

  function voiceState(s: VoiceState): void {
    if (!isOpen) return;
    const listening = s === 'arming' || s === 'recording';
    wrap.classList.toggle('is-listening', listening);
    if (!listening) led.style.removeProperty('--lvl');
    busy(listening || s === 'checking' || s === 'transcribing');
  }

  function voiceLevel(level: number): void {
    if (isOpen) led.style.setProperty('--lvl', level.toFixed(3));
  }

  /** Det talade går vidare som skriven text, med fokus i fältet så att det går att rätta om något går fel. */
  function voiceText(text: string): void {
    if (!isOpen) return;
    input.value = text;
    input.focus({ preventScroll: true });
    input.setSelectionRange(text.length, text.length);
    void submit(true);
  }

  function voiceFail(kind: VoiceFailure): void {
    if (!isOpen) return;
    const line = VOICE_FAIL[kind];
    if (!line) {
      if (fresh) close();
      return;
    }
    showCard('error', line);
    input.focus({ preventScroll: true });
  }

  function close(): void {
    if (!isOpen) return;
    isOpen = false;
    gen++;
    popEsc?.();
    popEsc = null;
    wrap.hidden = true;
    card.hidden = true;
    wrap.classList.remove('is-listening');
    led.style.removeProperty('--lvl');
    busy(false);
    if (document.activeElement && wrap.contains(document.activeElement)) (document.activeElement as HTMLElement).blur();
    // En inspelning i fältet avbryts, och ingenting skickas.
    voice.closed();
  }

  return {
    get open() {
      return isOpen;
    },
    start,
    listen,
    close,
    voiceState,
    voiceLevel,
    voiceText,
    voiceFail,
  };
}
