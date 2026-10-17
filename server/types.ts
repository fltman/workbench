// server/types.ts — gränssnitten mellan servermodulerna. FRUSET: ändra CONTRACT.md först.
// Varje modul exporterar en fabriksfunktion med exakt signaturen längst ner; server/main.ts kopplar ihop dem.
import type {
  AppInfo, AppManifest, AppStatus, BackendState, Camera, ChatEvent, CreateAppRequest, Scene, ServerMsg, SttResponse, WindowState,
} from '../shared/protocol.ts';

/* ---------------------------- konfiguration ---------------------------- */

export interface Config {
  port: number;            // WORKBENCH_PORT, standard 8220
  hmrPort: number;         // WORKBENCH_HMR_PORT, standard 8229 (Vites HMR-websocket i dev, bunden till 127.0.0.1)
  dev: boolean;            // NODE_ENV !== 'production'
  root: string;            // repo-roten (där package.json ligger), absolut
  home: string;            // WORKBENCH_HOME, standard = root; här ligger apps/ och data/, absolut och realpath:ad
  model: string;           // WORKBENCH_MODEL, standard 'claude-opus-5-5'
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max'; // WORKBENCH_EFFORT, standard 'high'
  fakeClaude: boolean;     // WORKBENCH_FAKE_CLAUDE=1: skriptad låtsas-Claude för tester (inga riktiga anrop)
  fakeSpeed: number;       // WORKBENCH_FAKE_SPEED, standard 1 (2 = dubbelt så fort)
  sandbox: boolean;        // WORKBENCH_SANDBOX, standard true: Claudes Bash och app-backends körs i macOS-sandlåda
  stt: 'auto' | 'whisper' | 'openai' | 'off'; // WORKBENCH_STT, standard 'auto' (lokal whisper först, sedan OpenAI)
  whisperUrl: string;      // WHISPER_URL, standard 'http://127.0.0.1:54205'
  openaiKey?: string;      // OPENAI_API_KEY — läses bara i serverprocessen (stt.ts), förs aldrig vidare till barnprocesser
  idleCloseMs: number;     // WORKBENCH_IDLE_MS, standard 600_000: stäng vilande Claude-process
  permissionTimeoutMs: number; // 300_000: obesvarad fråga i HUD:en => neka
}

/**
 * Miljö för ALLA barnprocesser (Claude, backends, git, ffmpeg, Chrome) — en vitlista, aldrig process.env.
 * Implementeras i server/config.ts:  export function childEnv(extra?: Record<string, string>): Record<string, string>
 * Med: PATH, HOME, USER, LOGNAME, SHELL, TMPDIR, LANG, LC_ALL, LC_CTYPE, TZ, TERM (de som finns) + extra.
 */
export type ChildEnv = (extra?: Record<string, string>) => Record<string, string>;

export interface Paths {
  appsDir: string;                    // <home>/apps
  dataDir: string;                    // <home>/data
  trashDir: string;                   // <home>/data/trash
  sceneFile: string;                  // <home>/data/workbench.json
  /** <home>/apps/<id> — appens filer, Claudes arbetskatalog. KASTAR om id inte matchar APP_ID_RE. */
  appDir(appId: string): string;
  /** <home>/data/apps/<id> — workbenchens egna filer om appen (session.json, chat.jsonl, logs.txt). Claude når dem inte. KASTAR vid ogiltigt id. */
  appDataDir(appId: string): string;
  /** <home>/data/apps/<id>/git — appens git-katalog (utanför Claudes räckvidd). KASTAR vid ogiltigt id. */
  appGitDir(appId: string): string;
}

/* ---------------------------- delade tjänster ---------------------------- */

/** WebSocket-navet mot skalet. */
export interface Hub {
  broadcast(msg: ServerMsg): void;
  /** Antal anslutna skal-flikar. */
  clients(): number;
}

/** Scenen i data/workbench.json. Skrivs atomiskt (tmp + rename), debouncat 200 ms. */
export interface SceneStore {
  get(): Scene;
  window(appId: string): WindowState | undefined;
  upsertWindow(win: WindowState): void;
  removeWindowForApp(appId: string): WindowState | undefined;
  setCamera(camera: Camera): void;
  flush(): Promise<void>;
}

