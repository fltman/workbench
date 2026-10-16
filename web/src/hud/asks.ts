// asks.ts — frågekorten i HUD:en (CONTRACT §13): tillstånd, frågor och hemligheter.
// All text från Claude sätts med textContent. Ett hemligt värde skickas i chat.answer.secret och
// töms ur DOM:en direkt; det sparas aldrig i någon variabel längre än själva sändningen.
import type { Ask, AskQuestion } from '../../../shared/protocol.ts';

export type AnswerFn = (
  decision: 'allow' | 'allow-always' | 'deny' | 'answered',
  extra?: { answers?: Record<string, string>; secret?: string },
) => boolean;

export interface Card {
  el: HTMLElement;
  /** Det som ska få fokus när kortet dyker upp. */
  focusTarget(): HTMLElement | null;
  /** Besvarat här, väntar på ask-done. */
  readonly sent: boolean;
  /** Töm allt känsligt (lösenordsfältet), t.ex. när HUD:en stängs. */
  wipe(): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export function button(text: string, cls = 'wbh-btn'): HTMLButtonElement {
  const b = el('button', cls, text);
  b.type = 'button';
  return b;
}

export function askCard(ask: Ask, answer: AnswerFn): Card {
  if (ask.kind === 'permission') return permissionCard(ask, answer);
  if (ask.kind === 'question') return questionCard(ask.questions, answer);
  return secretCard(ask.label, answer);
}

/** Gemensamt: markera kortet som skickat, och öppna det igen om sändningen inte gick fram. */
function sender(card: HTMLElement) {
  let sent = false;
  return {
    get sent() {
      return sent;
    },
    send(fn: () => boolean): boolean {
      if (sent) return false;
      sent = true;
      card.classList.add('is-sent');
      for (const b of card.querySelectorAll('button')) b.disabled = true;
      const ok = fn();
      if (!ok) {
        sent = false;
        card.classList.remove('is-sent');
        for (const b of card.querySelectorAll('button')) b.disabled = false;
      }
      return ok;
    },
  };
}

function permissionCard(ask: Extract<Ask, { kind: 'permission' }>, answer: AnswerFn): Card {
  const card = el('div', 'wbh-card');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', ask.title);
  card.append(el('div', 'wbh-card-title', ask.title));
  if (ask.detail.trim()) card.append(el('div', 'wbh-card-detail', ask.detail));
  const s = sender(card);
  const row = el('div', 'wbh-actions');
  // Med defaultNo är Neka förvalt och Enter godkänner aldrig.
  const allow = button('Tillåt', ask.defaultNo ? 'wbh-btn' : 'wbh-btn is-primary');
  const always = ask.canRemember ? button('Alltid') : null;
  const deny = button('Neka', ask.defaultNo ? 'wbh-btn is-primary' : 'wbh-btn');
  allow.addEventListener('click', () => s.send(() => answer('allow')));
  always?.addEventListener('click', () => s.send(() => answer('allow-always')));
  deny.addEventListener('click', () => s.send(() => answer('deny')));
  if (ask.defaultNo) {
    for (const b of [allow, always]) {
      b?.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') e.preventDefault();
      });
    }
  }
  row.append(allow, ...(always ? [always] : []), deny);
  card.append(row);
  return {
    el: card,
    focusTarget: () => (ask.defaultNo ? deny : allow),
    get sent() {
      return s.sent;
    },
    wipe() {},
  };
}

const CHECK_SVG = 'M3.5 8.4 6.6 11.4 12.6 4.8';

function checkMark(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('wbh-check');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', CHECK_SVG);
  svg.append(p);
  return svg;
}

