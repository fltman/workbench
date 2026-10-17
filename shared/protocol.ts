// shared/protocol.ts — delade typer mellan server, skal (web/) och app-bryggan (sdk/wb.js).
// FRUSET GRÄNSSNITT. Ändra CONTRACT.md först, sedan den här filen, sedan alla användare.
// Ren data: inga DOM-referenser, så att samma scen kan renderas av en framtida Linux-kompositor.

export const PROTOCOL_VERSION = 1;

/* ------------------------------------------------------------------ */
/* Scenen (data/workbench.json)                                        */
/* ------------------------------------------------------------------ */

/** Världspunkten mitt i vyn, och zoom. zoom 1 = en CSS-px i en app (skala 1) är en CSS-px på skärmen. */
export interface Camera {
  cx: number;
  cy: number;
  zoom: number;
}

export interface WindowState {
  id: string;     // fönstrets id, "w-" + appens id
  appId: string;  // appens id (= subdomän)
  x: number;      // världskoordinat för övre vänstra hörnet (y växer nedåt, som i DOM)
  y: number;
  w: number;      // appens layoutstorlek i CSS-px, HELTAL (det appen ser som innerWidth/innerHeight)
  h: number;      // HELTAL
  scale: number;  // förstoring av innehållet; fönstrets storlek i världen = w*scale × h*scale
  face: number;   // index i appens faces som vetter mot betraktaren (0 för platta appar)
  z: number;      // stapelordning, högre ligger överst
  minimized?: number; // finns bara medan fönstret är minimerat: när (ms sedan 1970); raden i hörnet sorteras efter det
}