/** Alla appar: mappar under apps/, manifest, status, rev. */
export interface AppRegistry {
  list(): AppInfo[];
  get(appId: string): AppInfo | undefined;
  /** Normaliserat manifest (faces och permissions alltid satta). */
  manifest(appId: string): AppManifest & { faces: NonNullable<AppManifest['faces']>; permissions: NonNullable<AppManifest['permissions']> };
  /** Skapar appmapp + git + frö-filer och fönster (face 0, z = högsta + 1). Sänder 'app' och 'scene.window'. */
  create(req: CreateAppRequest): Promise<{ app: AppInfo; win: WindowState }>;
  /**
   * Flyttar apps/<id> och data/apps/<id> till data/trash/<id>-<tid>/, tar bort fönstret.
   * Sänder 'scene.windowRemoved' och sedan 'app.removed'. Vägrar okända id.
   * Anroparen (DELETE-routen) har redan stoppat sessionen och backenden.
   */
  remove(appId: string): Promise<void>;
  /** Anropas BARA av Claude-sessionerna. */
  setStatus(appId: string, status: AppStatus): void;
  setBackend(appId: string, state: BackendState): void;
  bumpRev(appId: string): void;
  /** Läs om app.json och kontrollera om första sidan finns; sänder 'app' om något ändrats. */
  refresh(appId: string): void;
  /**
   * En loggrad från appen (CONTRACT §7.2): 'console' från sidorna via /__wb/log, med versionen sidan laddade (rev, ur
   * x-wb-rev; en annan än appens nuvarande räknas inte), och 'stderr': sista felraden från en backend som kraschat.
   * Registret avgör om den är ett fel efter turen och sätter i så fall AppInfo.trouble (sänder 'app' en gång).
   */
  noteLog(appId: string, source: 'console' | 'stderr', line: string, rev?: number): void;
  /** Felraderna sedan senaste turslut eller nya version, högst 5 och olika (för förslagen, §8.12). */
  troubles(appId: string): string[];
}

/** Loggar per app: konsolen (via bryggan och skärmbilderna), backendens utdata och workbenchens egna notiser. */
export interface AppLogs {
  append(appId: string, source: 'console' | 'backend' | 'workbench', line: string): void;
  /** De senaste n raderna (standard 80), äldst först, formaterade "HH:MM:SS [källa] text". */
  tail(appId: string, n?: number): string[];
  clear(appId: string): void;
}

/**
 * Git per app med extern git-katalog (Paths.appGitDir) och arbetsträd apps/<id>.
 * Alltid execFile med argv, aldrig skal; -c core.hooksPath=/dev/null -c core.fsmonitor=false -c commit.gpgsign=false;
 * env = childEnv({ GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME/EMAIL, GIT_COMMITTER_NAME/EMAIL = Workbench <workbench@localhost> }).
 */
export interface AppGit {
  init(appId: string): Promise<void>;                         // init + första commit "Ny app"
  commitAll(appId: string, message: string): Promise<boolean>; // false om inget att committa
  undo(appId: string): Promise<boolean>;                      // reset --hard HEAD~1; false om bara första commit finns
  redo(appId: string): Promise<boolean>;                      // ett steg fram mot refs/wb/redo (§6); false om inget att göra om
  canRedo(appId: string): Promise<boolean>;                   // refs/wb/redo finns och HEAD är en äkta förfader till den
}

/** App-backends: en nodeprocess per app med backend, bakom proxyn på /api/*. */
export interface Backends {
  /** Starta om den inte kör. Löser till porten, eller null om appen saknar backend eller inte kom upp. */
  ensure(appId: string): Promise<number | null>;
  restart(appId: string): Promise<number | null>;
  stop(appId: string): Promise<void>;
  stopAll(): Promise<void>;
  state(appId: string): BackendState;
  port(appId: string): number | null;
}

