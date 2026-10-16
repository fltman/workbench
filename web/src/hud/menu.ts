// menu.ts — HUD:ens diskreta ⋯-meny (CONTRACT §13): ångra senaste ändringen, öppna i egen flik, minimera (eller
// ta fram) och ta bort appen (bekräftas i menyn med Ta bort/Avbryt). Esc stänger menyn först via pushEscape.
import { pushEscape } from '../escape.ts';
import { button, el } from './asks.ts';
import { reducedMotion } from './motion.ts';

export interface MenuActions {
  canUndo(): boolean;
  canOpenTab(): boolean;
  undo(): void;
  openTab(): void;
  /** Om appens fönster är minimerat (§10.7); null när appen saknar fönster. */
  minimized(): boolean | null;
  toggleMinimize(): void;
  remove(): void;
  /** Menyn stängdes; fokus kan gå tillbaka till inmatningen. */
  closed(restoreFocus: boolean): void;
}

export interface Menu {
  readonly el: HTMLElement;
  readonly open: boolean;
  /** viaKeyboard: fokus flyttas in i menyn (med musen stannar fokus i inmatningen). */
  toggle(viaKeyboard?: boolean): void;
  close(restoreFocus?: boolean): void;
}

export function createMenu(anchor: HTMLButtonElement, host: HTMLElement, a: MenuActions): Menu {
  const menu = el('div', 'wbh-menu');
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  host.append(menu);
  anchor.setAttribute('aria-haspopup', 'menu');
  anchor.setAttribute('aria-expanded', 'false');
  let isOpen = false;
  let popEscape: (() => void) | null = null;

  const onDown = (e: PointerEvent) => {
    const t = e.target as Node | null;
    if (t && (menu.contains(t) || anchor.contains(t))) return;
    close(false);
  };

  function item(text: string, run: () => void, cls = ''): HTMLButtonElement {
    const b = button(text, `wbh-menu-item ${cls}`.trim());
    b.setAttribute('role', 'menuitem');
    b.addEventListener('click', run);
    return b;
  }

  function fill(): void {
    const items: HTMLButtonElement[] = [];
    if (a.canUndo()) {
      items.push(
        item('Ångra senaste ändringen', () => {
          close(true);
          a.undo();
        }),
      );
    }
    if (a.canOpenTab()) {
      items.push(
        item('Öppna i egen flik', () => {
          close(true);
          a.openTab();
        }),
      );
    }
    const mini = a.minimized();
    if (mini !== null) {
      items.push(
        item(mini ? 'Ta fram' : 'Minimera', () => {
          close(false);
          a.toggleMinimize();
        }),
      );
    }
    items.push(item('Ta bort appen', confirm, 'is-danger-text'));
    menu.replaceChildren(...items);
  }

  function confirm(): void {
    const row = el('div', 'wbh-menu-confirm');
    const yes = button('Ta bort', 'wbh-btn is-danger');
    const no = button('Avbryt');
    yes.setAttribute('role', 'menuitem');
    no.setAttribute('role', 'menuitem');
    yes.addEventListener('click', () => {
      close(false);
      a.remove();
    });
    no.addEventListener('click', () => close(true));
    row.append(yes, no);
    menu.replaceChildren(row);
    no.focus({ preventScroll: true });
  }

  menu.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    const items = [...menu.querySelectorAll<HTMLButtonElement>('button')];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    next?.focus({ preventScroll: true });
    e.preventDefault();
  });

  function openMenu(viaKeyboard: boolean): void {
    if (isOpen) return;
    isOpen = true;
    fill();
    menu.hidden = false;
    anchor.setAttribute('aria-expanded', 'true');
    // Med reducerad rörelse tonar menyn bara in.
    menu.animate(
      reducedMotion()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: 'translateY(6px) scale(0.98)' },
            { opacity: 1, transform: 'none' },
          ],
      { duration: 180, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
    popEscape = pushEscape(() => {
      popEscape = null;
      close(true);
    });
    document.addEventListener('pointerdown', onDown, true);
    if (viaKeyboard) menu.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
  }

  function close(restoreFocus = true): void {
    if (!isOpen) return;
    isOpen = false;
    menu.hidden = true;
    menu.replaceChildren();
    anchor.setAttribute('aria-expanded', 'false');
    popEscape?.();
    popEscape = null;
    document.removeEventListener('pointerdown', onDown, true);
    a.closed(restoreFocus);
  }

  return {
    el: menu,
    get open() {
      return isOpen;
    },
    toggle: (viaKeyboard = false) => (isOpen ? close(true) : openMenu(viaKeyboard)),
    close,
  };
}
