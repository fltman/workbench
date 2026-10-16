// markdown-dom.ts — bygger DOM ur markdown-trädet (markdown.ts). Bara createElement och textContent:
// ingen sträng från Claude blir någonsin HTML (CONTRACT §2.8, §13).
import type { Block, Inline } from './markdown.ts';

export function renderBlocks(blocks: Block[], doc: Document = document): DocumentFragment {
  const frag = doc.createDocumentFragment();
  for (const b of blocks) frag.append(renderBlock(b, doc));
  return frag;
}

function renderBlock(b: Block, doc: Document): HTMLElement {
  switch (b.t) {
    case 'p': {
      const p = doc.createElement('p');
      appendInline(p, b.children, doc);
      return p;
    }
    case 'pre': {
      const pre = doc.createElement('pre');
      const code = doc.createElement('code');
      code.textContent = b.text;
      pre.append(code);
      return pre;
    }
    case 'ul':
    case 'ol': {
      const list = doc.createElement(b.t);
      if (b.t === 'ol' && b.start !== 1) (list as HTMLOListElement).start = b.start;
      for (const item of b.items) {
        const li = doc.createElement('li');
        appendInline(li, item, doc);
        list.append(li);
      }
      return list;
    }
  }
}

function appendInline(parent: HTMLElement, xs: Inline[], doc: Document): void {
  for (const x of xs) {
    switch (x.t) {
      case 'text':
        parent.append(doc.createTextNode(x.text));
        break;
      case 'br':
        parent.append(doc.createElement('br'));
        break;
      case 'code': {
        const c = doc.createElement('code');
        c.textContent = x.text;
        parent.append(c);
        break;
      }
      case 'strong':
      case 'em': {
        const el = doc.createElement(x.t);
        appendInline(el, x.children, doc);
        parent.append(el);
        break;
      }
    }
  }
}