/** Skärmbilder av appar i en beständig, osynlig Chrome (playwright-core, channel 'chrome'). */
export interface Shots {
  /** PNG av appens sida i fönstrets storlek, deviceScaleFactor 1. face = sidans id (standard: den som vetter framåt). */
  screenshot(appId: string, face?: string): Promise<{ png: Buffer; w: number; h: number; face: string }>;
  close(): Promise<void>;
}

/** Claude-sessioner, en per app. Den enda modulen som anropar registry.setStatus. */
export interface Sessions {
  /** HUD öppnad: förvärm eller återuppta så att första svaret går fort. */
  open(appId: string): void;
  /** HUD stängd: processen får stängas efter idleCloseMs. */
  close(appId: string): void;
  send(appId: string, text: string, via: 'text' | 'voice'): void;
  stop(appId: string): Promise<void>;
  answer(appId: string, askId: string, decision: 'allow' | 'allow-always' | 'deny' | 'answered', answers?: Record<string, string>, secret?: string): void;
  /** Sparad chatthistorik (utan 'delta'), äldst först. */
  history(appId: string, limit?: number): ChatEvent[];
  /** Efter ett lyckat ångra: sänder och sparar note "Ångrade senaste ändringen." och lägger en rad i nästa <workbench>-block. */
  noteUndo(appId: string): void;
  /** Efter ett lyckat gör om: note "Gjorde om ändringen." och raden i nästa block räknas netto (§8.4). */
  noteRedo(appId: string): void;
  /** Om appen just nu har en pågående tur eller obesvarad fråga. */
  busy(appId: string): boolean;
  /** Avsluta sessionen helt (appen tas bort). */
  forget(appId: string): Promise<void>;
  closeAll(): Promise<void>;
  /** En not från en annan modul (en backend som getts upp, §9): sänds och sparas, utom medan en tur pågår. */
  note(appId: string, text: string): void;
  /** Vid avslut (§7): ingen ny tur startar; meddelanden som kommer under tiden körs inte och får en not. */
  drain(): void;
}

/* ---------------------------- fabriker ---------------------------- */
// Implementeras i respektive fil. Signaturerna är frusna.
//
// server/config.ts              export function loadConfig(env?: NodeJS.ProcessEnv): Config
//                               export const childEnv: ChildEnv
// server/paths.ts               export function makePaths(config: Config): Paths
// server/live/hub.ts            export function createHub(): Hub & { attach(ws: import('ws').WebSocket, onMessage: (msg: unknown) => void): void }
// server/store/scene.ts         export function createSceneStore(paths: Paths): SceneStore
// server/store/registry.ts      export function createRegistry(deps: { paths: Paths; scene: SceneStore; hub: Hub; git: AppGit }): AppRegistry
// server/store/logs.ts          export function createAppLogs(paths: Paths): AppLogs
// server/live/git.ts            export function createAppGit(paths: Paths): AppGit
// server/live/watcher.ts        export function watchApps(deps: { paths: Paths; registry: AppRegistry; sessions: Pick<Sessions, 'busy'> }): () => void
// server/backends/supervisor.ts export function createBackends(deps: { config: Config; paths: Paths; registry: AppRegistry; logs: AppLogs }): Backends
// server/backends/proxy.ts      export function proxyHttp(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, port: number): void
//                               export function proxyUpgrade(req: import('node:http').IncomingMessage, socket: import('node:stream').Duplex, head: Buffer, port: number): void
// server/claude/shots.ts        export function createShots(deps: { config: Config; registry: AppRegistry; scene: SceneStore; logs: AppLogs }): Shots
// server/claude/sessions.ts     export function createSessions(deps: {
//                                 config: Config; paths: Paths; registry: AppRegistry; scene: SceneStore; hub: Hub;
//                                 backends: Backends; logs: AppLogs; shots: Shots; git: AppGit }): Sessions
// server/stt.ts                 export async function transcribe(config: Config, audio: Buffer, mime: string, hints: string[]): Promise<SttResponse>
// server/http/*                 vakten, routning, statiska filer, REST, /__wb/*, /ws — ägs av server-http
