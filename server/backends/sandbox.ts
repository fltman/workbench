// server/backends/sandbox.ts — SBPL-profilen som en app-backend körs under (CONTRACT §9, §4.5).
//
// sandbox-exec läser profilen en gång, innan backenden startar. Senaste matchande regel vinner,
// så ordningen nedan är viktig. Grunden är kontraktets profil; avvikelserna är uppmätta
// (.scratch/server-backends, se slutrapporten):
//
// - Läsning av hemkatalogen nekas, men Node kör realpath() på varje förfader till appens mapp
//   och till guard.mjs. Utan file-read-metadata på just de katalogerna startar Node inte alls
//   (EPERM: lstat '/Users/<namn>').
// - guard.mjs ligger i workbenchens repo, oftast under hemkatalogen, och måste få läsas.
// - (remote ip "localhost:<port>") släpper igenom ::ffff:127.0.0.1:<port> (IPv4-mappad IPv6).
//   (remote ip "*:<port>") stoppar alla former, så portarna nekas på alla adresser.
// - Alla unix-socketar nekas (tmux, ssh-agent, Docker, gpg-agent och Claude Codes inkorgar), utom
//   mDNSResponder som namnuppslagning kräver (utan den: ENOTFOUND).
// - Med (allow default) når en backend annars LaunchServices (lsappinfo, open) och Apple Events (osascript).
//   Kontraktets två rader (launchservicesd och appleevent-send) räcker inte: uppmätt startade
//   `open -g -j -a Calculator` ändå, eftersom LaunchServices då öppnar via lsd och karantänkontrollen.
//   lsd.* och quarantine-resolver nekas därför också; då misslyckas open med namn, bundle-id och sökväg,
//   medan DNS, fetch och fork-IPC fungerar (tests/unit/server-backends-sandbox.test.ts).
// - Ligger workbenchens hem utanför hemkatalogen (t.ex. en tillfällig WORKBENCH_HOME) stängs det
//   på samma sätt, så att en backend aldrig når andra appars data.
// - Andra backends portar nekas också, så att en app inte kan använda en annan apps API.
// - Delade tillfälliga kataloger (användarens TMPDIR, /private/tmp, /private/var/tmp) stängs för läsning och
//   skrivning (SEC-3): annars kunde två appar (och användarens andra program) prata och läcka genom dem.
//   Varje backend får i stället en egen TMPDIR i appens data/ (supervisor.ts).
import fs from 'node:fs';
import path from 'node:path';

/** Unix-socketen för namnuppslagning (getaddrinfo går via mDNSResponder på macOS). */
export const DNS_SOCKET = '/private/var/run/mDNSResponder';
/** LaunchServices: open, lsappinfo och NSWorkspace går den vägen. */
export const LAUNCH_SERVICES = 'com.apple.coreservices.launchservicesd';
/** lsd (LaunchServices databas och öppning) och karantänkontrollen som open faller tillbaka på. */
export const LSD_REGEX = '^com\\.apple\\.lsd\\.';
export const QUARANTINE_RESOLVER = 'com.apple.coreservices.quarantine-resolver';

export interface ProfileInput {
  /** Användarens hemkatalog, realpath. Allt under den är stängt utom det som öppnas nedan. */
  home: string;
  /** Workbenchens hem (Config.home), realpath. Stängs på samma sätt om det ligger utanför home. */
  workbenchHome: string;
  /** apps/<id>, realpath. Läsbar; bara data/ är skrivbar. */
  appDir: string;
  /** TMPDIR, realpath. Skrivbar (och läsbar om den ligger i ett stängt område). */
  tmpDir: string;
  /** Delade tillfälliga kataloger, realpath. Stängs som hemkatalogen (läsning och skrivning). */
  sharedTmp?: string[];
  /** guard.mjs, realpath. */
  guardFile: string;
  /** Node-installationen som måste vara läsbar, eller null (se nodeReadDir). */
  nodeDir: string | null;
  /** Portar som backenden inte får ansluta till på någon adress: workbenchen, HMR och andra backends. */
  deniedPorts: number[];
}

/** Ligger p i (eller är p) katalogen dir? Båda absoluta och normaliserade. */
export function isWithin(p: string, dir: string): boolean {
  if (dir === '/') return p.startsWith('/');
  return p === dir || p.startsWith(dir + '/');
}