function questionCard(questions: AskQuestion[], answer: AnswerFn): Card {
  const card = el('div', 'wbh-card');
  card.setAttribute('role', 'group');
  const s = sender(card);
  const immediate = questions.length === 1 && !questions[0].multiSelect;
  const picks = questions.map(() => new Set<number>());
  let first: HTMLElement | null = null;
  let done: HTMLButtonElement | null = null;

  const refresh = () => {
    if (done) done.disabled = s.sent || picks.some((p) => p.size === 0);
  };

  questions.forEach((q, qi) => {
    const block = el('div', 'wbh-q');
    const title = el('div', 'wbh-card-title', q.question);
    title.id = `wbh-q-${Math.random().toString(36).slice(2, 9)}`;
    block.append(title);
    const opts = el('div', 'wbh-opts');
    opts.setAttribute('role', immediate ? 'group' : q.multiSelect ? 'group' : 'radiogroup');
    opts.setAttribute('aria-labelledby', title.id);
    const buttons: HTMLButtonElement[] = [];
    q.options.forEach((o, oi) => {
      const b = button('', 'wbh-opt');
      if (!immediate) {
        b.setAttribute('role', q.multiSelect ? 'checkbox' : 'radio');
        b.setAttribute('aria-checked', 'false');
        b.append(checkMark());
      }
      const text = el('span', 'wbh-opt-text');
      text.append(el('span', 'wbh-opt-label', o.label));
      if (o.description?.trim()) text.append(el('span', 'wbh-opt-desc', o.description));
      b.append(text);
      b.addEventListener('click', () => {
        if (s.sent) return;
        if (immediate) {
          s.send(() => answer('answered', { answers: { [q.question]: o.label } }));
          return;
        }
        const set = picks[qi];
        if (q.multiSelect) {
          if (set.has(oi)) set.delete(oi);
          else set.add(oi);
        } else {
          set.clear();
          set.add(oi);
        }
        buttons.forEach((x, i) => x.setAttribute('aria-checked', String(set.has(i))));
        refresh();
      });
      buttons.push(b);
      opts.append(b);
      first ??= b;
    });
    block.append(opts);
    card.append(block);
  });

  if (!immediate) {
    const row = el('div', 'wbh-actions');
    done = button('Klar', 'wbh-btn is-primary');
    done.addEventListener('click', () => {
      if (picks.some((p) => p.size === 0)) return;
      const answers: Record<string, string> = {};
      questions.forEach((q, qi) => {
        answers[q.question] = [...picks[qi]].sort((a, b) => a - b).map((i) => q.options[i].label).join(', ');
      });
      s.send(() => answer('answered', { answers }));
      refresh();
    });
    row.append(done);
    card.append(row);
    refresh();
  }

  return {
    el: card,
    focusTarget: () => first,
    get sent() {
      return s.sent;
    },
    wipe() {},
  };
}

function secretCard(label: string, answer: AnswerFn): Card {
  const card = el('div', 'wbh-card');
  card.setAttribute('role', 'group');
  card.setAttribute('aria-label', label);
  card.append(el('div', 'wbh-card-title', label));
  const s = sender(card);
  const field = el('div', 'wbh-secret-field');
  let input = makeInput();
  field.append(input);
  card.append(field);

  function makeInput(): HTMLInputElement {
    const i = el('input', 'wbh-secret');
    i.type = 'password';
    i.autocomplete = 'off';
    i.spellcheck = false;
    i.setAttribute('autocapitalize', 'off');
    i.setAttribute('aria-label', label);
    i.setAttribute('data-1p-ignore', '');
    i.setAttribute('data-lpignore', 'true');
    i.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) {
        e.preventDefault();
        save();
      }
    });
    return i;
  }

  const row = el('div', 'wbh-actions');
  const saveBtn = button('Spara', 'wbh-btn is-primary');
  const cancel = button('Avbryt');
  row.append(saveBtn, cancel);
  card.append(row);

  function save(): void {
    if (s.sent) return;
    if (!input.value) {
      input.focus();
      return;
    }
    const ok = s.send(() => {
      const ok2 = answer('answered', { secret: input.value });
      return ok2;
    });
    // Värdet lämnar DOM:en direkt, oavsett om sändningen gick fram.
    input.value = '';
    input.remove();
    if (!ok) {
      input = makeInput();
      field.append(input);
    }
  }
  saveBtn.addEventListener('click', save);
  cancel.addEventListener('click', () => {
    input.value = '';
    s.send(() => answer('deny'));
  });

  return {
    el: card,
    focusTarget: () => (input.isConnected ? input : null),
    get sent() {
      return s.sent;
    },
    wipe() {
      input.value = '';
    },
  };
}
