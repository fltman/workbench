// sdk/wb.js — appbryggan (CONTRACT §11). Ett vanligt skript (ingen modul) som servern lägger först i
// <head> på varje app-sida. CSS-variablerna, window.wb och loggningen fungerar alltid, även på toppnivå
// (skärmbilder, egen flik). Bara delarna som pratar med skalet (hjul, tangenter, focus, hello, sidor och märket)
// hoppas över när window.parent === window.
(() => {
  'use strict';
  const MARK = Symbol.for('workbench.wb');
  if (window[MARK]) return; // aldrig två gånger i samma dokument
  window[MARK] = true;

  const ORIGIN = location.origin;
  /** Skalet är alltid http://localhost:<samma port>. Bara dit skickas meddelanden, och bara därifrån tas de emot. */
  const SHELL = location.protocol + '//localhost' + (location.port ? ':' + location.port : '');
  const EMBEDDED = window.parent !== window;
  const nativeFetch = window.fetch.bind(window); // tas före appens egna skript, som kan byta ut fetch
  const KEY_RE = /^[A-Za-z0-9._-]{1,100}$/;
  const FACE_RE = /^[a-z0-9-]{1,32}$/;
  const STORE = ORIGIN + '/__wb/store';
  const LOG = ORIGIN + '/__wb/log';

  function post(msg) {
    if (!EMBEDDED) return;
    try {
      window.parent.postMessage(msg, SHELL);
    } catch {
      /* skalet är borta */
    }
  }

  /* ------------------------------ CSS-variabler ------------------------------ */
  // En regel på :root före allt annat i <head>, så att appens egna :root-regler kan skriva över den.
  const style = document.createElement('style');
  style.textContent =
    ':root{--wb-accent:#2f6bff;--wb-radius:12px;' +
    '--wb-font:-apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif}';
  (document.head || document.documentElement)?.append(style);

  /* ------------------------------ loggar → POST /__wb/log ------------------------------ */
  const MAX_BATCH = 50;
  const MAX_TEXT = 2000;
  const MAX_QUEUE = 500;
  let queue = [];
  let dropped = 0;
  let timer = 0;
  let inLog = false; // spärr mot rekursion: inget i loggvägen får logga igen
  /** Appens rev när sidan laddades (x-wb-rev från /__wb/app.json): felsignalen räknar bara nuvarande version (§7.2). */
  let pageRev = '';

  function show(v) {
    if (typeof v === 'string') return v;
    if (v && typeof v === 'object') {
      if (typeof v.message === 'string' && typeof v.name === 'string') return typeof v.stack === 'string' && v.stack ? v.stack : v.name + ': ' + v.message;
      if (typeof v.nodeType === 'number' && typeof v.nodeName === 'string') return '<' + v.nodeName.toLowerCase() + '>';
      try {
        const s = JSON.stringify(v);
        if (s !== undefined) return s;
      } catch {
        /* cirkulär eller BigInt: faller igenom */
      }
      return Object.prototype.toString.call(v);
    }
    return String(v);
  }

  /** Som konsolen: en första sträng med %s, %d, %i, %f, %o, %O och %c får argumenten insatta. */
  function format(args) {
    if (typeof args[0] !== 'string' || !args[0].includes('%')) return args.map(show).join(' ');
    let i = 1;
    const head = args[0].replace(/%[sdifoOc]/g, (m) => {
      if (i >= args.length) return m;
      const v = args[i++];
      if (m === '%c') return '';
      if (m === '%d' || m === '%i') return String(parseInt(v, 10));
      if (m === '%f') return String(parseFloat(v));
      return show(v);
    });
    return [head, ...args.slice(i).map(show)].join(' ');
  }

  function record(level, text) {
    if (queue.length >= MAX_QUEUE) {
      dropped++;
      return;
    }
    queue.push({ level, text: String(text).slice(0, MAX_TEXT) });
    if (!timer) timer = setTimeout(flush, 500);
  }

  function flush(final) {
    clearTimeout(timer);
    timer = 0;
    if (dropped && queue.length < MAX_QUEUE) {
      queue.push({ level: 'warn', text: 'wb: ' + dropped + ' loggrader släpptes' });
      dropped = 0;
    }
    let batch = queue.splice(0, MAX_BATCH);
    if (!batch.length) return;
    let body = JSON.stringify(batch);
    if (final === true) {
      // keepalive-förfrågningar får vara högst 64 kB; resten hinner inte iväg när sidan stängs
      while (batch.length > 1 && new Blob([body]).size > 60000) body = JSON.stringify((batch = batch.slice(0, batch.length >> 1)));
    }
    const headers = { 'content-type': 'application/json' };
    if (pageRev) headers['x-wb-rev'] = pageRev;
    try {
      nativeFetch(LOG, { method: 'POST', headers, body, keepalive: final === true }).catch(() => {});
    } catch {
      /* ett misslyckat loggutskick loggas aldrig */
    }
    if (queue.length && final !== true) timer = setTimeout(flush, 500);
  }

  /** Kör fn med rekursionsspärren på; fel i loggvägen sväljs. */
  function guarded(fn) {
    if (inLog) return;
    inLog = true;
    try {
      fn();
    } catch {
      /* hoppa över posten */
    } finally {
      inLog = false;
    }
  }

  for (const level of ['error', 'warn']) {
    const original = console[level];
    console[level] = function (...args) {
      guarded(() => record(level, format(args)));
      return original.apply(this, args);
    };
  }

  addEventListener('error', (e) => {
    if (!(e instanceof ErrorEvent)) return;
    guarded(() => {
      const err = e.error;
      if (err && typeof err.stack === 'string' && err.stack) record('error', 'Uncaught ' + err.stack);
      else record('error', (e.message || 'Uncaught error') + (e.filename ? ' (' + e.filename + ':' + e.lineno + ':' + e.colno + ')' : ''));
    });
  });

  addEventListener('unhandledrejection', (e) => guarded(() => record('error', 'Uncaught (in promise) ' + show(e.reason))));

  addEventListener('pagehide', () => flush(true));

  /* ------------------------------ appen och sidorna ------------------------------ */
  const hostId = location.hostname.endsWith('.localhost') ? location.hostname.slice(0, -'.localhost'.length) : location.hostname;
  let app = Object.freeze({ id: hostId, name: '', faces: Object.freeze([]) });
  let current = '';
  let currentFromShell = false;
  const listeners = new Set();

  /** Sidan som det här dokumentet visar: location.pathname mot faces[].page ("/" är första sidan). */
  function pageFace() {
    const faces = app.faces;
    for (let i = 0; i < faces.length; i++) {
      let path;
      try {
        path = new URL(faces[i].page, ORIGIN + '/').pathname;
      } catch {
        continue;
      }
      if (path === location.pathname || (i === 0 && location.pathname === '/')) return faces[i].id;
    }
    return '';
  }

  function setCurrent(id) {
    if (id === current) return;
    current = id;
    for (const fn of [...listeners]) {
      try {
        fn(id);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function useManifest(m) {
    const valid = m && Array.isArray(m.faces) ? m.faces.filter((f) => f && typeof f.id === 'string' && FACE_RE.test(f.id) && typeof f.page === 'string') : [];
    const faces = valid.length ? valid : [{ id: 'main', page: 'index.html' }];
    app = Object.freeze({
      id: m && typeof m.id === 'string' ? m.id : hostId,
      name: m && typeof m.name === 'string' ? m.name : '',
      faces: Object.freeze(faces.map((f) => Object.freeze({ ...f }))),
    });
    if (!currentFromShell) current = pageFace();
  }

  const appLoaded = nativeFetch(ORIGIN + '/__wb/app.json', { cache: 'no-store' })
    .then((res) => {
      const r = res.headers.get('x-wb-rev');
      if (r && /^\d{1,16}$/.test(r)) pageRev = r;
      return res.ok ? res.json() : Promise.reject(new Error('HTTP ' + res.status));
    })
    .then(useManifest)
    .catch((err) => {
      useManifest(null);
      console.warn('wb: kunde inte läsa /__wb/app.json (' + (err && err.message ? err.message : err) + ')');
    });

  // I en iframe väntar wb.ready också på skalets första face-meddelande, men högst 1 s.
  let faceArrived = () => {};
  const firstFace = EMBEDDED
    ? new Promise((resolve) => {
        faceArrived = resolve;
        setTimeout(resolve, 1000);
      })
    : Promise.resolve();

  function showFace(id) {
    if (typeof id !== 'string' || !FACE_RE.test(id)) throw new TypeError('wb.face.show: ogiltigt sid-id ' + JSON.stringify(String(id)) + ' (a–z, 0–9 och bindestreck, högst 32 tecken)');
    if (app.faces.length && !app.faces.some((f) => f.id === id)) console.warn('wb.face.show: appen har ingen sida "' + id + '"');
    // I en provkörning (try_app, toppnivå) byter sidan själv till den andra sidans fil, som skalet annars gör.
    if (window.__wbTry === true && window.parent === window) {
      const f = app.faces.find((x) => x.id === id);
      if (f) location.assign('/' + f.page.split('/').map(encodeURIComponent).join('/'));
      return;
    }
    post({ wb: 1, type: 'face', show: id }); // på toppnivå gör post ingenting
  }

  /* ------------------------------ kanalen mellan appens sidor (§11) ------------------------------ */
  // En BroadcastChannel per app för wb.store.onChange och wb.faces. Den når appens andra sidor och fönster (samma
  // origin), aldrig avsändaren själv, och har ingen historik: en sida läser det den behöver när den laddas.
  const changeFns = new Set();
  const faceFns = new Set();
  let channel = null;

  function deliver(d) {
    if (!d || d.wb !== 1) return;
    const change = d.kind === 'store' && typeof d.key === 'string';
    if (!change && d.kind !== 'faces') return;
    const arg = change ? Object.freeze({ key: d.key }) : d.msg;
    for (const fn of [...(change ? changeFns : faceFns)]) {
      try {
        fn(arg);
      } catch (err) {
        console.error(err);
      }
    }
  }

  function chan() {
    if (channel === null) {
      try {
        channel = new BroadcastChannel('wb:' + hostId);
        channel.onmessage = (e) => deliver(e.data);
      } catch {
        channel = false; // utan BroadcastChannel finns ingen kanal
      }
    }
    return channel || null;
  }

  function broadcast(d) {
    const ch = chan();
    if (ch) ch.postMessage(d);
  }

  function listen(fns, fn, what) {
    if (typeof fn !== 'function') throw new TypeError(what + ': en funktion behövs');
    chan();
    fns.add(fn);
    return () => {
      fns.delete(fn);
    };
  }

  /* ------------------------------ wb.store → /__wb/store ------------------------------ */
  function keyUrl(key, op) {
    if (typeof key !== 'string' || !KEY_RE.test(key) || key === '.' || key === '..') {
      const shown = typeof key === 'string' ? JSON.stringify(key.length > 60 ? key.slice(0, 60) + '…' : key) : typeof key;
      throw new TypeError(
        'wb.store.' + op + ': ogiltig nyckel ' + shown + '. En nyckel är 1–100 tecken av A–Z, a–z, 0–9, punkt, understreck och bindestreck (men inte "." eller "..").',
      );
    }
    return STORE + '/' + key;
  }

  const failed = (what, res) => new Error(what + ' misslyckades: HTTP ' + res.status);

  const store = Object.freeze({
    get(key) {
      const url = keyUrl(key, 'get');
      // x-wb-optional: en saknad nyckel ger 204 i stället för 404, så att Chrome inte loggar ett fel (K6).
      return nativeFetch(url, { cache: 'no-store', headers: { 'x-wb-optional': '1' } }).then((res) => {
        if (res.status === 204 || res.status === 404) return undefined;
        if (!res.ok) throw failed('wb.store.get("' + key + '")', res);
        return res.json();
      });
    },
    set(key, value) {
      const url = keyUrl(key, 'set');
      let body;
      try {
        body = JSON.stringify(value);
      } catch (err) {
        throw new TypeError('wb.store.set: värdet för "' + key + '" går inte att spara som JSON (' + (err && err.message) + ')');
      }
      if (body === undefined) throw new TypeError('wb.store.set: värdet för "' + key + '" går inte att spara som JSON');
      if (new Blob([body]).size > 1024 * 1024) throw new RangeError('wb.store.set: värdet för "' + key + '" är större än 1 MB');
      return nativeFetch(url, { method: 'PUT', headers: { 'content-type': 'application/json' }, body }).then((res) => {
        if (!res.ok) throw failed('wb.store.set("' + key + '")', res);
        broadcast({ wb: 1, kind: 'store', key });
      });
    },
    delete(key) {
      const url = keyUrl(key, 'delete');
      return nativeFetch(url, { method: 'DELETE' }).then((res) => {
        if (!res.ok && res.status !== 404) throw failed('wb.store.delete("' + key + '")', res);
        broadcast({ wb: 1, kind: 'store', key });
      });
    },
    all() {
      return nativeFetch(STORE, { cache: 'no-store' }).then((res) => {
        if (!res.ok) throw failed('wb.store.all()', res);
        return res.json();
      });
    },
    /** I appens andra sidor och fönster, med { key }, när en set eller delete gått igenom. Bara senare ändringar. */
    onChange(fn) {
      return listen(changeFns, fn, 'wb.store.onChange');
    },
  });

  const faces = Object.freeze({
    post(msg) {
      try {
        broadcast({ wb: 1, kind: 'faces', msg });
      } catch (err) {
        throw new TypeError('wb.faces.post: meddelandet går inte att skicka till de andra sidorna (' + (err && err.message) + ')');
      }
    },
    onMessage(fn) {
      return listen(faceFns, fn, 'wb.faces.onMessage');
    },
  });

  /** Appens märke bredvid pricken (§10.5). Skalet tvättar texten och behåller högst tre tecken. */
  function badge(text) {
    let t = text === undefined ? null : text;
    if (typeof t === 'number' && Number.isFinite(t)) t = String(t);
    if (t !== null && typeof t !== 'string') throw new TypeError('wb.badge: en sträng, ett tal eller null behövs');
    post({ wb: 1, type: 'badge', text: t }); // på toppnivå gör post ingenting
  }

  /* ------------------------------ wb.onOpen (fältet, §10.9) ------------------------------ */
  // Det som skrivs i Workbench-fältet och lämnas till appen: en adress, ett datum eller en text. Kommer det innan
  // appen hunnit anropa wb.onOpen sparas det (högst 10) och lämnas vid första anropet.
  const openFns = new Set();
  const openQueue = [];
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  function validItem(it) {
    if (!it || typeof it !== 'object') return null;
    if (it.kind === 'url' && typeof it.url === 'string' && /^https?:\/\//i.test(it.url) && it.url.length <= 2000) return Object.freeze({ kind: 'url', url: it.url });
    if (it.kind === 'date' && typeof it.date === 'string' && DATE_RE.test(it.date)) return Object.freeze({ kind: 'date', date: it.date });
    if (it.kind === 'text' && typeof it.text === 'string' && it.text.length <= 2000) return Object.freeze({ kind: 'text', text: it.text });
    return null;
  }
  function giveOpen(item) {
    if (!openFns.size) {
      if (openQueue.length < 10) openQueue.push(item);
      return;
    }
    for (const fn of [...openFns]) {
      try {
        fn(item);
      } catch (err) {
        console.error('wb.onOpen:', err);
      }
    }
  }

  /* ------------------------------ window.wb ------------------------------ */
  window.wb = Object.freeze({
    onOpen(fn) {
      if (typeof fn !== 'function') throw new TypeError('wb.onOpen: en funktion behövs');
      openFns.add(fn);
      for (const item of openQueue.splice(0)) giveOpen(item);
      return () => {
        openFns.delete(fn);
      };
    },
    ready: Promise.all([appLoaded, firstFace]).then(() => undefined),
    get app() {
      return app;
    },
    face: Object.freeze({
      get current() {
        return current;
      },
      show: showFace,
      onChange(fn) {
        if (typeof fn !== 'function') throw new TypeError('wb.face.onChange: en funktion behövs');
        listeners.add(fn);
        return () => {
          listeners.delete(fn);
        };
      },
    }),
    store,
    faces,
    badge,
  });

  if (!EMBEDDED) return; // på toppnivå finns inget skal att prata med

  /* ------------------------------ meddelanden från skalet ------------------------------ */
  addEventListener(
    'message',
    (e) => {
      if (e.origin !== SHELL || e.source !== window.parent) return;
      e.stopImmediatePropagation(); // skalets protokoll är inte appens sak
      const d = e.data;
      if (d && d.wb === 1 && d.type === 'open') {
        const item = validItem(d.item);
        if (item) giveOpen(item);
        return;
      }
      if (!d || d.wb !== 1 || d.type !== 'face' || typeof d.current !== 'string' || !FACE_RE.test(d.current)) return;
      currentFromShell = true;
      faceArrived();
      setCurrent(d.current);
    },
    true,
  );

  const loaded = new Promise((resolve) => {
    if (document.readyState === 'complete') resolve();
    else addEventListener('load', () => resolve(), { once: true });
  });
  Promise.all([loaded, appLoaded]).then(() => post({ wb: 1, type: 'hello', face: pageFace(), w: innerWidth, h: innerHeight }));

  addEventListener('pointerdown', () => post({ wb: 1, type: 'focus' }), true);

  /* ------------------------------ hjulet ------------------------------ */
  // Pekarhändelser har fraktionella koordinater, hjulhändelser hela tal. Den senaste pekarpositionen
  // används när den ligger inom 1 px från hjulets, så att zoom kring markören står still.
  let px = NaN;
  let py = NaN;
  addEventListener(
    'pointermove',
    (e) => {
      px = e.clientX;
      py = e.clientY;
    },
    { capture: true, passive: true },
  );

  const SCROLLS = /^(auto|scroll|overlay)$/;
  const CLIPS = /^(hidden|clip)$/;

  /** Axlar vars scrollposition går från −max till 0 (rtl, vertical-rl, row-/column-reverse i flex). */
  function reversed(cs, flex) {
    const wm = cs.writingMode;
    const rtl = cs.direction === 'rtl';
    const fd = flex && /flex$/.test(cs.display) ? cs.flexDirection : 'row';
    const rowRev = fd === 'row-reverse';
    const colRev = fd === 'column-reverse';
    if (!wm || wm === 'horizontal-tb') return { x: rtl !== rowRev, y: colRev };
    return { x: (wm === 'vertical-rl' || wm === 'sideways-rl') !== colRev, y: rtl !== rowRev };
  }

  function room(pos, max, rev, d) {
    if (max < 1) return false;
    return d > 0 ? pos < (rev ? 0 : max) - 1 : pos > (rev ? -max : 0) + 1;
  }

  /** viewportOf: stilen vars overflow gäller vyn, när el är dokumentets scrollande element. */
  function scrolls(el, cs, viewportOf, dx, dy) {
    const sy = viewportOf ? !CLIPS.test(viewportOf.overflowY) : SCROLLS.test(cs.overflowY);
    const sx = viewportOf ? !CLIPS.test(viewportOf.overflowX) : SCROLLS.test(cs.overflowX);
    if (!sx && !sy) return false;
    const rev = reversed(cs, !viewportOf);
    return (
      (!!dy && sy && room(el.scrollTop, el.scrollHeight - el.clientHeight, rev.y, dy)) ||
      (!!dx && sx && room(el.scrollLeft, el.scrollWidth - el.clientWidth, rev.x, dx))
    );
  }

  /** Kan något under markören, eller sidan själv, scrolla åt hjulets håll? */
  function canScroll(e, dx, dy) {
    const root = document.documentElement;
    const body = document.body;
    const rs = root && getComputedStyle(root);
    const bs = body && getComputedStyle(body);
    // body:s overflow flyttas till vyn när html:s är visible åt båda håll (CSS Overflow 3).
    const bodyIsViewport = !!(rs && bs && rs.overflowX === 'visible' && rs.overflowY === 'visible' && (bs.overflowX !== 'visible' || bs.overflowY !== 'visible'));
    for (const el of e.composedPath()) {
      if (el === root || el === document || el === window) break;
      if (!el || el.nodeType !== 1 || (el === body && bodyIsViewport)) continue;
      if (scrolls(el, el === body ? bs : getComputedStyle(el), null, dx, dy)) return true;
    }
    const se = document.scrollingElement;
    if (!se || !rs) return false;
    return scrolls(se, bs || rs, bodyIsViewport ? bs : rs, dx, dy);
  }

  addEventListener(
    'wheel',
    (e) => {
      const dx = e.deltaX;
      const dy = e.deltaY;
      let action;
      if (e.ctrlKey) action = 'zoom';
      else if (e.metaKey) action = 'pan';
      else if (e.altKey) action = 'alt';
      else {
        // data-wb-wheel="app" på <html>: appen tar hand om vanliga hjul själv (kartor, ritytor).
        // Modifierade hjul (ctrl, ⌘, ⌥) går ändå till skalet.
        if (document.documentElement && document.documentElement.getAttribute('data-wb-wheel') === 'app') return;
        let mine = false;
        try {
          mine = canScroll(e, dx, dy);
        } catch {
          /* hellre panorera än låta webbläsaren göra något oväntat */
        }
        if (mine) return; // appen scrollar själv
        action = 'pan';
      }
      if (e.cancelable) e.preventDefault();
      const near = Math.abs(px - e.clientX) <= 1 && Math.abs(py - e.clientY) <= 1;
      post({
        wb: 1,
        type: 'wheel',
        action,
        dx,
        dy,
        mode: e.deltaMode,
        x: near ? px : e.clientX,
        y: near ? py : e.clientY,
        momentum: e.momentum === true,
        alt: e.altKey,
        smart: action === 'zoom' && dx === 0 && dy === 0 && e.wheelDeltaY === 0,
      });
    },
    { capture: true, passive: false },
  );

  /* ------------------------------ tangenter ------------------------------ */
  const sendKey = (e, code) => post({ wb: 1, type: 'key', code, meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey });

  // ⌘K, ⌘0 och ⌃⌥←/→ hör till skalet: de tas innan appen ser dem. Upprepningar (tangent hålls nere)
  // tas om hand men skickas aldrig vidare: annars växlar ett hållet ⌘K HUD:en många gånger i sekunden.
  addEventListener(
    'keydown',
    (e) => {
      if (e.isComposing) return;
      const c = e.code;
      if (!((e.metaKey && (c === 'KeyK' || c === 'Digit0')) || (e.ctrlKey && e.altKey && (c === 'ArrowLeft' || c === 'ArrowRight')))) return;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (!e.repeat) sendKey(e, c);
    },
    true,
  );

  // Esc får appen först. Den skickas vidare bara om ingen i appen anropat preventDefault. Det syns först
  // när händelsen gått klart, eftersom appens egna lyssnare på window körs efter den här.
  addEventListener('keydown', (e) => {
    if (e.isComposing || e.repeat || (e.code !== 'Escape' && e.key !== 'Escape')) return;
    let modal = false;
    try {
      modal = !!document.querySelector('dialog:modal, :popover-open:not([popover="manual" i])');
    } catch {
      /* äldre webbläsare */
    }
    if (modal) return; // webbläsaren stänger appens egen dialog
    setTimeout(() => {
      if (!e.defaultPrevented) sendKey(e, 'Escape');
    }, 0);
  });
})();