export interface Scene {
  version: 1;
  camera: Camera;
  windows: WindowState[];
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/* ------------------------------------------------------------------ */
/* Appar                                                               */
/* ------------------------------------------------------------------ */

/** En sida av en app. En app med flera sidor är en kropp (kort med baksida, prisma, kub). */
export interface FaceDef {
  id: string;     // [a-z0-9-]{1,32}
  page: string;   // relativ sökväg i appmappen, t.ex. "settings.html"
  label?: string; // kort namn på användarens språk
}

/** Webbläsarbehörigheter en app kan be om. Skalet ger dem först när användaren sagt ja i HUD:en. */
export type AppPermission = 'microphone' | 'camera' | 'clipboard-read' | 'geolocation';

/** apps/<id>/app.json — skrivs av Claude. Servern normaliserar och fyller i standardvärden. */
export interface AppManifest {
  name?: string;
  faces?: FaceDef[];                // standard: [{ id: 'main', page: 'index.html' }]
  backend?: { entry: string };      // t.ex. { entry: 'server.mjs' }
  permissions?: AppPermission[];
  opens?: OpenKind[];               // vad appen kan öppna från fältet (§10.9); okända tas bort
}

/** Vad en app kan öppna från fältet (§10.9): adresser, datum eller fri text. */
export type OpenKind = 'url' | 'date' | 'text';
export const OPEN_KINDS: readonly OpenKind[] = ['url', 'date', 'text'];
/** Det fältet lämnar till en app (wb.onOpen): en http(s)-adress, ett datum ÅÅÅÅ-MM-DD eller en text (högst 2000 tecken). */
export type OpenItem = { kind: 'url'; url: string } | { kind: 'date'; date: string } | { kind: 'text'; text: string };
/** POST /api/route: öppna i en app, eller föreslå att bygga en ny (namn och beskrivning på svenska). */
export type RouteResponse = { action: 'open'; appId: string; item: OpenItem } | { action: 'build'; name: string; prompt: string };

export const DEFAULT_FACES: FaceDef[] = [{ id: 'main', page: 'index.html' }];

/** idle: inget pågår · building: Claude arbetar · waiting: Claude väntar på ett svar · error: senaste turen gick fel */
export type AppStatus = 'idle' | 'building' | 'waiting' | 'error';

/** none: appen har ingen backend · stopped · starting · running · crashed */
export type BackendState = 'none' | 'stopped' | 'starting' | 'running' | 'crashed';

export interface AppInfo {
  id: string;
  name: string;                  // manifest.name ?? ''
  faces: FaceDef[];              // normaliserade, minst en
  permissions: AppPermission[];  // normaliserade (okända tas bort)
  built: boolean;                // första sidans fil finns
  status: AppStatus;             // sätts bara av Claude-sessionerna
  backend: BackendState;
  rev: number;                   // ändras när skalet ska ladda om appen (tur klar, ångra, reload_app, manuell ändring)
  opens?: OpenKind[];            // normaliserade; saknas när appen inte öppnar något från fältet (§10.9)
  trouble?: string;              // första raden av ett fel efter turen (§7.2), högst 120 tecken; saknas annars
}

/** Giltigt app-id: används som subdomän. */
export const APP_ID_RE = /^[a-z][a-z0-9]{2,30}$/;

/* ------------------------------------------------------------------ */
/* Chatten i HUD:en                                                    */
/* ------------------------------------------------------------------ */

export interface AskQuestion {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

export type Ask =
  | { kind: 'permission'; tool: string; title: string; detail: string; canRemember: boolean; defaultNo: boolean }
  | { kind: 'question'; questions: AskQuestion[] }
  | { kind: 'secret'; key: string; label: string }; // lösenordsfält; svaret lagras bara i apps/<id>/data/secrets.json

export type AskDecision = 'allow' | 'allow-always' | 'deny' | 'answered' | 'timeout' | 'cancelled';

/**
 * Normaliserade händelser från en apps Claude-session.
 * Sparas (utom 'delta') i data/apps/<id>/chat.jsonl och spelas upp när HUD:en öppnas igen.
 * Alla strängar är otillförlitliga och visas ALDRIG som HTML.
 */
export type ChatEvent =
  | { k: 'user'; id: string; text: string; via: 'text' | 'voice'; at: number }
  | { k: 'delta'; text: string }                                         // levande text, sparas inte
  | { k: 'text'; id: string; text: string; at: number }                  // färdigt textblock från Claude
  | { k: 'tool'; id: string; name: string; label: string; at: number }   // label på svenska, t.ex. "Skriver index.html"
  | { k: 'tool-done'; id: string; ok: boolean }
  | { k: 'ask'; id: string; ask: Ask; at: number }
  | { k: 'ask-done'; id: string; decision: AskDecision }
  | { k: 'turn'; phase: 'start' | 'end'; ok?: boolean; interrupted?: boolean; error?: string; at: number }
  | { k: 'note'; id: string; text: string; at: number; dropped?: string }; // t.ex. "Ångrade senaste ändringen."; dropped = id för användarens meddelande som aldrig kördes (dämpas i HUD:en)

/* ------------------------------------------------------------------ */
/* WebSocket mellan skal och server: ws://localhost:<port>/ws           */
/* ------------------------------------------------------------------ */

export type ClientMsg =
  | { t: 'hello'; v: number }
  | { t: 'scene.window'; win: WindowState }
  | { t: 'scene.camera'; camera: Camera }
  | { t: 'chat.open'; appId: string }   // HUD öppnad: förvärm eller återuppta sessionen
  | { t: 'chat.close'; appId: string }  // HUD stängd: sessionen får gå i vila
  | { t: 'chat.send'; appId: string; text: string; via: 'text' | 'voice' }
  | { t: 'chat.stop'; appId: string }   // avbryt pågående tur
  | {
      t: 'chat.answer';
      appId: string;
      askId: string;
      decision: 'allow' | 'allow-always' | 'deny' | 'answered';
      answers?: Record<string, string>; // question: fråga -> valt alternativ (flera val kommaseparerade)
      secret?: string;                  // secret: värdet; loggas, sparas och sänds aldrig vidare
    };

export type ServerMsg =
  | { t: 'snapshot'; scene: Scene; apps: AppInfo[] }
  | { t: 'app'; app: AppInfo }                 // ny eller ändrad
  | { t: 'app.removed'; appId: string }
  | { t: 'scene.window'; win: WindowState }    // nytt eller ändrat (andra flikar, servern)
  | { t: 'scene.windowRemoved'; id: string }
  | { t: 'chat'; appId: string; ev: ChatEvent }
  | { t: 'limits'; fiveHour: number; sevenDay: number } // när användningen passerar 0,8
  | { t: 'error'; message: string };

/* ------------------------------------------------------------------ */
/* REST på skalets origin                                              */
/* ------------------------------------------------------------------ */

// GET    /api/snapshot             -> { scene, apps }
// POST   /api/apps                 CreateAppRequest -> CreateAppResponse  (sänder också 'app' och 'scene.window')
// DELETE /api/apps/:id             -> { ok: true }        (flyttas till data/trash/)
// POST   /api/apps/:id/undo        -> { ok: boolean, canRedo: boolean }  (409 medan Claude arbetar; ok:false om inget att ångra)
// POST   /api/apps/:id/redo        -> { ok: true, canRedo: boolean }     (409 medan Claude arbetar eller om inget att göra om)
// GET    /api/apps/:id/chat        -> ChatHistoryResponse
// GET    /api/apps/:id/logs?n=     -> text/plain, appens senaste loggrader (n 1–2000, standard 400)
// POST   /api/stt                  ljud i kroppen (audio/webm, audio/mp4) -> SttResponse

/** Det ritade fönstret: x, y i världskoordinater, w, h = appens layoutstorlek i hela CSS-px, scale = förstoring. */
export interface CreateAppRequest {
  x: number;
  y: number;
  w: number; // heltal 240–2400
  h: number; // heltal 160–1600
  scale: number; // 0,05–20
}

export interface CreateAppResponse {
  app: AppInfo;
  win: WindowState;
}

export interface ChatHistoryResponse {
  events: ChatEvent[];
}

export interface SttResponse {
  text: string;
  provider: 'whisper' | 'openai';
}

/* ------------------------------------------------------------------ */
/* App-bryggan: app-iframe <-> skal via postMessage                     */
/* ------------------------------------------------------------------ */

/** Från appen till skalet. Skalet identifierar avsändaren via event.source + exakt origin, aldrig via innehållet. */
export type BridgeFromApp =
  | { wb: 1; type: 'hello'; face: string; w: number; h: number }
  | {
      wb: 1;
      type: 'wheel';
      action: 'zoom' | 'pan' | 'alt';  // zoom = ctrl+wheel (nyp), pan = ⌘+wheel eller wheel som appen inte kan scrolla, alt = ⌥+wheel
      dx: number;
      dy: number;
      mode: number;      // WheelEvent.deltaMode
      x: number;         // punkt i appens CSS-px (fraktionell om känd)
      y: number;
      momentum: boolean; // WheelEvent.momentum (Chrome 151+), annars false
      alt: boolean;      // ⌥ nedtryckt (⌥+nyp = skala bara det här fönstret)
      smart: boolean;    // tvåfingers dubbeltryck: ctrl && dx = dy = 0 && wheelDeltaY = 0
    }
  | { wb: 1; type: 'key'; code: 'KeyK' | 'Digit0' | 'ArrowLeft' | 'ArrowRight' | 'Escape'; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean }
  | { wb: 1; type: 'focus' }
  | { wb: 1; type: 'face'; show: string } // appen ber skalet vrida fram sidan med detta id
  | { wb: 1; type: 'badge'; text: string | null }; // appens märke bredvid pricken (§10.5), högst 3 kodpunkter; null tar bort det

/** Från skalet till appen. */
export type BridgeToApp =
  | { wb: 1; type: 'face'; current: string } // vilken sida som vetter framåt (svar på hello och vid varje ändring)
  | { wb: 1; type: 'open'; item: OpenItem }; // något från fältet att öppna (§10.9), bara om appen anger slaget i opens
