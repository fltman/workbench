// ideas.ts — sidan Förslag (CONTRACT §10.8). Varje byggd app får en sista sida som skalet ritar själv, utan iframe:
// förslag på förbättringar av appen från Claude (§8.12). Ett klick på ett förslag vrider fram appen, öppnar dess HUD
// och skickar förslaget (världen gör det via 'hud:send'). Appen själv kan aldrig starta ett bygge härifrån.
// Alla förslag sätts med textContent.
import { store } from '../store.ts';

/** Sidans id bland appens sidor; reserverat för skalet. */
export const IDEAS_FACE = 'wb-ideas';
export const IDEAS_LABEL = 'Förslag';

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string, parent?: Element): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = cls;
  if (parent) parent.append(e);
  return e;
}

export class IdeasView {
  readonly el: HTMLDivElement;
  readonly #appId: string;
  readonly #pick: (text: string) => void;
  #state: 'idle' | 'loading' | 'ready' | 'error' = 'idle';
  /** Appens rev som visas (eller hämtas) just nu. */
  #rev = -1;
  #items: string[] = [];
  #gen = 0;

  constructor(parent: HTMLElement, appId: string, pick: (text: string) => void) {
    this.#appId = appId;
    this.#pick = pick;
    this.el = el('div', 'wb-ideas', parent);
    this.el.setAttribute('role', 'group');
    this.el.setAttribute('aria-label', IDEAS_LABEL);
    this.#render();
  }

  /** Sidan syns eller är på väg fram: hämta förslagen för appens nuvarande rev, om de inte redan finns eller hämtas. */
  want(rev: number): void {
    if (this.#rev === rev && (this.#state === 'loading' || this.#state === 'ready')) return;
    this.#load(rev);
  }

  #load(rev: number): void {
    const gen = ++this.#gen;
    this.#rev = rev;
    this.#state = 'loading';
    this.#render();
    store.ideas(this.#appId).then(
      (r) => {
        if (gen !== this.#gen) return;
        this.#items = r.items;
        this.#state = r.items.length ? 'ready' : 'error';
        this.#render();
      },
      () => {
        if (gen !== this.#gen) return;
        this.#state = 'error';
        this.#render();
      },
    );
  }

  #render(): void {
    const e = this.el;
    e.dataset.state = this.#state;
    if (this.#state === 'loading' || this.#state === 'idle') {
      const wait = el('div', 'wb-ideas-wait');
      el('i', 'wb-ideas-led', wait);
      e.replaceChildren(wait);
      return;
    }
    if (this.#state === 'error') {
      const box = el('div', 'wb-ideas-err');
      el('span', '', box).textContent = 'Kunde inte ta fram förslag.';
      const again = el('button', 'wb-ideas-again', box);
      again.type = 'button';
      again.textContent = 'Försök igen';
      again.addEventListener('click', () => this.#load(this.#rev));
      e.replaceChildren(box);
      return;
    }
    const list = el('ul', 'wb-ideas-list');
    for (const text of this.#items) {
      const li = el('li', '', list);
      const b = el('button', 'wb-idea', li);
      b.type = 'button';
      el('i', 'wb-idea-dot', b);
      el('span', '', b).textContent = text;
      b.addEventListener('click', () => this.#pick(text));
    }
    e.replaceChildren(list);
  }
}
