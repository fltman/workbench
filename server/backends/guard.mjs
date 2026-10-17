// server/backends/guard.mjs — laddas med --import före appens backend (CONTRACT §9).
// Ägs av workbenchen och ligger utanför appen. Det är ingen säkerhetsgräns mot illasinnad kod
// (det är sandlådan och lsof-kontrollen), men den gör de vanliga misstagen ofarliga:
//
// 1. net.Server.prototype.listen binder alltid 127.0.0.1, vilken värd som än anges
//    (listen(PORT) utan värd binder annars :: och nås från nätverket).
// 2. HTTP-förfrågningar och uppgraderingar vars Host inte är 127.0.0.1:<PORT> eller
//    localhost:<PORT> får 421 (skydd mot DNS-rebinding). Proxyn skriver alltid om Host.
//    Serverns egen port räknas också: ett barn ärver vakten (NODE_OPTIONS) och backendens PORT,
//    och dess egen server ska svara på sin port (en sida som rebindar nämner aldrig loopback).
// 3. Backenden avslutas om workbenchen försvinner, så att inga föräldralösa processer
//    blir kvar och håller portar.
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';

const LOOPBACK = '127.0.0.1';
const PORT = process.env.PORT ?? '';
const ALLOWED_HOSTS = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

/* ------------------------------ listen ------------------------------ */

// Samma tolkning som Node själv gör i net.js (toNumber/isPipeName).
const toNumber = (x) => ((x = Number(x)) >= 0 ? x : false);
const isPipeName = (s) => typeof s === 'string' && toNumber(s) === false;

/** Argumenten till listen(), med värden ersatt av 127.0.0.1. Unix-socketar och handtag lämnas orörda. */
function loopbackArgs(args) {
  const first = args[0];
  if (typeof first === 'function') return [0, LOOPBACK, ...args];             // listen(cb)
  if (first !== null && typeof first === 'object') {
    // Handtag, fd eller annan server är redan bundna; lsof-kontrollen fångar fel adress.
    if (first._handle || first.handle || typeof first.fd === 'number') return args;
    if (isPipeName(first.path)) return args;                                  // listen({ path })
    const options = { ...first, host: LOOPBACK };
    delete options.ipv6Only;
    return [options, ...args.slice(1)];
  }
  if (isPipeName(first)) return args;                                         // listen('/väg/till.sock')
  // listen(port[, host][, backlog][, cb]): byt värden, eller lägg till den
  if (args.length > 1 && typeof args[1] === 'string') return [first, LOOPBACK, ...args.slice(2)];
  return [first, LOOPBACK, ...args.slice(1)];
}

const originalListen = net.Server.prototype.listen;
Object.defineProperty(net.Server.prototype, 'listen', {
  value: function listen(...args) {
    return originalListen.apply(this, loopbackArgs(args));
  },
  writable: true,
  configurable: true,
});

/* ------------------------------ Host ------------------------------ */

const REQUEST_EVENTS = new Set(['request', 'checkContinue', 'checkExpectation']);
const SOCKET_EVENTS = new Set(['upgrade', 'connect']);
const BODY = '{"error":"host"}';

function hostAllowed(req) {
  const host = req?.headers?.host;
  if (typeof host !== 'string') return false;
  const name = host.toLowerCase();
  if (ALLOWED_HOSTS.has(name)) return true;
  // listen() binder alltid 127.0.0.1, så localPort är serverns egen port.
  const own = req.socket?.localPort;
  return Number.isInteger(own) && own > 0 && (name === `127.0.0.1:${own}` || name === `localhost:${own}`);
}

function refuseResponse(res) {
  try {
    res.on('error', () => {});
    res.writeHead(421, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': String(BODY.length),
      'cache-control': 'no-store',
      connection: 'close',
    });
    res.end(BODY);
  } catch {
    try { res.socket?.destroy(); } catch {}
  }
}

function refuseSocket(socket) {
  if (!socket || typeof socket.on !== 'function') return;
  socket.on('error', () => {});
  try {
    socket.end(
      'HTTP/1.1 421 Misdirected Request\r\n' +
        'Content-Type: application/json; charset=utf-8\r\n' +
        `Content-Length: ${BODY.length}\r\n` +
        'Cache-Control: no-store\r\n' +
        'Connection: close\r\n\r\n' +
        BODY,
    );
  } catch {}
  setTimeout(() => socket.destroy(), 1000).unref();
}

function guardEmit(proto) {
  const originalEmit = proto.emit;
  Object.defineProperty(proto, 'emit', {
    value: function emit(event, ...args) {
      if (REQUEST_EVENTS.has(event) && !hostAllowed(args[0])) {
        refuseResponse(args[1]);
        return true;
      }
      if (SOCKET_EVENTS.has(event) && !hostAllowed(args[0])) {
        refuseSocket(args[1]);
        return true;
      }
      return originalEmit.call(this, event, ...args);
    },
    writable: true,
    configurable: true,
  });
}

// https.Server ärver inte från http.Server, så båda behöver vakten.
guardEmit(http.Server.prototype);
guardEmit(https.Server.prototype);

/* ------------------------------ föräldern ------------------------------ */

// sandbox-exec ersätter sig själv med node, så föräldern är workbenchens server.
// Byter den (servern dog och processen ärvdes av launchd) avslutas backenden. Föräldern 1 räknas
// också: dog servern redan innan vakten laddades har processen ärvts av launchd från början.
const parent = process.ppid;
const watchdog = setInterval(() => {
  if (process.ppid === parent && parent !== 1) return;
  clearInterval(watchdog);
  process.kill(process.pid, 'SIGTERM');
  setTimeout(() => process.exit(0), 2000).unref();
}, 1000);
watchdog.unref();