/** En SBPL-strängliteral. Vägrar kontrolltecken i stället för att försöka citera dem. */
export function sbplString(s: string): string {
  if (typeof s !== 'string' || s.length === 0) throw new Error('tom sökväg i sandlådeprofilen');
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new Error(`kontrolltecken i sökväg till sandlådeprofilen: ${JSON.stringify(s)}`);
  return '"' + s.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

function checkAbsolute(label: string, p: string): string {
  if (typeof p !== 'string' || !path.isAbsolute(p) || path.normalize(p) !== p || (p.length > 1 && p.endsWith('/'))) {
    throw new Error(`${label} måste vara en absolut, normaliserad sökväg: ${JSON.stringify(p)}`);
  }
  sbplString(p);
  return p;
}

/**
 * Katalogen med Node-installationen som backenden måste kunna läsa: prefixet ovanför bin/
 * (där också lib/libnode ligger). Skulle prefixet vara ett stängt område självt, eller en förfader
 * till det (t.ex. ~/bin/node), öppnas bara binärens egen katalog.
 */
export function nodeReadDir(execPath: string, closedRoots: string[]): string {
  const real = fs.realpathSync.native(execPath);
  const binDir = path.dirname(real);
  const prefix = path.dirname(binDir);
  return closedRoots.some((r) => isWithin(r, prefix)) ? binDir : prefix;
}

/** De stängda områdena: hemkatalogen, och workbenchens hem om det ligger utanför den. */
export function closedRoots(home: string, workbenchHome: string): string[] {
  return isWithin(workbenchHome, home) ? [home] : [home, workbenchHome];
}

/** Alla förfäder till p som ligger i ett stängt område (roten inräknad), närmast roten först. */
function ancestorsInside(p: string, roots: string[]): string[] {
  const out: string[] = [];
  for (const root of roots) {
    if (!isWithin(p, root) || p === root) continue;
    for (let d = path.dirname(p); isWithin(d, root); d = path.dirname(d)) {
      out.push(d);
      if (d === root) break;
    }
  }
  return out;
}

function checkPort(p: number): number {
  if (!Number.isInteger(p) || p < 1 || p > 65535) throw new Error(`ogiltig port i sandlådeprofilen: ${p}`);
  return p;
}

export function buildProfile(input: ProfileInput): string {
  const home = checkAbsolute('home', input.home);
  const wbHome = checkAbsolute('workbenchHome', input.workbenchHome);
  const appDir = checkAbsolute('appDir', input.appDir);
  const tmpDir = checkAbsolute('tmpDir', input.tmpDir);
  const guardFile = checkAbsolute('guardFile', input.guardFile);
  const nodeDir = input.nodeDir === null ? null : checkAbsolute('nodeDir', input.nodeDir);
  const shared = (input.sharedTmp ?? []).map((p) => checkAbsolute('sharedTmp', p));
  const roots = [...new Set([...closedRoots(home, wbHome), ...shared])];
  if (roots.some((r) => isWithin(r, appDir))) throw new Error('appens mapp får inte innehålla ett stängt område');
  if (nodeDir && roots.some((r) => isWithin(r, nodeDir))) throw new Error('Node-katalogen får inte innehålla ett stängt område');
  const ports = [...new Set(input.deniedPorts.map(checkPort))];

  const q = sbplString;
  const sub = (p: string) => `(subpath ${q(p)})`;
  const lit = (p: string) => `(literal ${q(p)})`;
  const closed = (p: string) => roots.some((r) => isWithin(p, r));

  // Det som måste vara läsbart fast det ligger i ett stängt område.
  const readable: { path: string; filter: string }[] = [{ path: appDir, filter: sub(appDir) }];
  if (closed(guardFile)) readable.push({ path: guardFile, filter: lit(guardFile) });
  if (nodeDir && closed(nodeDir)) readable.push({ path: nodeDir, filter: sub(nodeDir) });
  if (closed(tmpDir)) readable.push({ path: tmpDir, filter: sub(tmpDir) });
  const ancestors = [...new Set(readable.flatMap((r) => ancestorsInside(r.path, roots)))].sort();

  const lines: string[] = [
    '(version 1)',
    '(allow default)',
    '; Skrivning: inget i hemkatalogen (eller workbenchens hem) eller delade tillfälliga kataloger, utom TMPDIR och appens data/.',
    `(deny file-write* ${roots.map(sub).join(' ')})`,
    `(allow file-write* ${sub(tmpDir)})`,
  ];
  // Ligger ett stängt område under TMPDIR (t.ex. en tillfällig WORKBENCH_HOME) stängs det igen.
  const underTmp = roots.filter((r) => isWithin(r, tmpDir) && r !== tmpDir);
  if (underTmp.length) lines.push(`(deny file-write* ${underTmp.map(sub).join(' ')})`);
  lines.push(
    `(allow file-write* ${sub(path.join(appDir, 'data'))})`,
    '; Läsning: inget i hemkatalogen eller delade tillfälliga kataloger, utom appens mapp, guard.mjs och Node.',
    `(deny file-read* ${roots.map(sub).join(' ')})`,
    `(allow file-read* ${readable.map((r) => r.filter).join(' ')})`,
  );
  if (ancestors.length) {
    lines.push('; Node kör realpath() på varje förfader; bara metadata, aldrig innehåll eller listning.');
    lines.push(`(allow file-read-metadata ${ancestors.map(lit).join(' ')})`);
  }
  if (ports.length) {
    lines.push('; *:<port> och inte localhost:<port>: localhost-formen släpper igenom ::ffff:127.0.0.1 (uppmätt).');
    lines.push(`(deny network-outbound ${ports.map((p) => `(remote ip "*:${p}")`).join(' ')})`);
  }
  lines.push(
    '; Inga unix-socketar (tmux, ssh-agent, Docker, Claude Code), utom namnuppslagningen.',
    '(deny network-outbound (remote unix-socket))',
    `(allow network-outbound (remote unix-socket (path-literal ${q(DNS_SOCKET)})))`,
    '; Ingen väg ut via open och LaunchServices, och inga Apple Events till andra program (osascript).',
    `(deny mach-lookup (global-name ${q(LAUNCH_SERVICES)}))`,
    `(deny mach-lookup (global-name-regex #"${LSD_REGEX}") (global-name ${q(QUARANTINE_RESOLVER)}))`,
    '(deny appleevent-send)',
  );
  return lines.join('\n') + '\n';
}
