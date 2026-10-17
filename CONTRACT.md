# CONTRACT.md — Workbench

**Detta dokument är bibeln.** Alla moduler byggs mot gränssnitten här, i `shared/protocol.ts`, `server/types.ts` och `web/src/types.ts`. Ändra aldrig ett fruset gränssnitt utan att uppdatera det här dokumentet först.

## Innehåll

- [1. Idé](#1-idé)
- [2. Principer (icke förhandlingsbara)](#2-principer-icke-förhandlingsbara)
- [3. Portar, processer, kataloger](#3-portar-processer-kataloger)
- [4. Säkerhet](#4-säkerhet)
  - [4.1 Vakten (server/http/guard.ts)](#41-vakten-serverhttpguardts)
  - [4.2 Svarshuvuden](#42-svarshuvuden)
  - [4.3 Vite (dev)](#43-vite-dev)
  - [4.4 Iframes](#44-iframes)
  - [4.5 Sandlådor (`Config.sandbox`)](#45-sandlådor-configsandbox)
  - [4.6 Processer och miljö](#46-processer-och-miljö)
- [5. Scenen](#5-scenen)
- [6. Appens anatomi](#6-appens-anatomi)
- [7. Servern](#7-servern)
  - [7.1 Skalets origin](#71-skalets-origin)
  - [7.2 Appernas origins](#72-appernas-origins)
  - [7.3 Bevakaren (server/live/watcher.ts)](#73-bevakaren-serverlivewatcherts)
  - [7.4 Flöden som spänner över moduler (ägs av server-http)](#74-flöden-som-spänner-över-moduler-ägs-av-server-http)
- [8. Claude-bryggan (server/claude)](#8-claude-bryggan-serverclaude)
  - [8.1 Livscykel](#81-livscykel)
  - [8.2 Options (uppmätta, alla obligatoriska)](#82-options-uppmätta-alla-obligatoriska)
  - [8.3 Händelser till HUD:en](#83-händelser-till-huden)
  - [8.4 `<workbench>`-blocket](#84-workbench-blocket)
  - [8.5 Tillstånd och frågor (`server/claude/policy.ts` + `canUseTool`)](#85-tillstånd-och-frågor-serverclaudepolicyts--canusetool)
  - [8.6 När en tur är klar](#86-när-en-tur-är-klar)
  - [8.7 De sex MCP-verktygen (`tools.ts`, bundna till sessionens app, alla i `allowedTools`)](#87-de-sex-mcp-verktygen-toolsts-bundna-till-sessionens-app-alla-i-allowedtools)
  - [8.8 Skärmbilder (`shots.ts`)](#88-skärmbilder-shotsts)
  - [8.9 Låtsas-Claude (`WORKBENCH_FAKE_CLAUDE=1`)](#89-låtsas-claude-workbench_fake_claude1)
  - [8.10 Omstart mitt i en tur](#810-omstart-mitt-i-en-tur)
  - [8.11 Reglerna till Claude (`server/claude/app-rules.md`)](#811-reglerna-till-claude-serverclaudeapp-rulesmd)
  - [8.13 Fältet (`server/claude/route.ts`)](#813-fältet-serverclauderoutets)
  - [8.12 Förslag (`server/claude/ideas.ts`)](#812-förslag-serverclaudeideasts)
- [9. App-backends (server/backends)](#9-app-backends-serverbackends)
- [10. Skalet (web/)](#10-skalet-web)
  - [10.1 Lager (index.html, nerifrån och upp)](#101-lager-indexhtml-nerifrån-och-upp)
  - [10.2 Kamera](#102-kamera)
  - [10.3 Input, tangenter och gestkarta](#103-input-tangenter-och-gestkarta)
  - [10.4 Rita en ny app](#104-rita-en-ny-app)
  - [10.5 Fönster och prismor](#105-fönster-och-prismor)
  - [10.6 Visa allt och vilse-skydd](#106-visa-allt-och-vilse-skydd)
  - [10.7 Minimera (`web/src/world/shelf.ts`)](#107-minimera-websrcworldshelfts)
  - [10.8 Sidan Förslag (`web/src/world/ideas.ts`)](#108-sidan-förslag-websrcworldideasts)
  - [10.9 Fältet (`web/src/hud/field.ts`, `shared/open.ts`)](#109-fältet-websrchudfieldts-sharedopents)
- [11. Appbryggan (sdk/wb.js ↔ web/src/bridge.ts)](#11-appbryggan-sdkwbjs--websrcbridgets)
- [12. Röst](#12-röst)
- [13. HUD:arna (web/src/hud)](#13-hudarna-websrchud)
- [14. Utseende](#14-utseende)
- [15. Tester](#15-tester)
- [16. Ägarskap och byggvågor](#16-ägarskap-och-byggvågor)

## 1. Idé

En helt tom grå yta i webbläsaren. Man drar på trackpaden och ritar en fyrkant. Ur fyrkanten glider en blå HUD med text- och röstchatt, och chatten körs av Claude Code i bakgrunden. "Jag vill ha en mejlklient" ger en mejlapp i fyrkanten, med frontend och vid behov backend.

Varje app har en liten blå pulserande prick som tar fram HUD:en igen, så att just den appen kan byggas om. Allt är vektorer och kan zoomas och skalas fritt. En app kan också ha flera sidor, som ett kort med baksida eller en kub. Webbprototypen ska senare kunna bli en fönsterhanterare för Linux.

Projektet ägs av Anders Bjarby, och där dokumentet citerar Anders är citatet ett krav. Besluten bygger på mätningar, och siffrorna står vid besluten. En granskning av kontraktet gav 45 fynd, och alla är inarbetade.

## 2. Principer (icke förhandlingsbara)

1. **Skärpa först.** Appar är levande DOM i iframes under en 2D-kamera (`translate + scale`). En app i vila står aldrig under en 3D- eller perspektivtransform; prismor plattas till när de snäppt fast. Ingen CSS3DRenderer, ingen `will-change` i vila.
2. **Varje app är sin egen webbplats.** `http://<id>.localhost:<port>` ger egen origin, egen process och egen lagring. Skalet ritar all fönsterkrom (prick, grepp, sidprickar) utanför iframen, så kromen fungerar även när en app hänger.
3. **Claude och apparna är inlåsta.** App-sessioner läser aldrig användarens personliga Claude-konfiguration, minne, skills, MCP-servrar eller CLAUDE.md-filer. Claudes Bash och app-backends körs i macOS-sandlåda (§4.5). Hemligheter (`OPENAI_API_KEY` m.fl.) når aldrig en barnprocess.
4. **Varaktigt och ångringsbart.** Varje app är en mapp med eget git (extern git-katalog) och en egen Claude-session. En commit per tur gör ångra till en återställning.
5. **Minimalt UI.** Varje element ska bära information som inte syns någon annanstans. Inga förklarande etiketter, platshållartexter, statuspiller eller emojis. Detaljer på begäran.
6. **Svenska med å, ä, ö** i allt användaren ser. Språk lagas aldrig med regexp.
7. **Scenen är data.** Scenen är JSON utan DOM-referenser och appbryggan ett litet meddelandeprotokoll, så att en framtida Wayland-kompositor kan ta över renderingen.
8. **Ingen sträng från Claude, en app eller servern blir HTML.** Den sätts med `textContent` eller byggda noder.

## 3. Portar, processer, kataloger

- En Node-process (Node ≥ 25, TypeScript körs direkt): `node server/main.ts`.
  - Lyssnar på port **8220** på **både 127.0.0.1 och ::1** (två `http.Server` med samma hanterare för `request` och `upgrade`), aldrig på nätverket.
  - `npm run dev` startar om vid ändringar i `server/` och `shared/`.
- I dev kör Vite som middleware i samma process. HMR-websocketen ligger på egen port **8229** och är bunden till 127.0.0.1.
- App-backends får portar från **18300** och uppåt, bundna till 127.0.0.1.
- Ingen kod hårdkodar 8220 eller 8229. Skalet använder `location.port`, och servern läser `Config`.
- Miljövariabler (se `Config` i `server/types.ts`):

  | Variabel | Standard |
  |---|---|
  | `WORKBENCH_PORT` | 8220 |
  | `WORKBENCH_HMR_PORT` | 8229 |
  | `WORKBENCH_HOME` | repo-roten |
  | `WORKBENCH_MODEL` | `claude-opus-5-5` |
  | `WORKBENCH_EFFORT` | `high` |
  | `WORKBENCH_FAKE_CLAUDE` | `0` |
  | `WORKBENCH_FAKE_SPEED` | `1` |
  | `WORKBENCH_SANDBOX` | `1` |
  | `WORKBENCH_STT` | `auto` |
  | `WHISPER_URL` | `http://127.0.0.1:54205` |
  | `OPENAI_API_KEY` | – |
  | `WORKBENCH_IDLE_MS` | 600000 |
  | `WORKBENCH_BACKEND_IDLE_MS` | 600000, 0 = aldrig, högst 2147483647 (läses i `main.ts`, inte i `Config`; §9) |

```
workbench/
  CONTRACT.md  CLAUDE.md  README.md  package.json  tsconfig.json  vite.config.ts
  shared/protocol.ts           delade typer (FRUSET)
  server/
    types.ts                   servergränssnitt (FRUSET)
    main.ts config.ts paths.ts stt.ts shutdown.ts
    http/                      vakten, routning, statiska filer, REST, /__wb/*, /ws
    live/hub.ts git.ts watcher.ts
    store/scene.ts registry.ts logs.ts
    claude/sessions.ts prompt.ts labels.ts tools.ts shots.ts fake.ts policy.ts app-rules.md
    backends/supervisor.ts proxy.ts guard.mjs sandbox.ts
  sdk/wb.js                    appbryggan, injiceras först i varje app-sida
  web/                         skalet (Vite-rot)
    index.html
    src/main.ts store.ts bus.ts escape.ts types.ts bridge.ts
    src/world/                 kamera, input, bryggans grind, WebGL, fönster, prismor, ritande, krom
    src/hud/                   HUD, röst
    src/styles/tokens.css base.css
  tests/unit/  tests/e2e/
  apps/<id>/                   appens filer (Claudes arbetskatalog; ignoreras av workbenchens repo)
  apps/package.json            gränsen för Nodes paketuppslag, skapas av supervisorn (§9)
  data/                        workbench.json, apps/<id>/…, trash/ (ignoreras)
  vault/                       Obsidian-valv (ignoreras, följer aldrig med till ett publikt repo)
```

`data/apps/<id>/` ägs av workbenchen, och Claude når den inte:

- `session.json` – `{ sessionId }`
- `chat.jsonl` – chatthändelser utan delta, en per rad
- `logs.txt` – konsol, backend och workbench, roteras vid 1 MB (en äldre fil, `logs.txt.1`, sparas). `logs.tail` läser ur en ring i minnet med de senaste 2000 posterna, och första gången en app nämns i en ny process läses ringen in ur `logs.txt.1` och `logs.txt`, så att `get_app_logs` och Visa loggen (§13) ser det som hände före en omstart. Förut var ringen tom efter varje omstart, och Visa loggen gav en tom flik fast filen hade raderna (QA 17 oktober).
- `git/` – appens git-katalog

## 4. Säkerhet

### 4.1 Vakten (server/http/guard.ts)

En enda funktion körs **först** för varje `request` och `upgrade` på båda servrarna. Den körs före Vite, REST, `/ws`, `/__wb/*` och proxyn.

- **Host:**

  | Host | Hantering |
  |---|---|
  | `localhost:<port>` | skalet |
  | `<id>.localhost:<port>` (id matchar `APP_ID_RE`, och appen finns) | appen |
  | `127.0.0.1:<port>`, `[::1]:<port>` | GET/HEAD får 308 till `http://localhost:<port>` + sökväg; annat får 421 |
  | allt annat | 421 (skydd mot DNS-rebinding) |
- **Skalet:**
  - Finns `Origin` och den inte är `http://localhost:<port>` blir svaret 403.
  - Finns `Sec-Fetch-Site` och den varken är `same-origin` eller `none` blir svaret 403. Undantag: `Sec-Fetch-Mode: navigate` med `Sec-Fetch-Dest: document`.
  - Metoder utom GET/HEAD, och `/ws`-uppgraderingen, kräver `Origin: http://localhost:<port>`.
- **App:**
  - Finns `Origin` och den inte är appens egen blir svaret 403.
  - Finns `Sec-Fetch-Site` och den inte är `same-origin` eller `none` blir svaret 403. Undantag: navigeringar (`Sec-Fetch-Mode: navigate`) till dokument, och till iframe utom för `/api`, `/api/*` och `/__wb/*`. En annan webbplats kan alltså aldrig rama in en backends routes eller `/__wb/*`. Dokumentnavigeringar (till exempel OAuth-återanrop) går igenom som förut.
  - Förfrågningar med huvudet `Service-Worker: script` får 403. Service workers kan aldrig registreras och överleva ett ångra.
- Vakten är enhetstestad med en planterad läcka, alltså en förfrågan som **ska** fällas.

### 4.2 Svarshuvuden

- **Skalet:**
  - `Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws://localhost:<port> ws://127.0.0.1:<hmrPort> ws://localhost:<hmrPort>; frame-src http://*.localhost:<port>; img-src 'self' data: blob:; media-src 'self' blob:; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`. `worker-src` finns för Vites klient, som efter en omstart pingar servern från en SharedWorker med `blob:`-adress. I produktion faller HMR-delarna och `worker-src` bort.
  - `X-Frame-Options: DENY`
  - `Referrer-Policy: same-origin`
- **App-HTML:**
  - `Content-Security-Policy: frame-ancestors http://localhost:<port>`
  - `Referrer-Policy: same-origin`

### 4.3 Vite (dev)

```ts
createServer({
  configFile: <root>/vite.config.ts,
  root: <root>/web,
  appType: 'spa',
  cacheDir: <root>/node_modules/.vite-<port>,
  optimizeDeps: { include: ['three'] },
  server: {
    middlewareMode: true,
    ws: { port: hmrPort, host: '127.0.0.1' },
    cors: false,
    fs: { strict: true, allow: [<root>/web, <root>/shared, <root>/node_modules] },
  },
})
```

Varje instans har en egen förbundlingscache. Vites configHash innehåller root och läge, så instanser som delade `node_modules/.vite` kunde förbundla om varandras cache och ladda om varandras skal. three.js förbundlas direkt vid start, inte vid första sidan.

`apps/`, `data/` och `vault/` får aldrig kunna serveras, inte ens till skalets egen origin. Det är enhetstestat: `/@fs/<home>/data/workbench.json` ska ge 403 eller 404.

### 4.4 Iframes

- `sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads"`. Utan top-navigation kan en app aldrig navigera bort skalet.
- `allow="fullscreen; clipboard-write"`, plus de behörigheter i `AppInfo.permissions` som användaren gett (`grantsFor(appId)` i `bus.ts`, §13). `allow-same-origin` gäller appens **egen** origin, som skiljer sig från skalets.
- **Skärpan går före.** En domare mätte i riktig Chrome 155 att srcdoc-iframes med `sandbox="allow-scripts"` förblev suddiga efter utzoomning, medan samma iframe utan attributet var skarp. Världsbyggaren mätte därför skärpan med exakt våra attribut i riktig Chrome med fönster, vid zoom 0,5, 1 och 2, med det kalibrerade måttet (§15).
  - Uppmätt: med och utan attributet är apparna lika skarpa som en nativ referens. Domarens suddighet kom av testuppställningen: i headless Chrome med emulerad skalfaktor ritas en iframe i en annan process med DPR 1.
  - Beslut: `sandbox` behålls, och ingen `beforeunload`-varning behövs. Skärpan mot referensen var 1,00 vid alla tre zoomnivåerna, med och utan attributet, och en planterad `blur(0.6px)` gav 0,02–0,06.

### 4.5 Sandlådor (`Config.sandbox`)

- **Claudes Bash** körs genom SDK-optionen `sandbox` (§8.2). Bash godkänns automatiskt inne i sandlådan, och osandlådade kommandon är förbjudna.
- **App-backends** körs med `/usr/bin/sandbox-exec -f <genererad profil> node --import=<root>/server/backends/guard.mjs -- <entry>` (§9).
- Saknas `sandbox-exec`, eller är `WORKBENCH_SANDBOX=0`, körs allt osandlådat och en varning loggas med källan `workbench`. Då lägger §8.2 också till `Bash(npm install:*)`, `Bash(npm i:*)` och `Bash(npm ci:*)` i `allowedTools`. Allt annat i Bash frågar i HUD:en.
- **Kalibrerade flykttester** (§15) körs från en riktig `apps/<id>` under `$HOME`, inte under `/tmp`:
  - Med sandlådan påslagen ska det misslyckas att skriva `../x`, läsa `~/.ssh/known_hosts` och ansluta till `localhost:<port>`, och att skriva i Node-prefixet, `/opt/homebrew`, `/Users/Shared`, `/Library/Fonts`, `/Library/Caches`, `/cores` och `DARWIN_USER_CACHE_DIR` (de som testanvändaren själv kan skriva i) eller länka en fil där hårt in i data/, och att läsa en fil i `DARWIN_USER_CACHE_DIR` eller lista `DARWIN_USER_DIR`, medan `fork` med IPC fungerar.
  - Med sandlådan avstängd ska samma test larma (planterad läcka).

### 4.6 Processer och miljö

- **Alla barnprocesser** (Claude, backends, git, ffmpeg, Chrome) får miljön från `childEnv()` i `server/config.ts`. Det är en vitlista, aldrig `process.env`.
- **Alla processanrop** görs med `execFile` eller `spawn` och argv-listor, aldrig via ett skal. Användartext (commit-meddelanden) är alltid ett eget argv-element.
- **Id-kontroll:** `Paths` kastar för ogiltiga id. Varje REST-route svarar 404 om inte `registry.get(id)` finns.
- **Sökvägar:** avkoda URL-sökvägen en gång och avvisa `%00` och ogiltiga escape-sekvenser. Sedan:
  1. `real = await fs.promises.realpath(join(appRealDir, rel))`. Inte `realpathSync`, som behåller förfrågans skiftläge.
  2. 404 om `real` ligger utanför `appRealDir`.
  3. Nekade är (skiftlägesokänsligt, på `path.relative(appRealDir, real)`): segment som börjar med `.`, och första segmentet `data` eller `node_modules`.
  4. Filen öppnas med `O_NOFOLLOW`. En appfil med fler än en hård länk (`nlink > 1`) ger 404, eftersom realpath av en hård länk är länken själv.

  Samma kontroll gäller `faces[].page` och `backend.entry`, som inte heller får börja med `-`. Före varje skrivning i `data/` görs `lstat` på `apps/<id>/data`, och en symbolisk länk vägras.

## 5. Scenen

Typerna finns i `shared/protocol.ts`. `data/workbench.json` är en `Scene`.

- Servern äger filen och skriver atomiskt (tmp + rename), debouncat 200 ms.
- Skalet skickar `scene.window` (debouncat 120 ms per fönster) och `scene.camera` (debouncat 400 ms). Servern sparar och skickar `scene.window` vidare till **andra** flikar.
- Det som inte når servern (inget WebSocket, eller debouncen hann inte före en omladdning) väntar kvar i skalet. Vid nästa snapshot läggs väntande fönster vars app finns kvar, och kameran, över scenen innan den sänds vidare, och skickas sedan, men bara om snapshoten delar minst ett fönster-id med scenen de ändrades i. Fönster-id:n slumpas per app, så en server med ett annat hem delar inga, och då kastas allt som väntar, även kameran. Vid `pagehide` skickas allt som väntar direkt, och det som inte kom fram sparas i `sessionStorage` (`wb.pending`, med tid och scenens fönster-id:n) till första snapshoten efter omladdningen. En post som är äldre än 60 s kastas.
- Ett fönster per app i den här versionen.
  - Fönstrets id är `"w-" + appId`.
  - `w`, `h` är **heltal**: appens layoutstorlek i CSS-px. Skalet avrundar.
  - `scale` förstorar, och världsstorleken är `w*scale × h*scale`.
  - Servern avvisar icke-heltal och värden utanför 240–2400 × 160–1600 eller `scale` utanför 0,05–20 med `error`.
  - `minimized` (valfritt heltal, ms sedan 1970) finns bara medan fönstret är minimerat (§10.7), och raden i hörnet sorteras efter det. Ett fönster utan fältet står på sin plats. Servern avvisar allt annat än ett heltal som inte är negativt.

## 6. Appens anatomi

```
apps/<id>/
  .gitignore     /data/  node_modules/  .DS_Store   (data/ förankrad, så att t.ex. src/data/ versioneras)
  CLAUDE.md      Claudes anteckningar om appen (frö: "# <id>\n\nInga anteckningar ännu.\n")
  app.json       AppManifest (skrivs av Claude)
  index.html     första sidan (eller faces[0].page)
  …              fler sidor, css, js, svg
  server.mjs     valfri backend (manifest.backend.entry)
  package.json   backendens beroenden (Claude kör npm install själv i sandlådan)
  data/          appens beständiga data (DATA_DIR): store.json, secrets.json (0600), tmp/ (TMPDIR för backenden och Claude, 0700), …
```

- **Manifest:** `AppManifest` normaliseras av registret.
  - `faces` saknas eller är tom: `DEFAULT_FACES`.
  - Ogiltiga sidor (id inte `[a-z0-9-]{1,32}`, sökväg utanför mappen) tas bort.
  - Högst 6 sidor.
  - Okända `permissions` tas bort.
  - `opens` (§10.9): bara `url`, `date` och `text`, i den ordningen och utan dubbletter; saknas i `AppInfo` när inget gäller.
  - `built` = filen för `faces[0].page` finns.
- **App-id** genereras som `"a"` + 6 tecken `[a-z0-9]`, unikt. Id:t byts aldrig: det är appens origin och därmed dess lagring.
- **Git per app**, med extern git-katalog `data/apps/<id>/git` och arbetsträdet `apps/<id>`. Se `AppGit` i `server/types.ts` för flaggor och miljö.
  - Utöver de tre obligatoriska `-c`-flaggorna gäller:
    - `core.attributesFile=/dev/null`, `core.excludesFile=/dev/null`, `init.defaultBranch=main`, `gc.auto=0` och `maintenance.auto=false`
    - `init --template=` och `commit --no-verify`
    - `add -A -- . ':(exclude,glob,icase)[d]ata/**' ':(exclude,glob,icase)**/node_modules/**'`, så att `data/` aldrig versioneras även om Claude ändrar `.gitignore`

    Anrop för samma app körs i tur och ordning.
  - En kvarlämnad `index.lock` som är äldre än 10 s tas bort före nästa commit.
  - `init` gör första commit "Ny app" med `.gitignore` och `CLAUDE.md`.
  - Efter varje avslutad tur committas allt med första raden av turens första användarmeddelande som meddelande. Kontrolltecken tas bort, högst 72 tecken.
  - Ångra = `reset --hard HEAD~1` om det finns fler commits än den första.
  - **Gör om** (`refs/wb/redo` i appens git-katalog, utom räckhåll för Claude):
    - Ångra sparar först HEAD i `refs/wb/redo`, men bara när referensen saknas eller HEAD inte är dess förfader. Två ångra i rad behåller alltså den översta commiten.
    - Gör om = `reset --hard` till nästa commit på vägen dit, den sista i `rev-list --topo-order --ancestry-path HEAD..refs/wb/redo --`. När HEAD når referensen tas den bort.
    - `canRedo` = referensen finns och HEAD är en äkta förfader till den. En ny commit utanför vägen tar bort referensen, så gör om försvinner när historien går isär; en tur som inte committar något behåller den.
    - Ångra och gör om rör aldrig `data/`: `store.json` är appens data, inte kod, och behåller sin senaste form.
    - Revisioner till kommandon som också tar sökvägar följs av `--` (`rev-list --count HEAD --`, `reset --hard HEAD~1 --`). Utan det gjorde en fil som heter `HEAD` eller `HEAD~1` i appen anropet tvetydigt, och ångra misslyckades.
    - Ett kvarlämnat `refs/wb/redo.lock` eller `packed-refs.lock` som är äldre än 10 s tas bort som `index.lock`.
  - Claude får `GIT_CEILING_DIRECTORIES=<home>/apps`, så att dess egna git-anrop aldrig hittar workbenchens repo eller hemkatalogens.
- **Ta bort** flyttar alltid `apps/<id>` och `data/apps/<id>` till `data/trash/<id>-<ISO 8601 basic UTC, t.ex. 20261016T123456.789Z>/apps/<id>/…` och `…/data/apps/<id>/…`. Ordningen står i §7.4.
  - Ett id som finns i papperskorgen, eller som har en kvarlämnad `data/apps/<id>`, återanvänds aldrig, eftersom id:t är appens lagring.

## 7. Servern

Modulerna och deras fabriker står i `server/types.ts`. `server/main.ts` kopplar ihop dem i den här ordningen:

config → paths → hub → scene → git → registry → logs → backends → shots → sessions → watcher → http.

Vid start:

1. Läs scenen.
2. Registrera alla mappar under `apps/` som matchar `APP_ID_RE`.
3. Ta bort fönster vars app saknas. En appmapp utan fönster (till exempel om `workbench.json` försvunnit) får ett reservfönster på 640×480 till höger om de andra.
4. Alla appar får `status: 'idle'` och `rev = Date.now()`.
5. `createSessions` lagar `chat.jsonl` (§8.10).
6. Efter adressraden skriver servern en rad om `/usr/bin/sandbox-exec` saknas medan sandlådan är påslagen (§4.5), och en om `ffmpeg` inte finns i `PATH` när `WORKBENCH_STT` kan välja whisper (§12). Annars märks det först när en app startar en backend eller när någon talar.

Vid SIGINT/SIGTERM:

1. **Tömning** (`server/shutdown.ts`): pågår turer (`sessions.busy` för någon app) väntar servern först tills de är klara, högst 15 min, och fortsätter under tiden att servera HTTP, `/ws` och backends. En rad i konsolen säger hur många turer den väntar på och att en signal till stänger direkt. `sessions.drain()` ser till att ingen ny tur startar (§8.1). En andra signal hoppar över väntan. Med låtsas-Claude, eller när ingen tur pågår, stänger servern direkt. En omstart från `npm run dev` (`--watch` skickar SIGTERM och väntar, och skickar ingen ny signal vid fler ändringar under tiden) och `kill <pid>` är en signal. Ctrl+C i en terminal som kör via npm når servern två gånger (terminalen och npm), med `--watch` tre (uppmätt), och stänger därför direkt.
2. `sessions.closeAll()`, som först sänder turslutet för en tur som väntar på det i §8.6
3. `backends.stopAll()`
4. `shots.close()`
5. `scene.flush()` och `logs.flush()`
6. Avsluta. Tidsgränsen på 15 s för stegen 2–5 börjar först efter tömningen, och en signal under dem avslutar direkt.

### 7.1 Skalets origin

- `GET /` och skalets filer: Vite-middleware i dev (§4.3), annars `dist/` med SPA-fallback.
- `GET /api/snapshot` → `{ scene, apps }`.
- `POST /api/apps` → `registry.create` (validering enligt §5) → `{ app, win }`.
- `DELETE /api/apps/:id`, `POST /api/apps/:id/undo` och `POST /api/apps/:id/redo`: se §7.4.
- `POST /api/apps/:id/ideas` → `{ rev, items }`, förslag på förbättringar (§8.12). Bara POST, eftersom svaret kan kosta en fråga till Claude; en GET ger 405. En obyggd app ger 409, ett misslyckande 503 (utan detaljer).
- `GET /api/apps/:id/chat` → `{ events: sessions.history(id, 300) }`.
- `GET /api/apps/:id/logs?n=` → appens senaste loggrader (`logs.tail(id, n)`: konsolen, backenden och workbenchen, §3) som `text/plain; charset=utf-8` med `x-content-type-options: nosniff`, en rad per post. `n` är 400 utan giltigt värde och kläms till 1–2000. Utan rader blir svaret raden "Inga loggrader ännu." i stället för en tom sida. Bara GET och HEAD. Vakten (§4.1) gäller som för de andra routerna, så bara skalets egen origin läser loggen. HUD:ens **Visa loggen** öppnar den i en egen flik (§13).
- `POST /api/stt`:
  - Kropp högst 10 MB.
  - Bara mediatypen före `;` jämförs. `audio/webm` och `audio/mp4` godtas, annat får 415.
  - Svaret är `transcribe(config, audio, mime, appnamn)` (§12).
- `/ws`:
  - Efter `hello` skickar servern `snapshot`.
  - Klientmeddelanden valideras strikt: form, typer, appen finns, `askId` finns och är obesvarat. Ogiltiga ignoreras och `error` skickas.
  - HUD:arna per flik: `ws.ts` minns vilka appar varje websocket har skickat `chat.open` för, och en flik kan ha flera HUD:ar öppna. Vid `chat.close`, och när en websocket stängs (en flik som stängs med HUD:en öppen skickar aldrig `chat.close`), anropas `sessions.close(appId)` bara om ingen annan öppen websocket fortfarande har appens HUD öppen. Annars blev `hudOpen` kvar för alltid: processen stängdes aldrig och hoppades över när taket trimmades.

### 7.2 Appernas origins

| Sökväg | Svar |
|---|---|
| `GET /__wb/wb.js` | `sdk/wb.js` (`text/javascript; charset=utf-8`, `cache-control: no-store`) |
| `GET /__wb/app.json` | `{ id, name, faces }` (normaliserat), och appens `rev` i huvudet `x-wb-rev` (felsignalen nedan) |
| `POST /__wb/log` | JSON-array, högst 50 poster `{ level: 'error'\|'warn'\|'log', text: string }`, varje text högst 2000 tecken. Läggs i `logs` med källa `console`. Högst 100 poster/s per app; resten släpps. |
| `GET /__wb/store` | hela objektet |
| `GET /__wb/store/<key>` | värdet; saknas nyckeln 404, eller 204 utan kropp om förfrågan har huvudet `x-wb-optional: 1` (som `wb.js` alltid skickar) |
| `PUT /__wb/store/<key>` | JSON-kropp, högst 1 MB |
| `DELETE /__wb/store/<key>` | tar bort nyckeln |
| `/api/*` (även WebSocket) | proxas **oförändrat** till appens backend (§9) |
| allt annat | statiska filer från `apps/<id>/` |

- **Store:**
  - `<key>` matchar `[A-Za-z0-9._-]{1,100}` och är varken `.` eller `..`.
  - Lagras i `apps/<id>/data/store.json` (0600), skrivs atomiskt, högst 10 MB totalt (annars 413).
  - En trasig `store.json` ger 500 och skrivs aldrig över.
  - En saknad nyckel ger 404, eller 204 med `x-wb-optional: 1`. Chrome loggar 404 som "Failed to load resource" i appens konsol men inte 204. Filtret i `shots.ts` gäller fortfarande förfrågningar utan huvudet.
- **Logg:** `/__wb/log` begränsas med en tokenhink (100 poster/s per app, med marginal för buntning) och inte med ett fast fönster.
- **Felsignalen** (`AppInfo.trouble`; granskningen 17 oktober: ett fel efter turen hamnade i en ring som bara Claude läser): registret får appens loggrader med `registry.noteLog` och sätter `trouble` när en av dem är ett fel efter turen.
  - **Från sidorna:** varje godtagen post går till `registry.noteLog(id, 'console', rad, rev)`, där `rev` är huvudet `x-wb-rev`, appens `rev` som sidan fick från `/__wb/app.json` när den laddades (`wb.js` skickar det med varje bunt, även den sista när sidan stängs). En post räknas bara när raden börjar `error: Uncaught` (det `wb.js` skriver för `window.onerror` och avvisade löften) och `rev` är appens nuvarande. Utan versionen satte den gamla iframen, som står kvar tills den nya har laddats, och Claudes skärmbildssida, som kan stå öppen i 10 minuter, tillbaka felet som just rättats (granskningen av felsignalen: 3 av 3 turer och 4 av 4 handredigeringar). Ett vanligt `console.error` räknas inte, eftersom en pollande app som loggar ett fel per förfrågan annars skulle vara bärnstensfärgad för alltid.
  - **Från backenden** räknas bara en krasch (§9): supervisorn lämnar den sista stderr-raden som börjar med ett felnamn (`Error: …`, `TypeError [ERR_…]: …`, `[UnhandledPromiseRejection: …`) till `registry.noteLog(id, 'stderr', rad)` när backenden avslutats utan att supervisorn bett om det. Ett hanterat fel som loggas med `console.error(err)` ser likadant ut på stderr som kraschens rad och räknas inte, och inte heller Nodes varningar, vanlig text eller platsraderna före felnamnet.
  - Bara en byggd app med status `idle` räknas: under en tur, med status `error` och i en obyggd app händer inget. Första felets första rad (utan `error: `, kontroll- och formattecken bort som i märket, §11, högst 120 kodpunkter) blir `trouble` och sänds en gång. Registret sparar också högst 5 olika felrader (högst 300 kodpunkter) åt förslagen (`registry.troubles`, §8.12). `bumpRev` och turens slut (status från `building` eller `waiting` till `idle` eller `error`) tar bort båda, och inget av det sparas på disk.
- **Proxyn:** `await backends.ensure(id)`. Finns ingen backend blir svaret 503 `{ "error": "backend" }`.
- **Statiska filer** följer sökvägsreglerna i §4.6.
  - `/` ger första sidan.
  - `Content-Type` sätts efter filändelse, med `; charset=utf-8` för text, html, css, js och json. `cache-control: no-store` alltid.
  - **HTML** får `<script src="/__wb/wb.js"></script>` direkt efter `<head…>`. Saknas den hamnar skriptet efter `<html…>`. Saknas också den hamnar det efter `<!doctype …>` med inledande kommentarer och blanktecken. Annars först.
    - Skriptet injiceras **alltid** först, även om sidan själv har en tagg längre ner. `wb.js` är idempotent, och annars hinner appens egna lyssnare före bryggan.
    - Bara inledningen av dokumentet läses, så ett `<head>` i en skriptsträng längre ner fångar aldrig skriptet.
  - Okänd fil ger 404 med en tom sida.

### 7.3 Bevakaren (server/live/watcher.ts)

- `fs.watch(appDir, { recursive: true })` per app, debouncat 200 ms.
- Ignorerar `node_modules/`, `data/`, `.git/`, `.DS_Store` och tillfälliga filer från atomiska skrivningar (`*.tmp.<pid>.<hex>`).
- Ignorerar också (uppmätt):
  - händelser om appmappen själv
  - FSEvents-händelser från före bevakningens start (första sekunden; mtime och ctime äldre än starten)
  - ändringar som git gör under ångra och gör om (git.ts markerar arbetsträdet medan det körs och 500 ms efter)
- **Gör ingenting medan `sessions.busy(appId)`.** Det kontrolleras både när händelsen kommer och när debouncen löser ut. Vid manuella ändringar (användaren redigerar själv) anropas `registry.refresh` och sedan `registry.bumpRev`.
- Vilka appar som bevakas följer `registry.list()` och avläses varje sekund. En fil som skrivs för hand inom första sekunden efter att appen skapats kan missas, eftersom Claudes turer täcks av §8.6.

### 7.4 Flöden som spänner över moduler (ägs av server-http)

- **DELETE `/api/apps/:id`:**
  1. `await sessions.forget(id)`
  2. `await backends.stop(id)`
  3. `await registry.remove(id)`, som sänder `scene.windowRemoved` och sedan `app.removed`
  4. `logs.clear(id)`
  5. Svaret `{ ok: true }`
- **POST `/api/apps/:id/undo`:**
  - Svarar 409 om `sessions.busy(id)`.
  - Annars `ok = await git.undo(id)`. Om `ok`:
    1. `registry.refresh(id)`
    2. `backends.restart(id)`, som anropas villkorslöst: utan backend i manifestet stoppar den en kvarvarande process, sätter `none` och returnerar null
    3. `registry.bumpRev(id)`
    4. `sessions.noteUndo(id)`
  - Svaret `{ ok, canRedo }`, där `canRedo = await git.canRedo(id)`, även när `ok` är false (ett ångrat steg kan finnas kvar att göra om).
- **POST `/api/apps/:id/redo`:**
  - Svarar 409 om `sessions.busy(id)`, och 409 om `git.redo(id)` inte har något att göra om.
  - Annars samma steg som ångra (refresh, restart, bumpRev), med `sessions.noteRedo(id)` sist.
  - Svaret `{ ok: true, canRedo }`. `canRedo` är false när den senast ångrade commiten är tillbaka.

## 8. Claude-bryggan (server/claude)

### 8.1 Livscykel

En levande `query()` i strömmande läge (en `InputQueue` som prompt) per app.

- **`open(appId)`:**
  - Väntar först in en process för samma app som håller på att stängas. Det körs **aldrig** två processer på samma session.
  - Därefter `warm = await startup({ options })` och direkt `q = warm.query(inputQueue)`. Finns ett sparat `sessionId` sätts `resume`. `send` som kommer under tiden läggs i `inputQueue`.
  - Högst **4** levande processer. Den som varit stilla längst stängs först, men aldrig en med pågående tur eller obesvarad fråga, och i första hand en app utan öppen HUD. Taket prövas också när en kedja är klar (efter §8.6 steg 5). Processer bakom öppna HUD:ar stängs då först när ingen process längre arbetar, och då den som varit stilla längst först, eftersom fler HUD:ar än taket kan vara öppna samtidigt. Varningen "alla andra arbetar" loggas bara när ingen annan levande process är stilla.
- **`send`:** öppnar vid behov och lägger meddelandet (med `<workbench>`-blocket, §8.4) i kön.
  - Medan stegen i §8.6 körs hålls nya meddelanden i sessionen. De läggs i kön först efter steg 5.
  - Meddelanden under en pågående tur köas av Claude Code själv, utom efter ett stopp (se `stop`).
  - Väntar ett kort besvarar texten kortet i stället (§8.5 punkt 6).
- **`stop`:** `q.interrupt()`. Turen räknas som avbruten (§8.3). Stoppet gäller hela kedjan:
  - Köade meddelanden som processen inte läst tas ur kön.
  - En köad tur som ändå börjar avbryts direkt, vid `result` med `queued_turn_count > 0` och vid turens första aktivitet.
  - Meddelanden som hålls under §8.6 kastas.
  - För varje sådant meddelande skickas `note` "Stoppad – ”<text>” skickades inte" (nådde aldrig Claude) eller "Stoppad – ”<text>” avbröts" (låg i Claude Codes kö). Texten kortas till 60 tecken. Noten har `dropped` = id:t för meddelandets `user`-händelse, så att HUD:en dämpar raden (§13).
  - Meddelanden som skickas efter stoppet men innan den stoppade kedjan har slutat hålls som under §8.6 och blir en egen kedja när den har slutat. Ett nytt stopp under tiden kastar dem (`note` "Stoppad – ”<text>” skickades inte").
- **`drain`** (vid avslut, §7): ingen ny tur startar. En tur som pågår går klart, med det som redan köats i den, och ett kort i den kan fortfarande besvaras med text. Ett meddelande som skickas under tömningen sparas som `user` men körs inte: det får `note` "Servern startar om – ”<text>” skickades inte" med `dropped`, liksom meddelanden som hålls under §8.6. `open` startar ingen process.
- **`note(appId, text)`:** en not från en annan modul, i dag en backend som getts upp (§9). Den sänds och sparas som `note`, utom medan en tur pågår: då ser Claude kraschen i sina verktygssvar, och §8.6 startar om backenden när turen är klar. Under §8.6 väntar den till efter turslutet.
- **`close`:** när appens HUD stängts och ingen tur pågår stängs processen efter `idleCloseMs` (`inputQueue.end()`, sedan `q.close()` efter 5 s). HUD:en räknas per flik (§7.1): `sessions.close` anropas först när ingen öppen flik längre har appens HUD öppen.
- `sessionId` sparas i `data/apps/<id>/session.json` vid varje `system/init`.
- `forget(appId)` stänger processen, tar bort `session.json` och raderar appens Claude-transkript med SDK:ns `listSessions({ dir })` och `deleteSession`. De ligger annars kvar i användarens `~/.claude/projects/`. Därefter tas appens projektkatalog under `<CLAUDE_CONFIG_DIR eller ~/.claude>/projects/` bort med `rmdir`, aldrig rekursivt: ligger något kvar får den stå. Katalognamnet räknas ut som SDK:n gör (allt utom `[a-zA-Z0-9]` blir `-`), och namn över 200 tecken matchas på prefixet, eftersom CLI:t kan räkna svansen annorlunda.
- `forget(appId)` lämnar en gravsten: sessionen står kvar markerad som glömd, även för en app som aldrig öppnats, så att ett `chat.open`, `send`, `noteUndo` eller `note` som kommer mellan `forget` och `registry.remove` aldrig startar en ny process eller skriver något (id:n återanvänds aldrig, §6). Förut togs sessionen bort, och ett `chat.open` 13–36 ms in i en DELETE startade en process som levde tills taket trimmade den.
- Återupptagning sker alltid med appens egen mapp som `cwd`.
- MCP-servern `workbench` skapas på nytt för varje process; en instans kan bara ha en transport.

### 8.2 Options (uppmätta, alla obligatoriska)

```ts
{
  cwd: realpath(appDir),
  env: childEnv({
    CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_AGENT_SDK_CLIENT_APP: 'workbench/0.1',
    GIT_CEILING_DIRECTORIES: <home>/apps, npm_config_cache: <appDir>/node_modules/.cache/npm, npm_config_update_notifier: 'false',
    TMPDIR: <appDir>/data/tmp,
  }),                                  // vitlista: inga CLAUDE_CODE_*, ingen ANTHROPIC_API_KEY, ingen OPENAI_API_KEY
  settingSources: [],                  // ingen CLAUDE.md eller .claude/settings.json läses; appens CLAUDE.md skickas i <workbench>-blocket
  strictMcpConfig: true,
  settings: { crossSessionInbound: 'refuse', disableAllHooks: true,
    permissions: { deny: ['Read(/' + secrets + ')', 'Edit(/' + secrets + ')'] } },   // secrets = <appDir>/data/secrets.json; '//' först = absolut sökväg
  tools: ['Bash','Read','Write','Edit','Glob','Grep','WebFetch','WebSearch','AskUserQuestion','TodoWrite'],
  mcpServers: { workbench: createSdkMcpServer({ name: 'workbench', version: '0.1.0', tools, alwaysLoad: true }) },
  allowedTools: ['mcp__workbench__*', 'WebSearch'],
  sandbox: config.sandbox ? {
    enabled: true, failIfUnavailable: true, autoAllowBashIfSandboxed: true, allowUnsandboxedCommands: false,
    network: { allowedDomains: ['registry.npmjs.org', 'esm.sh', 'cdn.jsdelivr.net'] },
    filesystem: {
      allowWrite: [appDir], denyWrite: [appDir + '/.claude', secrets],
      denyRead: [os.homedir(), <WORKBENCH_HOME om den ligger utanför $HOME>, <realpath(os.tmpdir()) om appen inte ligger under den>, secrets],
      allowRead: [appDir, <Node-prefix om den ligger under $HOME>],
    },
    credentials: { files: [{ path: secrets, mode: 'deny' }] },
  } : undefined,
  systemPrompt: { type: 'preset', preset: 'claude_code', append: <server/claude/app-rules.md> },
  permissionMode: 'acceptEdits',       // alltid explicit: utelämnat kan bli 'auto'
  includePartialMessages: true,
  model: config.model,                 // 'claude-opus-5-5'
  effort: config.effort,               // 'high'
  canUseTool,                          // §8.5
  resume: sessionId,                   // om det finns
  stderr: (d) => <ringbuffert 40 rader, till logs vid fel>,
}
```

Byggaren verifierar mot en riktig app under `$HOME`, och justerar bara inom samma anda:

- att inloggningen via nyckelringen fungerar med vitlistemiljön
- att `npm install`, `node` och läsning i appen fungerar i sandlådan
- att flykttesterna i §4.5 fälls
- att `allowRead` inom `denyRead` beter sig som avsett

Självtest vid första start av en session, loggat:

- `getContextUsage({ detail: 'summary' })` ska ha tom `memoryFiles`.
- `mcpServerStatus()` ska bara innehålla `workbench`.
- `system/init.tools` ska innehålla de sex `mcp__workbench__`-verktygen.

Avvikelser loggas som varning med källa `workbench`.

Fel som användaren märker loggas som förut och blir dessutom en `note` i appens HUD (sparas i chat.jsonl), med vad som hände och vad det betyder:

- Commiten efter en tur misslyckas (§8.6): "Ändringen kunde inte sparas separat, så Ångra tar nu två ändringar på en gång." Nästa commit tar med båda turerna, och Ångra (`reset --hard HEAD~1`) tar dem tillsammans.
- Sessionen går inte att återuppta, och en ny startas (§8.1): "Claude kunde inte fortsätta det tidigare samtalet och börjar om utan minne av det."
- Självtestet hittar minnesfiler: "Claude läste in minnesfiler utanför appen: <sökvägar>. Det som står där kan hamna i appen." Andra MCP-servrar än `workbench` i `mcpServerStatus()`: "Claude fick tillgång till MCP-servrar utanför appen: <namn>. Det de når kan hamna i appen." Självtestet körs i varje ny process, men en not som redan står bland de 300 händelser som HUD:en läser in (§7.1) upprepas inte, inte heller efter en omstart.

Övriga avvikelser (en tidsgräns i självtestet, verktyg som saknas i `system/init`) är bara varningar.

**Hemligheterna** (`data/secrets.json`) stängs i tre lager: deny-reglerna i `settings.permissions` (de gäller även läsningar inne i `cwd`, där `canUseTool` aldrig tillfrågas), sandlådans `credentials.files`, `denyRead` och `denyWrite`, och policyn (§8.5). Uppmätt med riktiga Claude: Read av `data/secrets.json` nekas av deny-regeln, och `cat data/secrets.json` i Bash ger "Operation not permitted". `data/other.json` går att läsa på båda sätten i samma tur.

**TMPDIR:** Claude får appens egen `data/tmp` (sessionen skapar den när processen startar), och den delade TMPDIR:en är stängd för läsning. Claude Code sätter själv `TMPDIR=/tmp/claude-<uid>` för sandlådad Bash. Den katalogen delas mellan alla Claude Code-sessioner och kan inte stängas härifrån.

### 8.3 Händelser till HUD:en

`SDKMessage` normaliseras till `ChatEvent` och skickas som `{ t: 'chat', appId, ev }`. Alla utom `delta` läggs också i `chat.jsonl`.

| Händelse | ChatEvent och åtgärd |
|---|---|
| `send` tas emot | `user` |
| första meddelandet i en tur | `turn` start, och `setStatus('building')` |
| `stream_event` med `content_block_delta.text_delta` | `delta` |
| assistent-text-block i huvudtråden | `text` |
| `tool_use` i huvudtråden (`parent_tool_use_id` null), utom `TodoWrite` | `tool` med `label` från `labels.ts` |
| `tool_result` | `tool-done` (`ok = !is_error`) |
| fråga till användaren (§8.5, `request_secret`) | `ask` och `setStatus('waiting')`; vid svar `ask-done` och `setStatus('building')` |
| `result` | §8.6, som sänder `turn` slut efter steg 3, se nedan |

**Resultatet:**

- `interrupted` = `stop()` anropades under turen, eller `terminal_reason` är `aborted_streaming` eller `aborted_tools`.
- `ok` = `!is_error && !interrupted`.
- `error` (bara när `!interrupted && is_error`) = `subtype === 'success' ? result : errors.join('\n')`.
- Sedan §8.6, som sänder `turn` slut efter steg 3, men bara när `queued_turn_count === 0`. En kedja av köade turer blir **en** commit.
- **Det delvisa svaret:** slutar kedjan avbruten sänds texten som strömmat in (`delta`) sedan turens senaste `text` som en sista `text`, så att den står kvar i HUD:en och i chat.jsonl. Förut fanns `delta` bara i skalets minne, och efter Stopp stod användarens rad ensam.

**Kvotvarning:** läs `rate_limit_info.unifiedWindows?.five_hour?.utilization` och `…seven_day?.utilization`. Typen utökas lokalt, eftersom fälten saknas i `sdk.d.ts`. Som reserv används `utilization` när `rateLimitType` är `five_hour` eller `seven_day`. Senaste värdet per fönster sparas. När ett värde passerar 0,8 skickas `limits` med båda talen, en gång per passage. Enhetstestat med en inspelad händelse.

**Etiketter** (`labels.ts`, svenska, högst 60 tecken, sökvägar relativa appens mapp, enhetstestade):

| Verktyg | Etikett |
|---|---|
| Write | "Skriver index.html" |
| Edit | "Ändrar server.mjs" |
| Read | "Läser app.json" |
| Glob/Grep | "Letar i koden" |
| Bash `npm install|i|ci <paket>` | "Installerar imapflow, nodemailer" (utan paket: "Installerar beroenden") |
| Bash `node …` | "Kör node" |
| övrig Bash | "Kör <första ordet>" |
| WebSearch | "Söker: <fråga>" |
| WebFetch | "Läser <värdnamn>" |
| `screenshot_app` | "Tittar på appen" |
| `get_app_logs` | "Läser loggarna" |
| `reload_app` | "Startar om appen" |
| `call_backend` | "Testar /api/x" |
| `request_secret` | "Ber om <label>" |
| `try_app` | "Provar appen" |

### 8.4 `<workbench>`-blocket

Varje användarmeddelande till Claude får ett block först, på engelska. Till HUD:en och `chat.jsonl` går bara användarens egen text.

Språkraden står i varje block. Allt annat Claude läser är engelska (systemprompten, blocket och varje verktygssvar), och utan raden kom två av tre slutsvar på engelska i våg 3 fast användaren skrev på svenska. Den nämner noterna mellan verktygsanropen: när den sa "every message to the user" nådde två engelska noter HUD:en (granskningen 17 oktober, §8.11).

```
<workbench>
Window: 640×480 CSS px (scale 1). Front face: main (1 of 1).
Back end: none.            | Back end: running on port 18300 | Back end: crashed – see get_app_logs
Since your last turn: the user undid your last change; files are restored to the previous version.   (bara när det hänt)
Write every text block in Swedish, including notes between tool calls: the user reads them all in the HUD.
Your notes (CLAUDE.md):    (bara i första meddelandet i varje ny process; högst 8 kB)
<innehållet i apps/<id>/CLAUDE.md>
</workbench>
<användarens text>
```

Raden om ångra räknar netto sedan förra meddelandet, ångrade minus gjorda om (§7.4), och säger aldrig mer än som hänt: ett steg bakåt ger raden ovan, flera "the user undid your last N changes; files are restored to an earlier version", lika många gjorda om som ångrade "the user undid and then redid your changes; the files are as you left them", och fler gjorda om "the user redid a change that had been undone earlier; the files now include it again" (eller "N changes … them").

### 8.5 Tillstånd och frågor (`server/claude/policy.ts` + `canUseTool`)

1. **Policyn först** (enhetstestad).
   - Varje strängfält i `input` som är en absolut sökväg eller innehåller `..`, och dessutom `blockedPath`, löses mot realpath av närmaste befintliga förfader. Hamnar det utanför appens realpath nekas det.
   - Write, Edit och NotebookEdit under `.claude/` nekas.
   - Varje sökväg som löser till `data/secrets.json` (skiftlägesokänsligt) nekas, liksom Bash-kommandon som nämner `secrets.json`. Huvudspärren är deny-reglerna i §8.2, eftersom `canUseTool` aldrig tillfrågas om läsningar inne i `cwd`.
   - Utan sandlåda nekas Bash som innehåller `git`.
   - Nekandet går direkt med ett meddelande på engelska till Claude. Inget `ask` skickas.
2. **Bash i sandlådan** godkänns direkt, utan kort, när policyn släppt igenom den (Anders beslut 16 oktober 2026). Med `allowUnsandboxedCommands: false` körs varje Bash-kommando i sandlådan, men Claude Codes egna heuristiker frågar ändå ibland, till exempel "Contains brace with quote character (expansion obfuscation)" för JSON i en heredoc eller för `$VAR`. Det gav kortet "Köra ett kommando?" i 3 av 18 riktiga turer. Sandlådan är gränsen: bara appens mapp, och på nätet bara listan i §8.2. Utan sandlåda visas kortet som förut, och en ask-regel (`matchedAskRule`) följs alltid. Godkännandet vilar på två saker: `allowUnsandboxedCommands: false` (annars kommer `dangerouslyDisableSandbox` hit och skulle godkännas osandlådat; testerna låser värdet), och att ingen inställningsnivå sätter `sandbox.excludedCommands` (sådana kommandon körs utanför sandlådan men går ändå hit). Uppmätt i Claude Codes egen kod (våg 4): med dessa inställningar körs varje Bash-anrop som når `canUseTool` i sandlådan, även i bakgrunden, och en sandlåda som inte startar stoppar kommandot i stället för att köra det.
3. **`AskUserQuestion`** blir `ask { kind: 'question', questions }`. Svaret blir `{ behavior: 'allow', updatedInput: { questions, answers } }`.
4. **Allt annat** (WebFetch, SandboxNetworkAccess, Bash utan sandlåda och övrigt) blir `ask { kind: 'permission', … }`:
   - Titlar: "Hämta från nätet?" (WebFetch, SandboxNetworkAccess), "Köra ett kommando?" (Bash utan sandlåda), "Använda <verktyg>?" (övrigt).
   - `detail` är adressen, värdnamnet, kommandot eller en kort JSON.
   - `remember = suggestions.filter(s => s.type === 'addRules' && s.behavior === 'allow').map(s => ({ ...s, destination: 'session' }))`.
   - `canRemember = remember.length > 0 && !opts.suppressAlwaysAllowRule`.
   - `defaultNo = !!opts.defaultToNo`.
   - Svar:
     - `allow` → `{ behavior: 'allow', updatedInput: input }`
     - `allow-always` → dessutom `updatedPermissions: remember` (gäller processens livstid), aldrig `setMode`, `addDirectories` eller en annan destination
     - `deny` → `{ behavior: 'deny', message: 'The user said no.' }`
5. **Obesvarat** efter `permissionTimeoutMs` blir `deny` och `ask-done` med `timeout`. Avbryts turen blir det `cancelled`.
6. **Text som skrivs medan ett kort väntar** besvarar kortet, som i Claude Code:
   - `permission` blir `{ behavior: 'deny', message: 'The user said no and wrote instead: "<text>"' }`.
   - `question` blir `answered` med texten som svar på varje fråga.
   - `ask-done` skickas, och texten går inte fram som ett eget meddelande (den syns ändå som `user`).
   - Ett `secret`-kort får aldrig skriven text: det avböjs, och texten skickas som ett vanligt meddelande.

### 8.6 När en tur är klar

Körs bara vid `result` med `queued_turn_count === 0`. I ordning:

1. `git.commitAll(id, rad1)`
2. `registry.refresh(id)`
3. `backends.restart(id)`, villkorslöst (stoppar en backend som inte längre finns i manifestet). Därefter sänds `turn` slut (§8.3), och för en avbruten tur direkt efter den `note` "Avbröts – ändringarna finns kvar" när commiten i steg 1 tog med något, annars "Avbröts". Ångra finns i ⋯-menyn (§13). Misslyckades commiten kommer noten om det (§8.2) efter dem.
4. `registry.bumpRev(id)`, som får skalet att ladda om appen
5. `registry.setStatus(id, ok || interrupted ? 'idle' : 'error')`

`turn` slut sänds först efter steg 3. Förut kom den före commiten, och en GET mot appens backend direkt efter turslutet gav 503 på båda låtsasapparnas backends, eftersom manifestet läses om först i steg 2. Aktivitetsraden och stoppknappen följer status, som blir idle i steg 5 som förut, och meddelanden som kommer under stegen hålls som förut. Ett sådant meddelande, liksom ett som skickas efter Stopp, har därför sin `user`-rad före turslutet men blir en egen tur efter det: HUD:en ställer turens noter ovanför raden (§13), och uppläsningen väntar på meddelandets egen tur (§12). Stängs servern under stegen 1–3 (låtsas-Claude eller en andra signal, §7) sänder `closeAll` turslutet direkt, och en avbruten tur får "Avbröts", eftersom commitens resultat inte är känt. Bara en process som dör under stegen lämnar turen öppen, och den lagas då som avbruten vid nästa start (§8.10).

Under en tur laddar skalet **inte** om appen vid varje fil. Det sker bara när Claude anropar `reload_app` och när turen är klar.

`screenshot_app`, `try_app` och `call_backend` läser ändå om app.json först (`registry.refresh`, §8.7), och har något ändrats sänds `app` mitt i turen utan ny `rev`. Skalet laddar inte om appen för det, men det som läser AppInfo ser ändringen direkt: HUD:en visar behörighetskortet, och ett ja laddar om sidorna (`grants:changed`) med de filer som ligger på disk. Förut nådde ändringar i app.json skalet under en tur bara med `reload_app`, strax före den nya versionen. Känd lucka: fältet ser då också nya `opens` och `built` och lämnar det som skrivs där till sidan som visas, som kanske ännu saknar `wb.onOpen` (wb.js köar det, och kön försvinner med omladdningen när turen är klar), eller till ingen sida alls om appen ännu bara är ett tomt ark.

### 8.7 De sex MCP-verktygen (`tools.ts`, bundna till sessionens app, alla i `allowedTools`)

| Verktyg | Indata | Gör |
|---|---|---|
| `reload_app` | `{}` | `registry.refresh` → `backends.restart` (villkorslöst) → `bumpRev`. Svar: `Reloaded. Back end: running on port <p>` (eller `none` eller `crashed` plus de 20 senaste raderna med källorna `backend` och `workbench`, så att orsaken syns), plus konsolfel sedan förra omladdningen. I en ny session räknas den första omladdningen från loggens slut när sessionen skapades, så att gamla rader (till exempel de som läses in ur logs.txt efter en omstart) inte rapporteras som nya fel. |
| `screenshot_app` | `{ face?: string }` | `registry.refresh` (en sida som lagts till i app.json under turen ska synas; `manifest()` är annars en ögonblicksbild till nästa refresh), sedan `shots.screenshot` → `[{ type: 'image', data, mimeType: 'image/png' }, { type: 'text', text: '<w>×<h>, face <id>' }]`. Saknas sidan blir det ett textfel. |
| `get_app_logs` | `{ lines?: number }` | Standard 80, max 400. `logs.tail`, en rad per post. |
| `call_backend` | `{ method, path, body?, body_base64?, headers? }` | `path` måste börja med `/api/`. `registry.refresh` (en backend som lagts till i app.json under turen), `backends.ensure`, sedan `fetch` mot `127.0.0.1:<port>` med Host `127.0.0.1:<port>`, timeout 15 s. `body_base64` är en binär kropp (en bild, en fil) som standard-base64, högst 256 kB avkodad, med ett uttryckligt `content-type`-huvud och aldrig tillsammans med `body`; annars ett textfel före förfrågan (Friläggs byggare kunde förut inte skicka en bild till sin egen route). Svar: `HTTP <status>`, content-type och kropp, högst 20 kB. |
| `request_secret` | `{ key, label }` | `key` matchar `[a-z0-9_]{1,64}`. Ger `ask { kind: 'secret', key, label }` och väntar på svar. Värdet skrivs in i `apps/<id>/data/secrets.json` (0600, atomiskt, lstat-kontroll). Svar till Claude: `Stored in data/secrets.json as "<key>".` Avböjt eller tidsgräns: ett textfel. **Värdet loggas, sparas och sänds aldrig någon annanstans.** |
| `try_app` | `{ steps, store?, api?, face? }` | `registry.refresh` först (sidor, `opens` och behörigheter som ändrats i app.json under turen). Kör appen i en ny, osynlig kontext i shots-webbläsaren, i fönstrets storlek (DSF 1). Utför 1–20 steg: `click`, `hover`, `fill`+`text`, `type`, `press`, `wait` (lokaliserare eller ms ≤ 3000), `drag`, `upload`, `drop`, `paste`, `open` och `shot` (högst 2). `drag` är 2–50 punkter `[x, y]` i fönstrets CSS-px (ändliga tal, 0 ≤ x ≤ w, 0 ≤ y ≤ h): musen trycks ned vid den första, rör sig genom de andra med fem mellansteg per sträcka och släpps vid den sista; en punkt utanför fönstret ger en FAIL-rad. `upload`, `drop` och `paste` tar en lokaliserare (1–200 tecken) och ett `sample` ur listan `png` och `jpeg` (64×64-bilder, `sample.png` och `sample.jpg`) och `txt` (`sample.txt`, en kort svensk text), byggda i `samples.ts` och aldrig lästa från en sökväg som Claude anger: `upload` väljer filen i en `<input type=file>`, även en dold (`setInputFiles`), `drop` skickar `dragenter`, `dragover` och `drop` med filen i en DataTransfer, och `paste` ett `paste`-event med filen i `clipboardData`. Uppladdningen till backenden stoppas som andra skrivningar (409, under "Blocked requests"); backendsidan provas med `call_backend` och `body_base64`. `open` är `{ kind: 'url', url }`, `{ kind: 'date', date }` eller `{ kind: 'text', text }`, kontrollerat och normaliserat med `normalizeItem` som skalets `sendOpen`, och lämnas till första sidan som `World.deliver` gör: bara om app.json anger slaget i `opens` (annars en FAIL-rad med det som saknas), när sidan sagt hej, och står en annan sida framme byts den först till den första. En körning med `open` lägger appen i en iframe under en ram på skalets origin (§8.8), så att meddelandet går genom wb.js:s egen kontroll. Kamera och mikrofon: webbläsaren har låtsade enheter, och de av `camera` och `microphone` som app.json anger ges till appens origin i körningens kontext, även i ramen för `open` (där också till ramens origin, §8.8); svaret säger det på en egen rad (`Fake media: camera: fake device granted`), eftersom en låtsad enhet provar kedjan efter behörigheten, inte skalets fråga om den. Högst 5 s per steg (även `drag`) och 30 s totalt, stopp vid första fel, en körning per app åt gången. Stegen är högst 16 kB som JSON; `store` och `api` har egna tak på 64 kB var. Isoleringen är stängd som standard: `wb.store`-skrivningar går till en kopia som kastas. Läsningar ser kopian först och sedan den riktiga store (`store: 'copy'`, standard); `'empty'` eller ett frö (≤ 64 kB, nycklar enligt §7.2) svarar bara ur kopian. `api` låtsar backendsvar: högst 20 nycklar som börjar med `/api/` (eller är `/api`), saknar `#` och fortfarande ligger under `/api` när de normaliserats som webbläsaren skriver adressen. En GET eller HEAD på appens origin vars pathname+search är lika med en nyckel, eller vars pathname är lika med en nyckel utan `?`, besvaras med 200 `application/json` och värdet och når aldrig backenden. `/__wb/log` besvaras lokalt, övriga `/api/*` får bara GET/HEAD (annat 409, även till en låtsad nyckel), andra origins får bara GET, lokala värdar avbryts alltid (§8.8), WebSocketar stängs med 1008, service workers blockeras, och popupfönster samt navigering bort avbryts. Inget skrivs till disk och `rev` ändras inte. Svar: en rad per steg (ett drag som `drag 5 points (120,80)→(300,200)`, en fil som `upload "#fil" sample.png (image/png, 308 bytes)`), kasserade skrivningar (högst 300 tecken per nyckel), låtsade svar med antal träffar per nyckel (`Faked GET responses: /api/messages (3×), /api/folders (never requested)`), stoppade förfrågningar, öppnade adresser, sidbyten, konsolfel, synlig text (högst 1500 tecken) och PNG:er (`shot`-stegen plus en avslutande). Stoppas turen stängs kontexten direkt och spärren släpps. Skärmbilder har stegets tidsgräns, och den avslutande högst 5 s inom taket; misslyckas den kommer svaret ändå, med raden "Final screenshot failed: …". Känd lucka: en backend som ändrar tillstånd på GET nås ändå, utom på låtsade nycklar. |

### 8.8 Skärmbilder (`shots.ts`)

- `playwright-core` med `channel: 'chrome'`, en beständig osynlig webbläsare som startas vid första användning.
- En sida per app, viewport `round(w)×round(h)`, deviceScaleFactor 1.
- `goto` till appens sida och vänta på `load` plus 300 ms.
- Varje toppnavigering till en annan origin än appens egen avbryts.
- Förfrågningar till lokala värdar utom appens egen origin avbryts, både på skärmbildssidan och i `try_app`: `localhost`, `*.localhost`, 127.0.0.0/8, `[::1]`, `0.0.0.0`, `[::]` och IPv4-mappade `[::ffff:…]`, även med avslutande punkt (`localhost.` nådde förut lokala tjänster; uppmätt i våg 4). Känd lucka: ett DNS-namn som pekar på den här datorn (till exempel `127.0.0.1.nip.io`) eller datorns egen LAN-adress fångas inte av en kontroll av värdnamnet.
- `wb.js` postar redan appens egna `console.error/warn`, fel och avvisade löften till `/__wb/log`, även på skärmbildssidor. `shots.ts` loggar därför bara det `wb.js` inte kan se: meddelanden som webbläsaren själv skriver, till exempel misslyckade laddningar (utom 404 för `/__wb/store/`) och CSP-överträdelser. Källan är `console`.
- Stängs efter 10 min utan användning.
- `try_app` använder samma webbläsare men en ny kontext per körning. Ett init-skript sätter `window.__wbTry = true`, och då byter `wb.face.show(id)` på toppnivå sida med `location.assign`. `screenshot_app` går inte genom kopian: dess beständiga sida kör mot den riktiga store.
- Webbläsaren startas med `--use-fake-device-for-media-stream` (låtsade kameror och mikrofoner). Skärmbildssidan får aldrig någon behörighet; `try_app` ger appens origin de behörigheter app.json anger (§8.7), i ramen för `open` också ramens (nedan). Utan behörighet ger `getUserMedia` `NotAllowedError` (kalibrerat).
- **Ramen för `open`:** en körning med ett `open`-steg laddar först `http://localhost:<port>/__wb/try-frame`, en sida som provkörningens route bygger och som aldrig når servern, med appen i en iframe med skalets `sandbox` och ett `allow` med `fullscreen`, `clipboard-write` och de behörigheter körningen ger; själva appsidan laddas med `frame.goto`. Iframen saknar alltså `src`, och då täcker standardlistan `'src'` inte appen: `allow` skriver ut appens origin för varje funktion (`camera http://<id>.localhost:<port>`). Kamera och mikrofon ges också till ramens origin, eftersom Chrome prövar en inbäddad rams behörighet mot toppsidans origin, som skalets i Workbench. Uppmätt: utan origin i `allow` var `fullscreen`, `clipboard-write`, `camera` och `microphone` avstängda i ramen, och med bara den ena halvan gav `getUserMedia` `NotAllowedError` medan svaret sa "fake device granted" (kalibrerat åt båda hållen: det app.json inte anger förblir avstängt i ramen). wb.js tar bara emot meddelanden från en förälder på skalets origin (§11), så `open` går genom samma kontroll som i skalet, och ingen sida kan lämna det åt sig själv (kalibrerat mot en planterad wb.js utan kontrollen). Ramen svarar på hello med face, och provkörningen ger iframen fokus, så att tangenterna når appen. Ramen får inte navigera iframen själv: Chrome räknar en sida som inte kom från nätet som publik och stoppar då navigeringen till appens lokala adress (Local Network Access, uppmätt), så ramen noterar appens `wb.face.show` och provkörningen följer den med `frame.goto` efter steget.

### 8.9 Låtsas-Claude (`WORKBENCH_FAKE_CLAUDE=1`)

`fake.ts` ersätter SDK:n med ett deterministiskt manus för tester, utan några anrop. Allt utom själva modellen är detsamma: händelser, policy, §8.6 och verktygen. En tur består av:

1. `turn` start
2. ungefär 1 s med `delta`
3. `tool` Write "Skriver app.json"
4. `tool` Write "Skriver index.html", som skriver en riktig liten app med svensk text:
   - innehåller "kub" eller "sidor": tre sidor (main, sida2, sida3) där varje sida har knappar som anropar `wb.face.show(...)`
   - innehåller "klocka": en klocka
   - innehåller "backend" (inte i ett ord med bindestreck, som "backend-route" i fältets fråga, §10.9): en app med `server.mjs` och `GET /api/tid`
   - annars: en anteckningsapp med `wb.store`
5. `tool-done`
6. om texten innehåller "fråga": `ask` permission (`tool: 'WebFetch'`, `detail: 'https://example.com'`), och väntan på svar
7. om texten innehåller "hemlig": `request_secret`
8. `text` "Klart. …"
9. `turn` slut

`WORKBENCH_FAKE_SPEED` skalar alla pauser.

### 8.10 Omstart mitt i en tur

`createSessions` går vid start igenom varje `chat.jsonl`:

- obesvarad `ask` → `ask-done` med `cancelled`
- öppen tur → `turn` slut med `interrupted: true` och `note` "Avbröts", som efter ett stopp (§8.6)

### 8.11 Reglerna till Claude (`server/claude/app-rules.md`)

Läggs till systemprompten (§8.2), på engelska, och ändras bara via kontraktet (§16). Utöver appens anatomi, utseende, lagring, backend och sidor gäller:

- **Prat:** alltid på svenska, även fast reglerna, blocket och verktygssvaren är på engelska; Claude byter språk bara om användaren skriver på ett annat. Reglerna och språkraden (§8.4) säger att HUD:en visar varje textblock, även noter mellan verktygsanropen, och att alla ska vara på svenska (med "message to the user" nådde två engelska noter HUD:en, och de talade om användaren i tredje person). Mellan verktygsanropen högst en kort lägesrad per fas, ungefär 8 ord, som "Dagsidan är klar, nu bygger jag veckosidan." (text mitt i turen ersätts av nästa, §13). Förbudet mot text mitt i turen som stod här förut hölls aldrig: 13 av 17 riktiga turer hade sådan text, och 20 av 22 rader var nyttiga svenska lägesrader. Turen slutar med ett kort meddelande, högst två eller tre korta meningar: vad som ändrats och vad användaren själv måste göra ("ungefär 20 ord" överskreds i 16 av 17 avslut, median 33). Användaren ser appen medan svaret läses, så Claude beskriver den inte och förklarar inte hur den används. Claudes egna kontroller, filnamn, rubriker, listor och begränsningar som användaren inte kan göra något åt utelämnas. Reglerna ger ett bra exempel och tre dåliga på svenska: en beskrivning av appen och de två uppmätta felen, en brasklapp om Claudes egna kontroller ("Jag har inte kunnat testa …") och en begränsning som användaren inte kan göra något åt. Checklistan slutar med "skriv slutmeddelandet sist: på svenska, högst två eller tre korta meningar".
- **Fältet:** en app som kan ta emot och visa en adress, ett datum eller en kort text (en webbläsare, en kalender, anteckningar eller en att göra-lista) anger slaget i `opens` och tar emot det med `wb.onOpen` (§10.9) redan i första bygget, utan att användaren bett om det. Förut stod det "If the app can show such things", och ingen av Anders sex appar angav `opens`, så fältets snabba väg utlöstes aldrig. Bara `opens` och `wb.onOpen` når fram, aldrig en egen backend-route: den enda riktiga körningen av §10.9 steg 3 lade till `/api/open` i server.mjs, rörde aldrig app.json och svarade att adressen skulle öppnas direkt nästa gång. Claude provar det med `try_app`:s steg `open` (§8.7). Ber användaren att något från fältet ska öppnas direkt nästa gång lägger Claude till båda, provar och visar det användaren bad om i samma tur.
- **Förslag:** skalet lägger sidan Förslag sist på varje app (§10.8); Claude bygger ingen egen förslagssida och använder aldrig sid-id:t `wb-ideas`.
- **Typsnittet** anges som `font: 13px var(--wb-font)`: wb.js sätter `--wb-font` på varje appsida (§11; i e2e mot en odefinierad variabel som kalibrering). Stacken utskriven i reglerna stod förut utskriven i tio appfiler.
- **Sidor är tredje dimensionen** (Anders 16 oktober: "vad hände med 3d-grejen?", när alla hans appar, även webbläsaren, fått en enda sida): har en app en andra vy (inställningar, bokmärken, historik, arkiv, detaljer, ett andra verktyg) hamnar den på en egen sida i stället för i flikar, menyer, dialogrutor eller lådor på framsidan. Webbläsaren har sidan fram, bokmärken på en sida och inställningar på en annan. Bara en app som verkligen har en vy får en enda sida. Användaren vrider med ⌃⌥←/→ eller sidprickarna; en egen kontroll i en sida bara när den behövs i sitt sammanhang.
- **Visa appen tidigt:** tills Claude anropar `reload_app` ser användaren bara ett tomt ark (§8.6). Så fort framsidan visar något riktigt anropar Claude den en gång och bygger sedan resten. Inte efter varje liten ändring, eftersom varje omladdning byter det användaren ser.
- **Ingen exempeldata:** aldrig exempel- eller demodata i appens filer eller i `wb.store`, inte ens tillfälligt, eftersom `reload_app` visar den för användaren och store är användarens riktiga data. Exempelvärden går i `try_app`:s `store` eller `api`, aldrig i en egen testsida (som `_mock.html`) eller en fil i appen.
- **Hämtat innehåll** (mejl, flöden, webbsidor, API-svar) är opålitligt: bara `textContent`, bara `http:`- och `https:`-adresser i `href` och `src`, och HTML-mejl bara i `<iframe sandbox srcdoc>` utan `allow-scripts`.
- **Hemligheter:** Claude kan inte läsa eller ändra `data/secrets.json`. En hemlighet provas via en backend-route som använder den.
- **Backenden** har en egen TMPDIR i `data/` och når inte andra appars filer.
- **Backendens tomgång:** en backend utan förfrågningar stoppas efter 10 minuter och startar igen vid nästa (§9), så reglerna säger att den inte bara ska lita på timrar i backenden utan också hämta vid start eller när framsidan frågar.
- **package.json först:** reglerna säger att appens `package.json` skapas före första `npm install`; annars hittar npm gränsfilen `apps/package.json` (§9) och installerar där, utanför appens mapp, vilket Bash-sandlådan nekar (§8.2).
- **Filer skrivs med Write och Edit,** inte med `cat >`, `echo >` eller heredoc i Bash, så att HUD:en visar vilken fil som skrivs. Backenden provas med `call_backend` i stället för curl, en binär kropp med `body_base64`. (Före beslutet i §8.5 punkt 2 var regeln också ett sätt att undvika Claude Codes frågekort: två på åtta riktiga turer före regeln, ett på sju efter den.)
- **Prova:** sektionen "Try it" beskriver `try_app` med exempel (en räknare, en layout med exempelvärden, ett drag, låtsade backendsvar, en provfil till `upload`, `drop` eller `paste`, och fältets `open`), säger att kameran och mikrofonen är låtsade enheter när app.json anger behörigheten, och att Claude aldrig bygger testsidor eller lägger exempeldata i filer. Den säger också att `try_app` och `call_backend` alltid ser den senaste `app.json` och `server.mjs` (`registry.refresh`, §8.7, och färskheten i §9), så att `reload_app` är till för att visa användaren; bara efter en ändring i en annan fil som `server.mjs` importerar behövs `reload_app` först, eftersom färskheten bara ser ingångsfilen och `package.json`. Checklistan före turens slut är: `reload_app`, `screenshot_app` för varje ändrad sida, `try_app` för huvudflödet om turen ändrat hur appen reagerar på inmatning, och `get_app_logs`.
- **Märket och kanalen:** `wb.badge` (§10.5) och, för sidor som delar tillstånd, `wb.faces` och `wb.store.onChange` (§11) står i reglerna, så att nya appar använder dem i stället för egna `BroadcastChannel`-protokoll (Kalendern, Frilägg och Webbläsaren skrev var sitt).

### 8.13 Fältet (`server/claude/route.ts`)

Vart det som skrivs i fältet ska (§10.9), när skalet inte kan avgöra det själv. `POST /api/route` med `{ text, known }` (`known`: det skalet redan känt igen, `null` annars; kontrolleras igen med `normalizeItem`) → `RouteResponse`: `{ action: 'open', appId, item }` eller `{ action: 'build', name, prompt }`. En text som saknas, är tom eller längre än 2000 tecken ger 400, fel media-typ 415, en GET 405 och ett misslyckande 503 utan detaljer.

- **En engångsfråga** som förslagen (§8.12): utan verktyg och transkript, med samma isolering, i en egen katalog `data/route/`, modellen `claude-sonnet-5-5` och strukturerat svar. Högst 60 s.
- **Prompten** ger dagens datum och veckodag, de byggda apparna (id, namn, sidor, vad de öppnar och början av `CLAUDE.md`, högst 500 tecken) och det som skrevs. Apparna och texten är data, aldrig instruktioner. Claude väljer **open** när en app tydligt passar (en webbläsare för en adress, en kalender för ett datum, en anteckningsapp för en anteckning) med appens id, slaget och värdet, och annars **build** med ett namn (ett eller två ord) och en mening på svenska som beskriver appen och tar med det som skrevs.
- **Svaret rensas** (`cleanRoute`): bara en byggd app som finns, och ett giltigt värde (annars det skalet kände igen, annars texten); allt annat blir ett byggförslag (namnet högst 40 tecken, beskrivningen högst 400, annars "Ny app" och texten).
- **Låtsas-Claude** (`fakeRoute`): en adress till en app vars namn innehåller "webb", ett datum till "kalender", annars bygg.
- Uppmätt med riktiga Claude mot Anders appar: "dn.se" → Webbläsare, "20 okt" → Kalender, "köp mjölk och bröd" → bygg "Att göra", "ta bort bakgrunden på en bild" → Frilägg; 3–5 s per fråga.

### 8.12 Förslag (`server/claude/ideas.ts`)

Anders 16 oktober: "alla appar ska ha en sida som med hjälp av ai listar förslag på förbättringar av appen. klickar man på ett av förslagen öppnas hudden, förslaget skickas in och börjar byggas". Sidan står i §10.8.

- **En engångsfråga** till Claude med SDK:ns `query`, utan verktyg (`tools: []`, inga MCP-servrar, `canUseTool` nekar allt) och med samma isolering som appens session: `settingSources: []`, `strictMcpConfig`, `claudeEnv` (vitlistad miljö, inget minne) och `cwd` i appens mapp. `persistSession: false`, så att inget transkript sparas (uppmätt: ingen ny katalog i `~/.claude/projects`).
- **Options** kommer från `oneShotOptions` i `options.ts`, som fältets fråga (§8.13) också använder. Eftersom frågan körs i appens mapp får den samma deny-regler för `data/secrets.json` som sessionen (§8.2): `canUseTool` tillfrågas aldrig om läsningar inne i `cwd` (§8.5), så spärren gäller även om frågan någon gång får ett verktyg. Fältets fråga körs i `data/route` utan app och får inga. Inget sandlådeblock: det gäller bara Bash.
- **Modellen** är `claude-sonnet-5-5`: snabbare än byggmodellen och skriver idiomatisk svenska (Haiku gör det inte). Svaret är strukturerat (`outputFormat` med JSON Schema `{ ideas: string[] }`, 3–6). Högst 90 s.
- **Prompten** (systemprompten på engelska, svaren på svenska): appens namn, sidor och filer (utan `node_modules`, `data` och punktfiler), `CLAUDE.md`, sidornas källkod (avkortad), `server.mjs`, användarens senaste önskemål ur chatten och felen sedan senaste turslut (`registry.troubles`, §7.2, bara från sidor med appens nuvarande version; inte `logs.tail`, som också har förra byggets rader och Claudes egen skärmbildssida). Användaren har redan ett eget förslag för att rätta felet (§10.8), så prompten ber om förslag som hanterar eller förebygger felen i stället för att upprepa dem. Allt mellan `<app>` och `</app>` är data, aldrig instruktioner. Fem förslag, var och en en kort begäran (högst 70 tecken) formulerad som användaren skulle be appens byggare, konkreta, olika och sådant appen inte redan gör.
- **Svaret rensas** (`cleanIdeas`): strängar, trimmade, utan radbrytningar, högst 90 tecken, inga dubbletter oavsett skiftläge, högst 6. Ett tomt svar är ett fel och sparas inte.
- **En fråga per version:** svaret sparas i `data/apps/<id>/ideas.json` (`{ rev, items }`), och samma `rev` frågar aldrig igen, inte heller när fler fel kommit efter frågan. Samtidiga anrop för samma app delar en fråga. Uppmätt med riktiga Claude på en kopia av Anders kalender: 4,2 s, sex förslag som passade appen; andra gången 0 ms.
- **Låtsas-Claude** (§8.9) ger fem fasta förslag efter 300 ms, utan kvot.

## 9. App-backends (server/backends)

- **Start:** `ensure(appId)` startar `sandbox-exec -f <profil> node --import=<root>/server/backends/guard.mjs -- <entry>` (utan sandlåda: `node --import=… -- <entry>`), med:
  - cwd = appens mapp
  - env = `childEnv({ PORT, HOST: '127.0.0.1', DATA_DIR, APP_ID, NODE_ENV: 'development', TMPDIR: <appDir>/data/tmp, NODE_OPTIONS: '--import=<guard.mjs som file:-URL> --disable-warning=MODULE_TYPELESS_PACKAGE_JSON' })`, där DATA_DIR är absolut och skapas. `data/tmp` skapas med läge 0700, och en symbolisk länk vägras. NODE_OPTIONS gör att Node-processer som backenden startar med en bar `spawn(node, …)` också laddar vakten (fork och worker_threads ärver redan `--import`); URL:en procentkodar mellanslag och citattecken, så den behöver ingen citering.
  - `apps/package.json` (utan `"type"`) skapas om den saknas och får läsas i profilen som enskild fil. Den är gränsen för Nodes paketuppslag: utan den letar Node uppåt från appens mapp till workbenchens package.json i den stängda roten, och Node 24 och 26 dör av EPERM där (`ERR_INVALID_PACKAGE_CONFIG`, uppmätt med 24.22.0 och 26.12.0; Node 25 tål det). Läsrätt till förfädernas package.json vore fel, för då gäller workbenchens `"type": "module"` för apparna och en backend i CommonJS dör (uppmätt). Med gränsfilen tolkas en app utan egen package.json som om ingen fanns, med eller utan sandlåda; varningen om att filen saknar `"type"` gäller inte appen och stängs av i NODE_OPTIONS. npm:s projektuppslag stannar också där: i en app utan egen package.json blir `apps/` npm:s prefix (§8.11).
- **Profilen** (`sandbox.ts`, SBPL, genereras per app till `data/apps/<id>/backend.sb` (0600), enhetstestad mot flykttesterna). Senaste matchande regel vinner, så ordningen är viktig. "Stängda rötter" är `$HOME`, `WORKBENCH_HOME` om den ligger utanför `$HOME`, och de delade tillfälliga katalogerna: användarens katalog under `/private/var/folders/<a>/<b>` (föräldern till `DARWIN_USER_DIR` ur `getconf`, med TMPDIR i `T`, andra programs cacher i `C` och `DARWIN_USER_DIR` i `0`), realpath av TMPDIR om den ligger någon annanstans, `/private/tmp` och `/private/var/tmp`. De stängs för både läsning och skrivning. Förut stängdes bara TMPDIR, och en backend kunde läsa andra programs cacher i `C` (Safari, Anteckningar, Bilder, clang) och skriva där (granskningen 17 oktober); Node-start, DNS, fetch över HTTPS och fork med IPC fungerar med hela katalogen stängd (uppmätt). "Skrivspärrade kataloger" är realpath av Node-prefixet, katalogen som `nodePath` ligger i, workbenchens repo (`config.root`), `/opt/homebrew`, `/usr/local`, `/Users/Shared`, `/Volumes`, `/Applications`, `/Library` och `/cores`, de som finns. De tre sista har kataloger som admin-gruppen eller alla kan skriva i (`/Applications`, `/Library/Fonts`, där ett typsnitt laddas av alla program, `/Library/Caches` och `/cores`). De får läsas (libnode, Homebrews verktyg) men aldrig skrivas, inte heller genom en hård länk i data/: `npm run dev` och `npm start` kör samma Node och repo osandlådat, också när repot ligger utanför `$HOME`, och uppmätt kunde en backend annars skapa kataloger i Node-prefixet, `/opt/homebrew` och `/Users/Shared`. Spärren ligger före tillåtelserna för TMPDIR och data/, så att de förblir skrivbara även när `WORKBENCH_HOME` ligger i en spärrad katalog (till exempel på `/Volumes`); en spärrad katalog i appens mapp eller TMPDIR vägras. `<TMPDIR>` nedan är appens egen:

  ```
  (version 1) (allow default)
  (deny file-write* <stängda rötter>)
  (deny file-write* <skrivspärrade kataloger>)   ; läsning tillåts
  (allow file-write* (subpath "<TMPDIR>"))
  (deny file-write* <stängda rötter som ligger under TMPDIR>)
  (allow file-write* (subpath "<appDir>/data"))
  (deny file-read* <stängda rötter>)
  (allow file-read* (subpath "<appDir>") (literal "<root>/server/backends/guard.mjs") (literal "<home>/apps/package.json") (subpath "<Node-prefix om i en stängd rot>"))
  (allow file-read-metadata (literal <varje förfader till appDir, guard.mjs och Node-prefixet>))   ; annars startar inte Node
  (deny network-outbound (remote ip "*:<port>") (remote ip "*:<hmrPort>") (remote ip "*:<andra backends portar 18300–18499>"))
  (deny network-outbound (remote unix-socket))
  (allow network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))   ; DNS
  (deny mach-lookup (global-name "com.apple.coreservices.launchservicesd"))   ; ingen väg ut via open/LaunchServices
  (deny mach-lookup (global-name-regex #"^com\.apple\.lsd\.") (global-name "com.apple.coreservices.quarantine-resolver"))
  (deny appleevent-send)
  ```

  Formen `*:<port>` krävs: `localhost:<port>` släpper igenom `::ffff:127.0.0.1` (uppmätt). Raden för `lsd` och karantänkontrollen krävs också: med bara launchservicesd och appleevent-send startade `open -a Calculator` ändå (uppmätt), eftersom `open` då går via lsd. Med raden misslyckas `open` med namn, bundle-id och sökväg, medan DNS, fetch och fork fungerar. Andra lokala tjänster (till exempel Ollama, Whisper) är nåbara med avsikt. Om även de ska stängas är det användarens beslut.
- **Processgrupp:** backenden startas som ledare för en egen processgrupp (`detached`). Stopp skickar SIGTERM/SIGKILL till `-pgid`, och `lsof` körs med `-g <pgid>`, så att barnprocesser också fångas. Ett barn som lämnar gruppen (`setsid`, `spawn` med `detached`) syns inte för lsof och dödas inte vid stopp; ett Node-barn med vakten (NODE_OPTIONS) avslutar sig ändå när dess förälder dör, men ett barn utan vakten blir kvar (uppmätt).
- **guard.mjs** (ägs av workbenchen, utanför appen):
  - Tvingar `net.Server.prototype.listen` att binda 127.0.0.1 oavsett vilken värd som anges.
  - Svarar 421 på `request` och `upgrade` vars Host inte är `127.0.0.1:<PORT>` eller `localhost:<PORT>`, eller samma namn med serverns egen port (`req.socket.localPort`). Ett barn ärver vakten genom NODE_OPTIONS och backendens PORT genom miljön, och dess egen server ska svara på sin port; en sida som rebindar har aldrig loopback i Host.
  - Efter att backenden är redo körs `lsof -a -p <pid> -iTCP -sTCP:LISTEN -nP`, och sedan igen var 30:e sekund medan den kör (`listenCheckMs`), så att en lyssnare som öppnas senare i processgruppen också fångas. Lyssnar något på en annan adress än loopback dödas backenden.
- **Port:** första lediga från 18300. Kontrollera med `net.createServer().listen` innan den används.
- **Redo:** när porten svarar på TCP, inom högst 8 s. Status `starting` → `running`. Går det inte blir status `crashed` och loggen innehåller orsaken.
- **Start i praktiken:**
  - lat, vid första `/api/*`-förfrågan
  - vid `reload_app`, `call_backend` och `restart`
  - aldrig för appar utan backend
- **Färskhet:** `ensure()` lämnar aldrig ut en backend vars kod ändrats sedan start. Har ingångsfilen eller appens `package.json` fått annan mtime eller storlek, eller `backend.entry` i manifestet ändrats, startas backenden om genom omstartsvägen (inte kraschvägen) innan porten lämnas ut, med raden "Backendens kod har ändrats sedan start: startar om." i loggen.
- **Krasch:** omstart efter 1, 2 och 4 s, högst 3 gånger per 60 s. Därefter `crashed` tills nästa `restart`, eller tills koden ändras (Uppgiven, nedan). Status rapporteras med `registry.setBackend`. Varje krasch (processen avslutades utan att supervisorn bett om det) lämnar sin sista stderr-rad som börjar med ett felnamn till `registry.noteLog(appId, 'stderr', rad)` när strömmarna är lästa (felsignalen, §7.2).
- **Uppgiven:** när supervisorn ger upp (kraschat för ofta, en start som inte går: ogiltig `backend.entry`, ingen ledig port, sandlådeprofilen, eller en backend som lyssnade utanför loopback, efter redo eller vid kontrollen under drift) anropas optionen `onCrashed(appId, text)` till `createBackends` (standard: ingenting) med orsaken och de tre sista raderna från backendens senaste start (utan stackrader, Nodes markering `^` och versionsraden, sökvägar relativa appens mapp, högst 200 tecken var), när processens stdout och stderr stängts (högst 1 s; de sista raderna kan komma efter `exit`). `main.ts` gör den till en not i appens HUD (`sessions.note`, §8.1). Förut var den bärnstensfärgade pricken enda spåret.
  - Orsaken efter för många krascher är "Backenden kraschade 4 gånger på 60 s. Den startar igen när Claude ändrar appen eller när du ångrar.", i loggen och i noten. Förut stod det "startas inte om förrän appen laddas om", men ingen omladdning startade den (QA 17 oktober).
  - En uppgiven backend startar igen när koden ändrats sedan det senaste startförsöket: `ensure()` jämför ingångsfilen och appens `package.json` (mtime och storlek) och `backend.entry` med försökets, och har något ändrats startar den, med raden "Backendens kod har ändrats sedan den gavs upp: startar igen." i loggen. Det sker vid appens nästa förfrågan eller `call_backend`, efter en rättning för hand eller av Claude mitt i en tur. Annars startar bara `restart` den: `reload_app`, turens slut (§8.6) och Ångra eller Gör om (§7.4).
- **Loggar:** stdout och stderr radvis till `logs.append(appId, 'backend', rad)`, högst 200 rader per sekund och app. Resten räknas och nämns i en rad. Har mer än tio gånger sekundens tak släppts pausas strömmarna resten av sekunden, så att röret ger mottryck.
- **Stopp:** SIGTERM, sedan SIGKILL efter 2 s. `stopAll` vid avslut.
  - Tomgång: en backend som kört i `WORKBENCH_BACKEND_IDLE_MS` (standard 10 min, 0 = aldrig) utan någon förfrågan stoppas på vanligt sätt (`stopped`), och nästa förfrågan startar den igen. Routern räknar pågående förfrågningar och uppgraderade socketar (`hold` i `supervisor.ts`, släpps när svaret eller socketen stängs), så en ansluten WebSocket eller SSE-ström håller backenden vid liv. Timern går bara när inget pågår och backenden kör; `ensure()` räknas som aktivitet, så också `call_backend`. En förfrågan som kommer medan tomgångsstoppet pågår får en ny process direkt efter stoppet, men under ett uttryckligt `stop()` (deleteApp tar bort appen direkt efter) ger `ensure()` null och köar ingen start. `<workbench>`-blocket säger då "Back end: stopped (the next request or call_backend starts it)."
- **Proxy:**
  - HTTP: `http.request` mot `127.0.0.1:<port>` med samma metod, sökväg och huvuden. `host` skrivs om till `127.0.0.1:<port>`, `x-forwarded-host` och `x-forwarded-proto` sätts. Strömmande i båda riktningar.
  - WebSocket: `net.connect`, den råa uppgraderingen skrivs vidare och socketarna pipas.
  - **Felhanterare på varje socket och förfrågan.** Node 25 kastar annars EPIPE och tar ner processen. Fel ger 502 `{ "error": "backend" }`.
- **Linux senare:** `bwrap` i stället för `sandbox-exec`.

## 10. Skalet (web/)

### 10.1 Lager (index.html, nerifrån och upp)

| Lager | Innehåll |
|---|---|
| `#bg` | WebGL-canvas (three.js, `OrthographicCamera` med samma kamera som DOM). Ytan, rutnät, glöd, partiklar. `pointer-events: none`. |
| `#world` | Fönstren i världskoordinater. En transform: `translate(tx px, ty px) scale(s)`, `transform-origin: 0 0`. |
| `#ink` | SVG i skärmkoordinater för ritstreck och övergångar ovanpå fönstren. `pointer-events: none`. |
| `#chrome` | Skärmfast fönsterkrom (prick, grepp, sidprickar, storlekszoner, kantmarkörer). `pointer-events: none` på lagret; kromelementen har `auto`. |
| `#hud-layer` | HUD:arna. `pointer-events: none` på lagret; panelerna har `auto`. |

**Tom yta** är bara `#stage`, `#bg` eller `#world` själva. Inget i `#hud-layer` eller `#chrome` räknas som tom yta.

`index.html` har `<link rel="icon" href="data:,">`, så att ingen `/favicon.ico` begärs.

### 10.2 Kamera

`Camera { cx, cy, zoom }` i protokollet. Internt `s = zoom`, `tx = vw/2 − cx·s`, `ty = vh/2 − cy·s`, och `skärm = värld·s + t`.

- **Zoom kring en punkt:** världspunkten under markören står still.
- **Zoomgränser:** 0,05–8.
- **Flyg till:** zoom interpoleras i log-skala, ease-out cubic, ungefär 380 ms. En stack håller "tillbaka".
- **WebGL:** `ortho.left = −tx/s`, `right = (vw − tx)/s`, `top = ty/s`, `bottom = −(vh − ty)/s` (three.js har y uppåt, världen y nedåt).
- Uppdateringar samlas i **en** `requestAnimationFrame` och skriver bara transformer och uniforms.
- `bus.emit('view:changed')` högst en gång per bildruta.
- `store.setCamera` anropas när rörelsen lagt sig.

### 10.3 Input, tangenter och gestkarta

- **Hjulet:** en router på `#stage` med `{ passive: false }`. Om första händelsen inte stoppas zoomar Chrome hela sidan.
  - **Över en HUD:** ett hjul utan ctrl/⌘/⌥ vars target ligger i `#hud-layer` lämnas orört (ingen `preventDefault`, ingen panorering). Listan har `overscroll-behavior: contain`.
  - **Allt annat får `preventDefault`:**
    - ctrl+wheel → zoom med `Math.exp(−clamp(dy, −50, 50)/100)`, där `dy` normaliseras för `deltaMode` 1 (×16) och 2 (×400).
    - ctrl och dx = dy = 0 och `wheelDeltaY` = 0 → smart zoom (tvåfingers dubbeltryck) → flyg till fönstret under markören, eller tillbaka. På tom yta utan något att flyga tillbaka till visar den allt, som ⌘0.
    - ⌘+wheel → panorera.
    - ⌥+wheel → fönsteroperation: ⌥+nyp skalar fönstret under markören, ⌥+vågrätt vrider en prisma.
    - Vanligt hjul → panorera.
  - Safari: `gesturestart/change/end` (`scale`). ctrl-hjul ignoreras medan en gest pågår.
  - Ingen DOM-händelse avslutar ett nyp, så "nyp slut" är 120 ms utan händelser.
- **Från appar** via bryggan (§11), med punkten omräknad till skärmen genom fönstrets transform:
  - `wheel/zoom` → zoom kring punkten, eller med `alt` skala fönstret, eller med `smart` flyga
  - `wheel/pan` → panorera
  - `wheel/alt` → vrid prisma
  - `key` → samma tangenthanterare som skalet
  - `focus` → `World.focus`
  - `face` → vrid fram sidan
  - **Grinden** (`web/src/world/gate.ts`) avgör om appen får använda bryggan just nu:
    - `key` godtas bara när appens iframe har tangentbordsfokus (`document.activeElement` är iframen och `document.hasFocus()`).
    - `wheel` och `focus` godtas när iframen har tangentbordsfokus, eller när skalet senast såg pekaren (betrodd `pointermove`, `pointerdown` eller `wheel`) inom 96 px från appens fönster, med fönstrets plats då eller nu.
    - `wheel` godtas också från en app vars fönster ligger inom 96 px från ett sådant fönster, i en kedja: pekaren kan gå från iframe till iframe utan att skalet ser den (ett snabbt drag hoppar över storlekszonerna; uppmätt).
    - När skalet inte vet var pekaren är, alltså innan det sett någon pekarhändelse sedan sidan laddades och sedan pekaren lämnat sidan vid vyns kant (`pointerleave` på `<html>` utan `relatedTarget`), godtas `wheel` från en app vars fönster syns och, för ett nyp, ligger överst i hjulets punkt. `focus` och `key` godtas aldrig så. Panorering och ⌥-hjul har ingen punkt i bryggan, så i det läget kan en synlig app panorera världen tills pekaren syns igen.
    - Allt annat släpps tyst. En pekare inne i en app-iframe syns inte för skalet (ingen `:hover`, inga pekarhändelser; uppmätt), så pekaren måste ha korsat skalet på väg in, komma från ett fönster intill eller komma utifrån (se ovan).
- **Tangenter:** världen äger **den enda** `keydown`-lyssnaren på skalets `window` (capture) och anropar samma funktion från bryggans `onKey`.

  | Tangent | Effekt |
  |---|---|
  | ⌘K | `hud:open { reason: 'key' }` för appen i fokus, eller `hud:close` om appens HUD redan är öppen, aktiv eller inte (enligt senaste `hud:state.open`). Ingen app i fokus: ingenting. |
  | ⌘0 | visa allt |
  | ⌃⌥←/→ | vrid prisman i fokus. Ett ackord som Chrome inte reserverar; verifieras en gång för hand. |
  | Esc | `runEscape()` |

  HUD:arna lyssnar bara på sina egna textrutor (Enter, ⇧Enter, mellanslag) och stänger den aktiva vid Esc bara via sin gemensamma `pushEscape`-hanterare. Utanför textrutorna lyssnar hanteraren (`hud.ts`) bara på `keydown` på dokumentet för skriv var som helst (§13) och, för mellanslaget som talar in, på `keydown` och `keyup` på dokumentet (capture), fönstrets `blur` och dokumentets `visibilitychange` (§10.9, §12). **Appen i fokus** är den senaste från `World.focus` (som HUD:en anropar när pekaren eller tangentbordsfokus går in i en HUD vars app inte är den i fokus, §13) eller bryggans `focus`.
- **Drag som skalet äger** (rita, flytta, ändra storlek, skala): `setPointerCapture` plus skölden `html.wb-dragging iframe { pointer-events: none }` tills `pointerup`/`pointercancel`, och en tröskel på 4 px.
- **Gestkarta:**

  | Gest | Effekt |
  |---|---|
  | Tryck och dra på tom yta | rita en ny app (§10.4). Öppna HUD:ar står kvar. Ett tryck på tom yta (släpp utan att pekaren rört sig 4 px) stänger den aktiva HUD:en (`hud:close`). |
  | Tvåfingers scroll som börjar på tom yta, eller ⌘+scroll var som helst | panorera |
  | Nyp | zooma |
  | Dra greppet | flytta fönstret |
  | Dra kant eller hörn | ändra storlek (appen flödar om; heltal) |
  | ⇧+hörn eller ⌥+nyp över fönstret | skala (ingen omflödning) |
  | ⌥+vågrätt svep, ⌃⌥←/→, klick på sidprick, eller `wb.face.show()` | vrid prisma |
  | Dubbelklick på greppet, eller smart zoom över fönstret | flyg till fönstret; samma igen eller Esc flyger tillbaka |
  | Dubbelklick eller smart zoom på tom yta | flyg tillbaka, eller visa allt när det inte finns något att flyga tillbaka till (⌘0 med pekaren). Dubbelklicket ritar inget och stänger högst den aktiva HUD:en, som ett tryck: dess andra tryck (`mousedown.detail` 2) stänger ingen till. Blir det andra trycket ett drag ritar det som vanligt, och avbryts det med Esc händer inget; kameran står still i båda fallen. Ett dubbelklick på kromen eller i en HUD räknas inte (bara tom yta), och ett i en app ser skalet aldrig. |
  | ⌘0 | visa allt |
  | Klick på pricken | `hud:open { reason: 'dot' }`, eller `hud:close` om appens HUD redan är öppen, aktiv eller inte. Pricken tar inte fokus vid klick (som HUD:ens ikonknappar), så tangentbordsfokus står kvar där det var. |
  | ⌘K | öppna eller stäng HUD:en för appen i fokus |
  | Esc | det innersta först: avbryt drag → stäng den aktiva HUD:en → flyg tillbaka |

### 10.4 Rita en ny app

- Pekare ned på tom yta (vänsterknapp, inga modifierare) och rörelse över 4 px startar ritandet.
- Under ritandet syns ett levande streck i `#ink`, plus en spökrektangel som är streckets omslutande rektangel. Det fungerar både för ett snabbt diagonalt drag och för en handritad slinga.
- Den ritade rektangeln och spökrektangeln kläms till vyn minus 24 px, så att pricken och greppet alltid syns.
- **Släpp:** är rektangeln mindre än 120×80 skärm-px tonar den bort. Annars:
  - Layoutstorleken blir den ritade storleken i **skärm-px**, avrundad till heltal, och `scale = världsbredd / w`. Det man ritar är det man får.
  - Kläms layouten utanför 240–2400 × 160–1600 justeras skalan så att världsrektangeln blir exakt den ritade.
  - Världen anropar `await store.createApp({ x, y, w, h, scale })`.
    - **Lyckas det:** fönstret ritas (idempotent per `win.id`, så att en `window`-händelse före eller efter svaret bara uppdaterar), materialiseras med animation (§14), och världen sänder i ordning `window:created` och `hud:open { reason: 'created' }`, 220 ms efter släppet eller när svaret kommer om det dröjer längre.
    - **Misslyckas det:** spökrektangeln tonar bort.
  - Bara en ny app åt gången: släpps en ny rektangel medan den förra fortfarande skapas tonar den bort.
- **Tangenttryck före `hud:open`:** världen samlar dem (tecken och backsteg, utan ⌘/ctrl/⌥) och skriver in dem i den inmatning i `#hud-layer` som fått fokus, inom 1,2 s. Inget tecken tappas mellan släppet och HUD:en.
- **HUD:en mäter själv släppet** (`pointerup`) och börjar glida ut direkt när `hud:open` kommer. Uppmätt: 228–230 ms efter släppet.
- Öppna HUD:ar står kvar medan man ritar. Tangenttryck medan knappen hålls ned hamnar aldrig i dem (skriv var som helst väntar tills draget är slut, §13).

### 10.5 Fönster och prismor

- **Fönstrets yta:** rundade hörn och mjuk skugga (§14).
  - Byggd app: en iframe per sida, `src = http://<id>.localhost:<location.port>/<page>`, med attribut enligt §4.4.
  - Inte byggd: fröytan, och "byggs"-animationen medan `status === 'building'`.
- **Omladdning:** världen skapar eller byter iframes bara när `rev` **ändras**, eller första gången en app syns som byggd. Ändrade `built` eller `faces` utan ny `rev` tillämpas vid nästa `rev`.
  - För varje sida skapas en ny iframe dold bakom den gamla. När dess `load` kommit, eller efter högst 4 s, tonas den nya in under 180 ms och den gamla tas bort. Det blir aldrig en vit blinkning.
  - `grants:changed` för appen ger samma byte.
- **Utanför vyn:** ett fönster vars skärmrektangel, utvidgad med sin största sida men minst en halv vy, inte når in i vyn får `wb-offscreen`, och dess iframes `visibility: hidden`. Det tar dem ur kompositeringen, som annars kostar för varje app under zoomen även när den inte syns, men de laddas inte om och appens skript och timers går som förut (uppmätt i Chrome med vanlig strypning: en 16 ms-timer går 94 gånger på 1,5 s i vyn och 3–4 gånger utanför vyn, dold eller inte, och en klocka visar rätt tid i första bildrutan tillbaka). Marginalen gör att appen hunnit rita när den panoreras in eller flygs till utan att zoomen ändras: med bara fönstrets egen storlek blinkade ett litet fönster som panorerades in i översikten (60 px per bildruta) vitt i första bildrutan, med en halv vy inte. Kommer appen in medan zoomen ändras (en flygning som zoomar, ett nyp ut, med minskad rörelse ett hopp) syns fönstrets vita ark i första bildrutan, på en mörk app som en vit blink. Det gör Chrome ibland även utan döljandet, men med det varje gång (uppmätt omväxlande med `tests/perf/offscreen-flash.mjs`: dold i alla körningar, inte dold allt från var sjätte gång till varje gång, olika från körning till körning). Undantag: ett minimerat fönster (det syns i raden) och ett vars iframe har tangentbordsfokus (att dölja den tar fokus från appen).
- **Prisma** (`faces.length > 1`):
  - Under rotation: wrapper med `perspective: 1400px`, sedan `.rot` (`transform-style: preserve-3d`, `translateZ(−a) rotateY(θ)`), sedan sidorna (`rotateY(i·360/n) translateZ(a)`, `backface-visibility: hidden`).
  - Apotemet är `a = w/(2·tan(π/n))`; för n = 2 är det 0, alltså ett kort med baksida.
  - **I vila:** snäpp till närmaste sida och platta till. Wrapperns `perspective: none`, `.rot` får `transform-style: flat` och `transform: none`, sidorna `transform: none`, och övriga sidor `visibility: hidden`.
  - `.prism, .rot { pointer-events: none }`, `.face { pointer-events: auto }`, annars stjäl behållaren klicken.
  - Ett ⌥-svep följer fingrarna och snäpper vid första `momentum`-händelsen eller efter 140 ms. En snabb flick går en sida.
  - Rotationen animeras med `--wb-spring-calm` i sin egen längd (785 ms) för en hel sida, synligt klar efter ungefär 450 ms. Kortare vridningar går fortare, ned till 420 ms. Titten tar 420 ms.
  - Världen svarar på varje `hello` med `{ type: 'face', current }` till just den iframen, och skickar samma meddelande till alla sidor när den främre sidan ändras.
  - `win.face` sparas.
  - **Titt:** när pekaren närmar sig vänster eller höger kant (inom 24 px utanför) lutar prisman 16° mot nästa sida (42° på en tresidig prisma, vars grannsida annars aldrig vetter mot betraktaren). Under titten är den i 3D, och den plattas till igen när pekaren går. Ett klick där vrider prisman.
  - **Platt i vila på alla zoomnivåer.** En prisma står i 3D bara medan den vrids, tittar eller snurrar. Förut lutade prismor under zoom 0,85 (rotateY −24°, rotateX −10°) för att visa djupet, men Anders arbetar på den zoomen och såg det som ett fel (16 oktober: "när en app har roterat så lägger den sig lite snett", på zoom 0,75). Lutningen är borttagen; sidprickarna visar att appen har flera sidor.
  - Efter en tur som ändrat `faces` snurrar prisman ett varv (1,2 s, `--wb-spring-calm`) och plattas sedan till.
  - Pricken följer kroppens övre högra hörn: av sidorna som vetter mot betraktaren den vars 45°-punkt ligger längst till höger. När en sida vridits 55–85° glider punkten längs överkanten mot hörnet den delar med grannsidan, så att pricken rör sig utan hopp. I vila, under titten och på ett kort med två sidor är det samma punkt som den främre sidans övre högra hörn.
- **Krom** (`#chrome`, skärmfast storlek, utseende i §14):
  - **Pricken:** sitter på fönstrets övre högra hörn. Animationen speglar status:

    | Status | Prick |
    |---|---|
    | idle | lugn andning |
    | building | snabb puls med ring |
    | waiting | blinkar |
    | error, backend `crashed`, eller ett fel efter turen (`trouble`, §7.2) | bärnstensfärgad |

    Andningen och blinkningen går bara där de syns: halon andas inte när den är dold (översikten och raden) och ingenting rör sig under ett annat fönster eller utanför vyn. De fortsätter i samma fas när pricken syns igen.
  - **Märket** (`wb.badge`, §11): pricken är Claudes kanal men också appens röst. En app kan visa högst tre tecken, till exempel antalet olästa mejl, i en liten kapsel till höger om prickens kärna, satt med `textContent`. Claudes lägen går före: under `building` och `waiting` syns inget märke, medan bärnsten och märket kan synas samtidigt. Märket hör till sidan som satte det, och inget sparas i scenen (princip 7): laddas sidan om (ny `rev`) och den nya sidan inte sätter det igen är det borta, så appen skickar det när den laddas. Det döljs med pricken under ett annat fönster, och för sig när ett fönster ovanför täcker någon del av det: det sticker ut till höger om fönstret och skulle annars ritas över det fönstret och ta dess klick (som zonerna). På miniatyren (§10.7) är det en fylld prick utan text.
  - **Greppet:** smal "pill" under fönstrets mitt. Dra för att flytta, dubbelklicka för att flyga till.
  - **Sidprickar:** bredvid greppet, bara när det finns mer än en sida. Klick vrider fram sidan.
  - **Minimera:** en liten nedåtpil till höger om greppet (§10.7).
  - **Ta bort** (Anders 16 oktober: "appar behöver en knapp för att radera appen"): ett kryss till höger om minimeringen, i greppets färg och rött vid hovring. Första klicket gör det till en röd "× Ta bort" som växer åt höger; först ett andra klick tar bort appen (`World.dissolve` och `store.deleteApp`, som i ⋯-menyn, §7.4), och dess HUD stängs vid `app.removed`. Esc, ett klick någon annanstans eller 4 s avbryter. Knappen tar inte fokus och syns inte på en minimerad app eller under en animation.
  - **Storlekszoner:** osynliga 10 px utanför kanter och hörn.
  - **Under ett annat fönster** (Anders 16 oktober: "när jag drar muspekaren över en app så triggas även appar som ligger bakom den"): kromen ligger över alla fönster, så ett fönsters zoner och knappar skulle annars ta pekaren över ett fönster ovanför. Där ett fönster med högre `z`, eller en miniatyr i raden, täcker en kantzon eller titt-zon står bara den största fria delen kvar (`freeStrip` i `layout.ts`; under 8 px, för titten 20 px, ingen alls). Täckta hörnzoner, sidprickar och knapparna för minimera och ta bort döljs, liksom pricken och greppet förut. Uppmätt mot den gamla kromen: pekaren över det övre fönstret träffade det undres storlekszon, och appen bakom tittade.
  - **Kantmarkörer:** små markörer vid vyns kant mot fönster utanför bild. Klick flyger dit. En markör vars träffyta (24 px) når in i ett fönster i vyn eller dess krom (prickens sken och greppets rad, 26 px under nederkanten), eller i en miniatyr, döljs och tar ingen pekare, som kromen under ett fönster ovanför. Annars låg den som en blå prick ovanpå appens innehåll, tog dess klick och såg ut som lös krom vid greppet (QA 17 oktober).
  - **Utanför vyn:** kromen till ett fönster vars skärmrektangel plus 48 px (14 px per sida när sidprickarna når längre) ligger helt utanför vyn läggs inte ut. Den göms (`display: none`) och en armerad Ta bort avbryts, så att Esc aldrig går till en knapp som inte syns. Kommer fönstret tillbaka läggs kromen ut i samma bildruta. Ett fönster i 3D (vridning, titt, snurr) läggs alltid ut, eftersom silhuetten når utanför rektangeln, och likaså fönstret som flyttas eller ändrar storlek, eftersom greppet eller zonen håller pekaren.
- **Fokus:** pekare ned i ett fönster (bryggans `focus` för en byggd app, skalets egen `pointerdown` på fröytan och arket) eller i dess krom anropar `World.focus`: fönstret läggs överst (`z` = max + 1) och appen blir den i fokus. HUD:en anropar också `World.focus` när pekaren eller tangentbordsfokus går in i en HUD vars app inte är den i fokus (§13). `bus.emit('app:focus')`.
- **Borttagning:** `World.dissolve` är idempotent. Världen löser själv upp fönstret vid `window.removed` eller `app.removed` om det inte redan pågår. Ett fönster som löses upp, och dess krom, tar aldrig mer emot pekaren (`.wb-gone` med `pointer-events: none !important`, och `inert`), så att ett nytt drag på samma ställe ritar direkt.

### 10.6 Visa allt och vilse-skydd

- ⌘0 flyger så att alla fönster ryms med marginal (de minimerade räknas inte).
- Med pekaren: dubbelklick eller smart zoom på tom yta gör samma sak när det inte finns något att flyga tillbaka till (§10.3), och samma igen flyger tillbaka. Men bara till en vy där något fönster syns: ⌘0 och visa allt lägger vyn de lämnar i tillbaka-stacken bara då. En tom vy är den man var vilse i, och förut flög ett andra dubbelklick efter visa allt tillbaka ut i tomheten (QA 17 oktober). Tio ctrl-hjulsteg ut gör fönstren 20–30 px stora (zoom 0,05), och då fanns ingen väg tillbaka utan tangentbordet.
- Utan fönster är ytan tom och kameran står still.
- Kantmarkörerna (§10.5) visar åt vilket håll apparna finns.

### 10.7 Minimera (`web/src/world/shelf.ts`)

Anders 16 oktober: "man borde kunna minimera appar på något coolt sätt t.ex att dom roterar och glider ner på rad i det vänstra hörnet". Hans val: ett kortkommando och ⋯-menyn, ingen gest. Men ⌃⌥↓ tar webbläsaren och ⌃⌥M ofta systemet ("fångas ofta av systemet som minimerar browsern istället. finns det ingen knapp för att minimera?"), så det blev en knapp i kromen och inget kortkommando.

- **Minimera:** knappen till höger om greppet (en liten nedåtpil i greppets färg, 16 px från greppet; den tar inte fokus), eller **Minimera** i HUD:ens ⋯-meny. Fönstret får `minimized` (§5) och sparas, appens HUD stängs och appen slutar vara i fokus.
- **Flykten** (720 ms, Anders: "kanske rotera i flera dimensioner?" och "med någon blur"): fönstret krymper till en miniatyr och glider ned i en båge till sin plats i raden. Under tiden vrids det ett helt varv runt den lodräta axeln och, lite senare, ett runt den vågräta, och lutar högst 16° i planet mitt i flykten (`perspective` i fönstrets egna enheter, så att djupet ser likadant ut vid alla zoomnivåer). En rörelseoskärpa på högst 3,2 skärm-px mitt i flykten (`filter: blur`, omräknad till fönstrets enheter) är borta när det landar. Storleken ändras först, så att vridningarna mest sker när miniatyren redan är liten. Tillbaka är samma rörelse baklänges. Med minskad rörelse hoppar fönstret dit.
- **Raden:** i nedre vänstra hörnet, 18 px från vyns kanter, i den ordning apparna minimerades, med nederkanterna i linje och 14 px mellan. Varje miniatyr har fönstrets form, 84 px hög och högst 168 px bred. Ryms raden inte skjuts rutorna ihop lika mycket (högst ned till 24 px mellan vänsterkanterna), så att alla syns. Kommer eller går en ruta glider de andra mjukt till sina nya platser.
- **Miniatyren är appen själv:** fönstret står kvar i `#world` (iframen laddas aldrig om) men flyttas med en egen transform kring sin mitt, och den räknas om i samma bildruta som kameran, så att raden står still på skärmen medan världen panoreras och zoomas. Miniatyren ligger över alla fönster. Inget i den tar emot pekaren (`.wb-mini`), och hela miniatyren är en knapp: ett klick tar fram appen. Kromen visar bara pricken, liten och utan halo, i miniatyrens övre högra hörn, så att det syns om appen bygger eller väntar; under flykten syns ingen krom. Ett märke (§10.5) är där en fylld prick bredvid pricken, eftersom tre tecken inte går att läsa på en 84 px hög ruta i raden.
- **Ta fram:** ett klick på miniatyren, eller **Ta fram** i ⋯-menyn. `minimized` tas bort, fönstret flyger tillbaka till sin plats i världen och läggs överst och i fokus när det landat. Ligger platsen till mindre än hälften i vyn flyger kameran dit samtidigt (som en flygning till fönstret, så att Esc flyger tillbaka).
- Ett minimerat fönster räknas inte som ett fönster på sin plats: inte för ⌘0, smart zoom, kantmarkörerna, täckningen av andra fönsters prick och grepp, eller grinden (§10.3). `World.screenRectOf` och `World.dotOf` ger miniatyrens rektangel och prick, så att en HUD som öppnas för en minimerad app placeras vid miniatyren. Ett fönster som redan är minimerat när det dyker upp (omladdning, en annan flik) står i raden direkt; ett byte av `minimized` från en annan flik startar flykten.
- `World` har `minimize(appId)`, `restore(appId)` och `isMinimized(appId)`.

### 10.8 Sidan Förslag (`web/src/world/ideas.ts`)

- Varje **byggd** app får en sista sida, **Förslag** (id `wb-ideas`, reserverat), som skalet ritar själv utan iframe. En app med en egen sida blir ett kort med Förslag på baksidan; en app med flera får den sist i ringen. Ett manifest som använder id:t `wb-ideas` får det bortfiltrerat.
- **Utseende:** en lista utan rubrik på fönstrets vita ark: varje förslag är en knapp med en liten blå prick framför (15 px, systemets sans-serif), blå ton vid hovring. Medan Claude tänker andas en blå LED mitt på sidan (som i HUD:en, stilla med minskad rörelse); innan förslagen hämtats är sidan tom. Ett fel ger raden "Kunde inte ta fram förslag." och knappen **Försök igen**. Allt sätts med `textContent`.
- **Förslagen hämtas** (`store.ideas`, §8.12) när sidan vrids fram (sidprick, ⌃⌥←/→, titt-klick, ⌥-svep), för appens nuvarande `rev`; de som redan hämtats för samma `rev` visas direkt. En ny version (ny `rev`) hämtar nya när sidan vrids fram igen.
- **Ett klick på ett förslag** vrider fram appens första sida, så att bygget syns, och sänder `hud:send { appId, text }`: HUD:en öppnas (eller blir aktiv) och skickar texten som användarens meddelande, som om den skrivits och skickats med Enter.
- **Ett fel efter turen** (`trouble`, §7.2) står först i listan som ett lokalt förslag, "Rätta felet: <raden>", med en bärnstensfärgad prick i stället för den blå. Det kommer från servern utan någon fråga till Claude och syns i alla lägen, även medan förslagen hämtas och när de inte gick att ta fram (väntan och felraden ligger över sidan men tar inte dess klick). Ett klick gör som för ett förslag men skickar raden citerad som appens feltext, eftersom den är appens egen text och kan bära data som appen hämtat: Rätta felet som appen fick efter bygget: ”<raden>”.
- Sidan Förslag sparas aldrig som fönstrets sida (`win.face` står kvar på appens sida), och apparna får aldrig `face`-meddelandet för den. En app kan inte vrida fram den med `wb.face.show` (den kostar en fråga till Claude), och appen själv kan aldrig starta ett bygge härifrån.
- **Titten** vid kanten och **varvet** efter ett bygge (§10.5) gäller bara appar med flera egna sidor, så att en vanlig app inte lutar sig mot pekaren. Sidprickarna visar Förslag som en sida bland de andra.

### 10.9 Fältet (`web/src/hud/field.ts`, `shared/open.ts`)

Anders 16 oktober: "det borde finnas ett kontext aware inputfält så om jag skriver en webadress så zoomar den inpå webbläsaren och visar sidan. skriver jag in ett datum så går den till kalendern osv. hittar den inget som passar innehållet så föreslår den att den ska bygga något". Hans val: fältet öppnas när man skriver på tom yta.

- **Öppnas** när ingen HUD är öppen och ett tecken skrivs med fokus på skalet (inte i en app, ett annat fält eller under ett drag). Tecknet hamnar i fältet. Mellanslag skriver inget tecken här: det hålls för att tala in (nedan). Med en HUD öppen går tecknen till den aktiva HUD:en som förut (§13). Esc och ett tryck utanför stänger fältet.
- **Utseende:** en glaskapsel i HUD:ens glas, 560 px bred mitt i vyns övre del (22 vh från toppen), med svarstextens typsnitt i 19 px och ingen platshållare. Medan Claude avgör andas en vit LED i kapselns högra ände. Glaset självt tonar in (200 ms), aldrig föräldern (en förälder med opacitet under 1 blir backdrop root, §14). Ett byggförslag är ett glaskort under kapseln: raden "Ingen app passar.", beskrivningen och knapparna **Bygg** och **Avbryt**. Ett fel ger raden "Kunde inte avgöra vart det ska."
- **Enter** gör så här:
  1. Skalet känner igen en **adress** (http/https eller ett värdnamn med toppdomän av bokstäver, inte tal eller mejladresser) eller ett **datum** på svenska eller med siffror (2026-10-20, 20/10, 20 okt, den 20 oktober 2026, idag, i morgon, i övermorgon, igår, fredag, nästa fredag, vecka 43). Anger en byggd app slaget i `opens` (§6) går det dit direkt: appen i fokus om den kan, annars den första.
  2. Annars avgör Claude (§8.13).
  3. **Öppna i en app:** världen flyger till appen (`World.show`: en minimerad app tas fram, första sidan vrids fram, appen blir den i fokus) och lämnar det till appens första sida med `{ type: 'open', item }` när sidan sagt hej (`World.deliver`, efter en ny version till den nya sidan). Anger appen inte slaget går ett önskemål till dess HUD i stället, till exempel "Öppna https://dn.se/ här, och gör så att adresser från Workbench-fältet öppnas direkt nästa gång: lägg till url i opens i app.json och ta emot dem med wb.onOpen. En egen backend-route räcker inte." Önskemålet namnger mekanismen, eftersom den enda riktiga körningen med den kortare texten lade till en egen backend-route och aldrig rörde app.json. Claude vet av reglerna hur och provar det med `try_app` (§8.7, §8.11). När turen är klar och appen nu anger slaget lämnas det fram; annars glöms det.
  4. **Bygg:** `World.createApp` skapar en ny app (som en ritad fyrkant, 720 × 460 px eller mindre) och öppnar dess HUD med `reason: 'created'`, och beskrivningen skickas som första meddelandet. Appen hamnar mitt i vyn om mitten är fri, annars där den inte täcker något fönster, någon öppen HUD eller miniatyr (`fieldRect` i `layout.ts`): bredvid appen i fokus (utan fokus fönstret som täcker mest av mitten, eller det närmast mitten) och sedan bredvid de andra fönstren i vyn, närmast först, med HUD:ens kandidater (§13), i full storlek eller krympt till platsen ned till 320 × 220. Som en ritad fyrkant (§10.4) står den minst 24 px från vyns kanter, så att pricken och greppet syns. En öppen HUD räknas som en remsa till höger om sitt fönster, 360 + 28 px bred som när kameran flyger till appen och högst min(40vh, 320 px) hög, var HUD:en än står. Finns ingen fri plats blir det sidan bredvid appen i fokus som täcker minst, eller mitten om den täcker mindre (alltid mitten utan fönster i vyn). Där får appen aldrig begrava ett fönster, alltså dölja dess prick och samtidigt dess grepp (under appen eller under appens eget grepp): då flyttas den ett trappsteg (32 px) i taget, först upp åt vänster, så att det äldre fönstrets prick uppe till höger och grepp under det syns bredvid appen, och annars ned åt vänster, ned åt höger och upp åt höger. Den första platsen i vyn som inte begraver något och inte täcker mer än mitten vinner, annars mitten om den inte begraver något, annars den första platsen som inte begraver något. Med samma storlek blev mitten eller sidan bredvid appen i fokus annars ofta just ett äldre bygges rektangel: i QA:s körning fick det fjärde bygget i rad exakt det första fönstrets plats, och prickarna och greppen hamnade på varandra. Kameran flyttas inte. (Förut alltid mitten, så att ett andra bygge lade sig exakt över det första.)
- **Tala in** (§12): håll mellanslag när ingen HUD är öppen och fokus ligger på skalet som ovan (upprepningar räknas inte). Fältet öppnas tomt och spelar in. Medan mikrofonen öppnas och inspelningen pågår lyser LED:en stilla, med ett sken som följer ljudnivån som mikrofonens halo i HUD:en; medan talet tolkas andas den som när Claude avgör. Ingen etikett.
  - **Släppet** skickar inspelningen till tal till text. Texten hamnar i fältet och går vidare som om den skrivits och skickats med Enter: en adress till webbläsaren, ett datum till kalendern, annars Claudes val eller ett byggförslag. Ett byggförslag läses då upp (första meningen, högst 200 tecken); inget annat från fältet läses upp, och inte heller ett förslag till skriven text.
  - **I det öppna fältet** talar mellanslaget in igen: i den tomma inmatningen (som i en HUD, §12) och på kortet, där bara Enter trycker på **Bygg** och **Avbryt**. Ett mellanslag som hålls efter ett uppläst förslag bygger alltså aldrig. Fältet står kvar som det var tills det talade kommer och ersätter texten.
  - Ett **kort tryck** (släppt innan inspelningen hunnit börja eller inom 300 ms) och en tyst inspelning ändrar ingenting: ett fält som trycket öppnade stängs igen, och ett som redan var öppet står kvar som det var. Andra fel står som raden i kortet: "Ingen åtkomst till mikrofonen.", "Kunde inte tolka talet." eller "Röstinmatning stöds inte här.", och fokus står i fältet, så att man kan skriva i stället eller hålla mellanslag igen.
  - **Ett tappat släpp lämnar aldrig mikrofonen på:** hanteraren (`hud.ts`) lyssnar på `keyup` på dokumentet (capture), fönstrets `blur` och dokumentets `visibilitychange`. Tappar fönstret fokus (en app eller webbläsarens fråga om mikrofonen tar det, en annan flik) slutar inspelningen som vid ett släpp. Släpps tangenten, eller tappar fönstret fokus, innan mikrofonen hunnit öppnas börjar ingen inspelning. Tills mellanslaget släppts skriver eller trycker dess upprepningar ingenting, inte heller i ett kort eller en HUD som fått fokus under tiden (§12).
  - Esc, ett tryck utanför och en HUD som öppnas (även av automatiken, §13) stänger fältet och avbryter inspelningen, och ingenting skickas. Stängs fältet när ingen HUD är öppen släpps mikrofonen, även en som webbläsaren ger först efteråt.
- `World` har `show(appId)`, `deliver(appId, item)` (false när appen inte anger slaget) och `createApp()`.
- **Fokusskyddet** (`web/src/hud/focusguard.ts`): går fokus från fältets eller den aktiva HUD:ens inmatning till en app-iframe utan att användaren klickat i appen (bryggans `focus`, `app:focus`, inom 500 ms före eller efter) tas det tillbaka efter 160 ms. Uppmätt mot en kopia av Anders webbläsare: dn.se:s kakdialog i den tog fokus inom en halv sekund efter att sidan laddats, och Esc och tecknen hamnade i appen; med skyddet stod fokus kvar i fältet. Ett klick i en app (bryggans `focus`) stänger fältet, eftersom skalet inte ser pekaren i en iframe.

## 11. Appbryggan (sdk/wb.js ↔ web/src/bridge.ts)

`sdk/wb.js` är ett vanligt skript (ingen modul) som körs först i varje app-sida. **CSS-variablerna, `window.wb` och loggningen fungerar alltid.** Bara delarna som pratar med föräldern hoppar över när `window.parent === window` (skärmbilder, egen flik).

- **Föräldern** är alltid `http://localhost:<samma port>` (§4). Bryggan skickar bara dit och tar bara emot meddelanden därifrån.
- **CSS-variabler** sätts på `:root` innan sidan ritas: `--wb-accent: #2f6bff`, `--wb-radius: 12px`, `--wb-font: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", sans-serif`.
- **Hjul:** en lyssnare med capture och `{ passive: false }` på `window`. Beslutet fattas på **varje** händelse.
  - ctrl → `preventDefault`, sedan `wheel/zoom` med `alt` och `smart`.
  - ⌘ → `preventDefault`, sedan `wheel/pan`.
  - ⌥ → `preventDefault`, sedan `wheel/alt`.
  - Vanligt hjul: kan något under markören scrolla åt det hållet får appen scrolla. Annars `preventDefault`, sedan `wheel/pan`.
  - Punkten skickas med den senaste `pointermove`-positionen (fraktionell) när den ligger inom 1 px från hjulets.
- **Tangenter:**
  - ⌘K, ⌘0 och ⌃⌥←/→ tas i capture-fasen med `preventDefault` och `stopImmediatePropagation`, och skickas som `key`. Matchningen sker på `e.code`.
  - Esc skickas i bubbelfasen och bara om appen inte själv anropat `preventDefault`. Den skickas inte heller medan appen har en modal `<dialog>` eller en popover öppen, eftersom webbläsaren då stänger den.
  - Upprepningar (`e.repeat`) tas om hand men skickas aldrig vidare. Världen ignorerar `e.repeat` för samma tangenter.
- **Hjul som appen vill ha själv:** har `<html>` attributet `data-wb-wheel="app"` (kartor, ritytor) skickas vanliga hjul aldrig vidare, och appen hanterar dem själv. Modifierade hjul (ctrl, ⌘, ⌥) går till skalet som vanligt.
- **`wb.ready`** blir klart även om `/__wb/app.json` inte går att hämta. Då används `DEFAULT_FACES` och en varning loggas.
- **Övriga meddelanden:**
  - `pointerdown` → `focus`
  - `load` → `hello { face, w, h }`
  - `wb.badge(text)` → `badge { text }` (§10.5)
- **Loggar:** `console.error` och `console.warn`, `window.onerror` och `unhandledrejection` buntas och skickas till `POST /__wb/log` var 500 ms, högst 50 poster per bunt, med sidans version (`x-wb-rev` från `/__wb/app.json`, §7.2) när den är känd. Det sker alltid, även på toppnivå.
- **API:et `window.wb`:**
  - `wb.ready: Promise<void>` blir klart när `/__wb/app.json` är hämtat, och i en iframe dessutom när första `face`-meddelandet kommit eller efter högst 1 s.
  - `wb.app` = `{ id, name, faces }`.
  - `wb.face`:
    - `current` (id). På toppnivå härleds det från `location.pathname` mot `faces`.
    - `show(id)` skickar `{ type: 'face', show: id }`. På toppnivå gör den ingenting, utom i en `try_app`-körning (`window.__wbTry`), där den byter sida med `location.assign` (§8.8).
    - `onChange(fn)` returnerar en avregistreringsfunktion.
  - `wb.onOpen(fn)` (§10.9) tar emot det skalet lämnar från fältet: `{ kind: 'url', url }` (http/https), `{ kind: 'date', date: 'ÅÅÅÅ-MM-DD' }` eller `{ kind: 'text', text }` (högst 2000 tecken), som frysta objekt. Meddelandet `{ type: 'open', item }` kontrolleras igen i sidan, och det som kommer innan appen anropat `wb.onOpen` sparas (högst 10) och lämnas vid första anropet. Returnerar en avregistreringsfunktion.
  - `wb.store`:
    - `get(key)` skickar `x-wb-optional: 1` och ger värdet eller `undefined` (204 och 404)
    - `set(key, value)`
    - `delete(key)`
    - `all()`
    - `onChange(fn)` anropas i appens andra sidor och fönster med `{ key }` när en `set` eller `delete` har gått igenom på servern, så att `get(key)` där ger det nya värdet. Returnerar en avregistreringsfunktion.

    En ogiltig nyckel kastar ett tydligt fel. En sida läser det den behöver när den laddas: `onChange` gäller bara senare ändringar, eftersom kanalen inte har någon historik (Kalendern fick en rättningsrunda för en sida som laddades efter ändringen). Backendens skrivningar i `store.json` utlöser den inte.
  - `wb.faces.post(msg)` skickar ett meddelande (allt som går att klona strukturerat) till appens andra sidor och fönster, och `wb.faces.onMessage(fn)` tar emot dem och returnerar en avregistreringsfunktion. Kanalen är en `BroadcastChannel` per app (`wb:<id>`), som `onChange` också går över. Den når aldrig avsändaren själv, och inte en annan app.
  - `wb.badge(text)` sätter appens märke bredvid pricken (§10.5): en sträng eller ett ändligt tal; `null` eller inget argument tar bort det. Annat kastar ett `TypeError`. På toppnivå gör den ingenting.
- **`web/src/bridge.ts`** exporterar `createParentBridge(opts)` (`web/src/types.ts`).
  - Ett meddelande godtas bara om `opts.resolve(e.source)` hittar ett fönster **och** `e.origin === opts.appOrigin(fönstret.appId)`.
  - Bara den fasta vokabulären godtas. Alla tal kläms. Märkets `text` är en sträng eller `null`: kontroll- och formattecken tas bort (Unicode Cc och Cf, bland dem riktningstecknen, också U+061C, och tecken med noll bredd som U+200B och U+2060), blanktecken slås ihop och trimmas, och högst 3 kodpunkter behålls (`Array.from`); en tom text blir `null`, så att osynliga tecken aldrig ger en tom kapsel.
  - Hastighetsbegränsning: 400 meddelanden/s per fönster.

## 12. Röst

- **Tal till text:**
  - Klienten håller mikrofonknappen, mellanslag i en tom inmatning, eller mellanslag på skalet när ingen HUD är öppen (fältet, §10.9), och spelar in med MediaRecorder (`audio/webm;codecs=opus`, 32 kbps). Den kastar inspelningar under 300 ms och tysta inspelningar (färre än 10 % av 20 ms-blocken över 4× brusgolvet). Brusgolvet är 10:e percentilen av RMS för de 20 ms-block som inte är digital tystnad (> 1e-6), aldrig under 2e-4 (−74 dBFS), räknat på den avkodade inspelningen.
  - Ljudet postas med `store.transcribe(blob)` till `POST /api/stt`. Servern provar `WORKBENCH_STT`-ordningen:
    1. **whisper:** `ffmpeg -i pipe:0 -ar 16000 -ac 1 -f wav pipe:1` (execFile, `childEnv()`) → `POST {WHISPER_URL}/inference`, multipart: `file` (`speech.wav`), `response_format=json`, `temperature=0`, `language=sv`, och `prompt` med "Workbench, HUD, mejlklient, kub, prisma" och appnamnen. Timeout 8 s.
    2. **openai:** `gpt-transcribe`, där filen heter `speech.webm` eller `speech.mp4`, med `languages[]=sv` och samma `prompt`. Timeout 20 s.

    Texten trimmas. Tom text räknas som misslyckad. Fungerar ingen metod blir svaret 503.
  - Bara den aktiva HUD:en, eller fältet när ingen HUD är öppen, spelar in, och bara en inspelning åt gången: medan en inspelning pågår, kontrolleras eller tolkas börjar ingen ny i en annan HUD. Att hålla mikrofonen i en HUD som inte är aktiv gör den aktiv. Resultatet (texten, eller raden om ett fel) går till appen vars HUD spelade in, även om en annan HUD blivit aktiv under tiden. Stängs den HUD:en avbryts inspelningen och ingenting skickas. Mikrofonen släpps när den sista HUD:en stängs. Fältets resultat går till fältet, en HUD som öppnas avbryter fältets inspelning, och mikrofonen släpps när fältet stängs utan öppen HUD (§10.9).
  - Ett mellanslag som startat en inspelning, i en HUD (tom inmatning, skalet eller mikrofonknappen) eller i fältet, skriver och trycker ingenting förrän det släppts, inte heller på ett frågekort som tagit fokus under tiden: ett hållet mellanslag godkänner aldrig något. Släppet stoppar inspelningen var fokus än står.
  - En HUD:s text skickas direkt med `via: 'voice'` och syns som användarens meddelande. Fältets text går vidare i fältet (§10.9).
- **Text till tal:** bara när användarens senaste meddelande till appen kom med röst, oavsett om appens HUD är öppen eller aktiv, och när fältet visar ett byggförslag till talad text (§10.9). Claudes avslutande text, eller förslaget, läses upp (första meningen, högst 200 tecken) med den bästa svenska rösten (Tilde/Axel premium före Alva). Claudes text läses när röstmeddelandets egen tur slutar: ett meddelande som skickas under §8.6 eller efter Stopp blir en egen tur, och turen före det läses inte upp. Vilket svar som hör till vilket meddelande avgörs som i HUD:en (`spokenReply` i `model.ts`). Medan en HUD eller fältet spelar in läses inget upp, eftersom mikrofonen annars hör uppläsningen. Uppläsningen avbryts när användaren börjar prata.

## 13. HUD:arna (web/src/hud)

Anders 16 oktober: "flera chattar borde kunna vara öppna samtidigt".

- **Flera samtidigt.** Varje app har högst en HUD, och flera appar kan ha sin HUD öppen samtidigt. Att öppna en HUD (med pricken, med ⌘K, genom att rita en ny app eller genom automatiken) stänger aldrig någon annan. `hud.ts` är hanteraren. Den har en panel (`panel.ts`) per öppen HUD, som skapas när HUD:en öppnas och kastas när den stängs. Hanteraren äger också det som delas: vem som är aktiv och Esc-ordningen (`stack.ts`), Esc-hanteraren, rösten, utkasten och lagringen.
- **Öppnas bara** via `hud:open` och via egen automatik. Är appens HUD redan öppen blir den bara aktiv.
  - **Automatik:** HUD:arna håller föregående status per app. Vid övergången till `waiting` öppnas appens HUD om den inte redan är öppen. Vid en snapshot gäller det appar som redan väntar vid sidans första snapshot och appar som börjat vänta sedan förra snapshoten, så att ett avbrott i nätet inte öppnar HUD:ar som användaren stängt. Är en annan HUD öppen blir den nya inte aktiv och tar inte fokus. Den läggs näst sist i Esc-ordningen och blir därför aktiv när den aktiva stängs. Är ingen annan öppen blir den aktiv och inmatningen får fokus.
  - När en HUD öppnas läses historiken in (`store.loadHistory`). `chat.open` skickas när en HUD öppnas och varje gång den blir aktiv. Efter en omladdning och vid `connection: true` skickas `chat.open`, och historiken läses in igen, i den ordning HUD:arna senast var aktiva, med den aktiva sist. Då stänger taket (§8.1) processen bakom den aktiva HUD:en sist.
- **Den aktiva.** Precis en av de öppna är aktiv: den som användaren senast öppnade, klickade i eller flyttade fokus till. Den aktiva ligger överst, och de andra staplas i den ordning de senast var aktiva. Fokus i en HUD gör den aktiv, så tangentbordsfokus ligger aldrig i en HUD som inte är aktiv. Ett klick på en knapp som inte tar fokus (mikrofonen, ⋯, stopp) i en HUD som inte är aktiv flyttar fokus från den förra HUD:en till den här HUD:ens inmatning. En ny HUD är lugn (§14) tills den blir aktiv, och de andra är lugnare, utan nya etiketter. När pekaren eller tangentbordsfokus går in i en HUD vars app inte är den i fokus anropar HUD:en `world.focus(appId)`, så att ⌘K och ⌃⌥←/→ gäller den HUD man skriver i. Ett byte av aktiv HUD där fokus inte hamnar i den (automatiken, en stängning) anropar aldrig `world.focus`. ⋯-menyn i en HUD som slutar vara aktiv stängs.
- **Esc-ordningen.** Medan minst en HUD är öppen har HUD:arna en enda `pushEscape`-hanterare. Den läggs överst när användaren öppnar en HUD eller gör en annan aktiv, och den stänger den aktiva. Av de kvarvarande blir den som senast var aktiv den nya aktiva.
- **Stängs.** Esc och ett tryck på tom yta stänger bara den aktiva HUD:en. Pricken och ⌘K stänger appens egen HUD, aktiv eller inte (`hud:close`), och `app.removed` stänger appens HUD. HUD:en sjunker in i pricken och `chat.close` skickas för appen. Låg fokus i den stängda HUD:en, på skalet eller på en knapp i `#chrome` (pricken), får den nya aktiva HUD:ens inmatning fokus, aldrig ett frågekort. Pricken tar inte fokus vid klick, så när den stänger en HUD som inte är aktiv står fokus kvar i den aktiva HUD:ens inmatning.
- **`hud:state`** sänds efter varje öppning, stängning och byte av aktiv: `{ open, active }`. `open` är apparna med öppen HUD, i den ordning de öppnades, och `active` är den aktiva, eller null när ingen är öppen.
- **Över en omladdning** (⌘R, eller Vites omladdning efter en omstart i dev): HUD:arna sparar i `sessionStorage` (`wb.hud`) vilka appar som har sin HUD öppen, i den ordning de öppnades. För var och en sparas hur den öppnades, om något skickats sedan dess och vilken sida den står på. Där sparas också vilken som är aktiv, Esc-ordningen och utkasten per app. Vid första snapshoten efter omladdningen öppnas HUD:arna igen i samma ordning för de appar som finns kvar: på samma sida så länge den är giltig, med utkasten i inmatningarna och med samma Esc-ordning. Sedan sänds `hud:state`. Den aktiva blir aktiv igen och får fokus. Finns den inte kvar blir den aktiv som var aktiv närmast före den (Esc-ordningen). Ett sparat värde i den äldre formen, med en enda app, läses som en öppen HUD. Högst 16 HUD:ar läses. Utkast för appar som försvunnit kastas. Utan lagring fungerar HUD:arna som förut.
- **Oanvända appar tas bort bara med Esc.** När HUD:en stängs med Esc och alla dessa gäller:
  - den öppnades med `reason: 'created'`
  - inget `chat.send` har skickats för appen sedan dess
  - appen är inte byggd
  - inmatningen är tom (en halvskriven beskrivning är användarens arbete: då stänger Esc bara HUD:en, och fyrkanten och utkastet finns kvar)

  Då anropar HUD:en `world.dissolve(appId)` och sedan `store.deleteApp(appId)`. Ett tryck på tom yta, pricken och ⌘K behåller den ritade fyrkanten, och HUD:en sjunker bara in i pricken (båda domarna).
- **Varje HUD följer sitt fönster** i skärmkoordinater (`world.screenRectOf` vid varje `view:changed`), även under kamerans animationer.
  - **Linjen** (Anders 16 oktober: "det borde dras ett blått streck mellan hud och tillhörande app så att det är glasklart vilken app en hud hör till"): den kortaste raka linjen mellan appens fönster (`world.screenRectOf`) och panelen, kant mot kant, med hänsyn till båda hörnradierna (`tetherBetween` i `tether.ts`), ritad i samma bildruta som panelen flyttas. Överlappar fönstret och panelen i en led står linjen vinkelrätt över mellanrummet, 36 px in på överlappet (eller mitt på ett kortare). Den korsar aldrig fönstret eller panelen; först gick den från pricken, och en HUD under fönstret fick då en diagonal tvärs över appen (syntes i demofilmen). Ingen linje när de överlappar eller ligger närmare än 6 px. Utseendet står i §14.
  - Bredd 360 px, maxhöjd `min(40vh, 320px)`; längre historik skrollar i panelen (Anders 16 oktober: "lång historik borde väl lösas med overflow scroll inte ett större och större fönster"). Förut `min(70vh, 560px)`, som gav HUD:ar som täckte andra appar och varandra.
  - **Placering:** HUD:arna placeras i den ordning de öppnades, så att en ny HUD aldrig flyttar en äldre. Varje HUD undviker andra fönster och målen (sida och sluthöjd) för HUD:ar som öppnades före den. Kandidaterna prövas i ordningen höger, vänster, under, över. Mellanrummet är 14 px (28 px under fönstret, där greppet sitter 10–15 px under kanten), och toppen eller vänsterkanten står i linje med fönstret, klämd i vyn.
    1. Den första kandidaten som varken överlappar något **annat** fönsters skärmrektangel eller någon HUD som öppnades före den här väljs.
    2. Överlappar alla väljs den med minst överlapp. Överlapp med en HUD väger dubbelt mot överlapp med ett fönster, och vid lika (inom 1 px²) står HUD:en kvar på sin sida. Ryms inte alla HUD:ar får de överlappa varandra, och den aktiva ligger överst. En HUD kan då täcka en annan apps prick tills den stängs eller flyttas.
    3. Täcker alla kandidater det egna fönstret läggs HUD:en ovanpå fönstrets nedre högra hörn, 14 px från fönstrets högra kant och nederkant och klämd i vyn, så att appens knappar uppe till höger syns. Med botten fast växer den uppåt.
    4. Utan fönster dockar den nere till höger i vyn.
  - Platsen väljs om vid `view:changed` när den nuvarande börjar täcka det egna fönstret, eller täcks mer än 6 px åt båda hållen av en HUD som öppnades före den här. Medan kameran eller fönstren rör sig, och 150 ms efter senaste `view:changed`, prövas inte äldre HUD:ar: fönstren skalar men HUD:arna gör det inte, så överlappen kommer och går för varje bildruta. Ett annat fönster som flyttas dit ger inget nytt val. Bytet animeras på 220 ms. Ändras en HUD:s mål placeras HUD:arna som öppnades efter den om, samlat till en gång per bildruta.
- **Skriv var som helst:** när någon HUD är öppen, inget drag pågår och fokus inte ligger i en app eller ett annat fält, hamnar tryckta tecken i den aktiva HUD:ens inmatning. Är ingen HUD öppen öppnar tecknet fältet, och ett mellanslag som hålls talar in i det (§10.9).
- **Innehåll uppifrån och ner** (i varje HUD, för dess app):
  1. Meddelanden: användarens text, Claudes text (enkel markdown: stycken, **fet**, `kod`, listor) och `note`.
     - **En text per tur.** Varje tur har en enda plats för Claudes text. Text som skrivs mellan verktygen ersätts av nästa text (även medan nästa strömmar in), och turens sista text är svaret som står kvar. Samma regel gäller när historiken läses in igen.
     - **Köade meddelanden** står under turens text. Turens levande text och dess nästa text (svaret, som ersätter den levande texten på samma plats) står ovanför, och texten efter det hör till det köade meddelandets tur. Ett meddelande som besvarar ett väntande frågekort (inte en hemlighet) köas inte.
     - **Meddelanden som aldrig kördes:** användarens rad är dämpad när en `note` pekar ut den med `dropped` (stoppad i kön, eller skickad under en omstart, §8.1). Noten under den säger varför.
     - **Noterna efter turslutet** (§8.6: Avbröts, en commit som misslyckades) hör till turen som slutade. De står under turens innehåll och ovanför köade rader vars tur inte har börjat (ingen text, inget verktyg och inget frågekort efter dem, som för ett meddelande som skickades under §8.6 eller efter Stopp), inte under dem. En not med `dropped` står under sin rad, och en not som kommer efter ett nytt meddelande eller en ny tur står sist, i tidsordning.
     - **Listan följer botten.** Bara användarens egen scroll (hjul, touch, pekare eller tangent inom 600 ms) släpper botten, och den fastnar igen när användaren är tillbaka nere. Programmatiska scrollningar släpper den aldrig.
  2. Frågekort (nedan).
  3. Bara när status är `building`: **en** levande aktivitetsrad. Den börjar med en liten LED-prick som andas så länge Claude arbetar, och efter pricken står senaste `tool.label`. Innan första verktyget, medan Claude tänker, står bara pricken där. Raden har samma höjd med och utan etikett, så att inget hoppar när första etiketten kommer. Medan ett frågekort väntar (`waiting`) syns ingen rad, eftersom kortet redan säger vad som händer. Medan raden syns andas också panelens innerkant (kantljuset, §14). När turen är slut tonar raden och kantljuset ut på 160 ms. Raden lämnar flödet direkt men står kvar på sin plats medan den tonar, så att panelen krymper en gång, samtidigt som golvet släpps. När ett frågekort tar radens plats tonar kantljuset ut på samma sätt. Stängs HUD:en mitt i en tur slutar pricken och kantljuset andas direkt, och ingen animation lämnas kvar på den dolda panelen. De börjar igen, i fas med varandra, när HUD:en öppnas för appen medan den bygger, även efter en omladdning. I en HUD som inte är aktiv står pricken still, svepet syns inte och kantljuset andas inte (§14). När HUD:en blir aktiv medan appen bygger andas pricken och kantljuset igen, i samma fas som förut, och svepet fortsätter i sin fas.
  4. Inmatningen: växande textruta, högst 6 rader. Enter skickar (köas om en tur pågår), ⇧Enter ger ny rad. Ingen skicka-knapp. Medan status är `building` eller `waiting` och panelens topp står fast (höger, vänster, under) växer panelen i steg om 96 px, så att inmatningen och stoppknappen står still medan texten strömmar in, men aldrig mer än det finns plats för mellan toppen (räknad från fönstret) och vyns nederkant, så att panelen inte kläms uppåt över greppet eller byter sida mitt i turen.
  5. Mikrofon (håll). Bara den aktiva HUD:en spelar in (§12).
  6. Stoppknapp bredvid mikrofonen, bara när status är `building` eller `waiting`. Stoppet gäller hela kedjan, även köade meddelanden, och varje meddelande som inte körs får en `note` (§8.1).
- **Markdown** byggs med `createElement` och `textContent`, aldrig `innerHTML`. Inga länkar eller bilder.
- **Tidigare turer** visas som Claudes text och användarens meddelanden. Verktygshistorik visas inte.
- **Frågekort** visas bara när status är `waiting` och frågan saknar `ask-done`:
  - `permission`: titel + detalj (monospace) + knapparna **Tillåt**, **Alltid** (bara om `canRemember`) och **Neka**. Med `defaultNo` har **Neka** fokus och Enter godkänner aldrig.
  - `question`: frågan + ett alternativ per knapp. En enda fråga med ett val svarar direkt vid klick; flera frågor eller flera val ger en bocklista + **Klar**. Det finns ingen knapp för att avböja.
  - `secret`: etiketten + ett lösenordsfält + **Spara**/**Avbryt**. Värdet skickas i `chat.answer.secret` och töms direkt ur DOM:en.
  - Kortet tonar bort vid `ask-done`. Låg fokus i kortet när det besvarades (knapparna stängs av och det hemliga fältet tas bort, så fokus faller till body), får inmatningen fokus när kortet går, om HUD:en är aktiv.
  - Skriver användaren i inmatningen medan ett kort väntar besvarar texten kortet (§8.5 punkt 6: tillstånd blir nej med användarens ord, en fråga får texten som fritt svar). En hemlighet får aldrig skriven text.
  - Ett kort i en HUD som inte är aktiv tar aldrig fokus, och en HUD som blir aktiv ger fokus till inmatningen, aldrig till ett kort.
- **Behörigheter:** har appen `permissions` som inte finns i `grantsFor(appId)`, visas ett kort: "<namn> vill använda mikrofonen" (kameran, urklippet, platsen) med **Tillåt**/**Neka**. Tillåt → `setGrants` → `bus.emit('grants:changed')`. Neka sparas också, per webbläsare i `localStorage` (`wb:hud:denied`, bredvid `wb:grants`), så att frågan inte kommer tillbaka.
- **Meny** (diskret `⋯`):
  - **Ångra senaste ändringen**: `store.undo`. Bara när ingen tur pågår. Inget att ångra ger en kort `note` lokalt.
  - **Gör om**: `store.redo`. Bara när ingen tur pågår och `store.canRedo(appId)`: det senaste svaret på ångra eller gör om gav `canRedo` (§7.4), och bara till nästa tur, eftersom skalet glömmer det vid appens nästa `turn`-händelse. Kommer en sådan medan frågan är ute sätter svaret inget Gör om, eftersom servern räknade ut `canRedo` före turens commit. Ingen avstängd rad när inget finns att göra om. Servern sänder en `note` som vid ångra ("Gjorde om ändringen."), och ett 409 ger en kort `note` lokalt.
  - **Öppna i egen flik**: appens origin.
  - **Visa loggen**: appens senaste loggrader som text i en egen flik (`GET /api/apps/:id/logs`, §7.1), som Claude ser dem med `get_app_logs`. En egen flik i stället för ett block i HUD:en: loggrader är långa och många, och fliken ger sökning, kopiering och skrollning utan nya element i panelen. Finns alltid.
  - **Minimera** (eller **Ta fram** när appen är minimerad, §10.7). Bara när appen har ett fönster.
  - **Ta bort appen**: bekräftas i menyn med **Ta bort**/**Avbryt**, sedan `world.dissolve` och `store.deleteApp`.
- **Tillstånd som visas bara när de gäller:**
  - frånkopplad: en rad "Ingen kontakt med servern", bara i den aktiva HUD:en
  - `limits`: "Du har använt 80 % av din Claude-kvot", bara i den aktiva HUD:en
  - ett turfel: felet i dämpad röd text, i appens egen HUD
- **Skärmläsaren:** en gemensam live-region. Svar läses bara från den aktiva HUD:en; frågekort och fel från alla.

## 14. Utseende

Tokens finns i `web/src/styles/tokens.css` (FRUSET). Utseendet är sammansmält ur tre prototyper som två domare bedömt: Glas för ytan, LED-pricken och fjädrarna, Bläck för den djupblå, läsbara HUD:en och typografin, Ritning för snäppet till en exakt rektangel. Prototyperna följer inte med repot. Det som togs från dem står nedan, och fjädrarna är uträknade i `tokens.css`.

- **Ytan:** en WebGL-shader ritar ett gaussiskt ljusfall från `--wb-canvas-center` (mitt, 50 %/36 %) till `--wb-canvas-edge`, med ungefär 0,75 LSB dither.
  - Prickgrid i världen: 24 enheter mellan prickarna, prickar ungefär 0,95 px, mörkare med 8,5 %. Gridden fördubblas mjukt när avståndet blir under 12 skärm-px.
  - Inget annat syns på en tom yta.
  - Utan WebGL används en radiell CSS-gradient som reserv.
- **Fönster:** vita ark med `--wb-win-radius` (världsenheter) och `--wb-win-shadow`. Medan fönstret dras används `--wb-win-shadow-lift`.
- **Fröyta** (ritad, inte byggd): `--wb-seed-bg` med svaga konstruktionslinjer i `--wb-seed-line`.
  - Medan Claude bygger tecknas linjerna in, en grupp per `tool`-händelse: rubrikrad, rader, en kolumn.
  - Ett svagt ljusband sveper över var 1,9 s. Utan bygge, eller utanför vyn, finns inget svep; när bygget är slut sveper det vidare tills bandet tonat ut (0,5 s).
  - Ingen text.
- **Ombyggnad av en byggd app:** appen står orörd och bara pricken pulserar snabbt. När `rev` ändras tonas den nya versionen in (§10.5).
- **Ritande:** strecket är `--wb-ink`, 2 px med mjuk glöd. Spökrektangeln är streckad i `--wb-ghost-stroke` med `--wb-ghost-fill`. Inga mått, inga etiketter.
- **Materialisering** (från släpp till skrivbar HUD under 600 ms):
  1. 0 ms: strecket snäpper till den exakta rundade rektangeln (270 ms, `--wb-ease-snap`). Slingor projiceras radiellt på omkretsen, raka drag vecklas ut medurs, och exakta hörn sätts in.
  2. 120 ms: arket läggs ned. Opacitet 0→1 på 240 ms, skala 1,012→1 med `--wb-spring-soft`, skuggan växer på 600 ms och strecket tonar bort på 300 ms.
  3. 200 ms: pricken tänds (`--wb-spring-pop`) och greppet växer fram.
  4. 220 ms: HUD:en glider ut under fönstrets kant, klippt i skärmkoordinater vid kanten, med `--wb-spring-soft`.

  Den nya HUD:ens inmatning får fokus när den öppnas, och tangenttryck från släppet och framåt hamnar där (världen samlar dem som kommer före `hud:open`, §10.4). Andra öppna HUD:ar står kvar, och tangenttryck medan man ritar hamnar aldrig i dem. Inga andra effekter (glöd, skimmer, krusning) läggs på utöver detta.
- **Pricken (LED):** kärnan är `--wb-dot-size` med `--wb-dot-core` och `--wb-dot-glow`, placerad på 45°-punkten av fönstrets övre högra hörnbåge. Halon `--wb-dot-halo` andas (`--wb-dot-breath`, skala 0,62→1,06, opacitet 0,55→1).

  | Läge | Prick |
  |---|---|
  | building | samma animation med `playbackRate` 3,3, så att fasen inte hoppar |
  | waiting | blinkar en gång per sekund |
  | error, backend `crashed` eller `trouble` (§7.2) | kärnan i `--wb-amber` |
  | översikt (fönstrets skärmbredd under 320 px) | krymper till 0,6 och halon försvinner |

  **Märket** (§10.5): en kapsel, 16 px hög, minst 16 och högst 44 px bred (tre tecken ryms: "WWW" är 40,6 px och tre emoji 43,5 px i Chrome; ett ovanligt brett tecken klipps), 3 px till höger om kärnan och centrerad på den, med vit text (10,5 px, vikt 600) på `--wb-accent` mörkad 12 % (rgb(41, 94, 224) uppmätt i Chrome, kontrast 5,6:1 mot 4,5:1 för `--wb-accent` själv) och en vit hårlinje runt om, så att den syns mot både yta och fönster. Den krymper inte med pricken i översikten. På miniatyren är den en fylld prick, 7 px, i samma färg.
- **Greppet:** en pill på `--wb-grip-w × --wb-grip-h`, 10 px under fönstrets nederkant, `--wb-grip-hover` vid hovring. Sidprickarna (5 px) sitter till vänster om greppet.
  - **Nära pekaren:** när skalet ser pekaren inom 96 px från fönstret (samma mått som grinden, §10.3) får kromen `wb-near`. Greppet, minimeringens pil och borttagningens kryss går då från `--wb-grip` (uppmätt i Chrome 1,5–1,7:1 mot ytan i fönstrets skugga, där de sitter) till `--wb-grip-near` (2,6–2,8:1), och sidprickarna från `--wb-face-dot` (1,7:1) till `--wb-face-dot-near` (2,1:1). Sidprickarna stannar ljusare än greppet, så att den främre sidans prick (`--wb-face-dot-on`, 4,4:1) skiljer sig från de andra med 2,1:1 även nära (2,7:1 i vila; med `--wb-grip-near` på sidprickarna bara 1,6:1). `--wb-grip-hover` och `--wb-face-dot-on` är mörkare än `--wb-grip-near` (alfa 0,85), så att hovringen syns. Knapparna och sidprickarna har sina namn som verktygstips (`title`): Minimera, Ta bort appen och sidans namn. Medan krysset frågar visar det ordet Ta bort, och verktygstipset står kvar.
- **HUD:en:** `--wb-hud-w`, `--wb-hud-radius`, bakgrund `--wb-hud-bg` med `backdrop-filter: var(--wb-hud-blur)`, kant `--wb-hud-edge` och skugga `--wb-hud-shadow`.
  - **Glaset** (Anders önskan 16 oktober: "mer som genomskinligt glas"): det som ligger bakom syns igenom. Bakgrunden suddas och mörkas i filtret och färgas sedan av en tunn blå ton i stället för en ogenomskinlig fyllning. Ungefär 25 % av ljuset bakom går igenom, mot 4 % förut.
    - `--wb-hud-blur` är `blur(28px) saturate(2) brightness(0.45)`. 28 px suddar bort apptext men låter former, färger och fönsterkanter synas.
    - `--wb-hud-bg` är tonen `linear-gradient(170deg, rgba(14, 64, 236, 0.46) 0%, rgba(10, 46, 200, 0.5) 100%)`.
    - Kanten har en skarp ljuslinje överst, en hårlinje och ett svagt inre ljus. Skuggan har en hårlinje på 0,5 px utanför panelen.
    - Glaset ser bara sidan bakom om ingen förälder är backdrop root (`clip-path`, `filter`, `opacity` under 1, `mask`, `mix-blend-mode`). Utglidningen klipps därför med `clip: rect()` på `.wbh`, inte med `clip-path`. Med `clip-path` var HUD:en klar och ljus under hela utglidningen och frostades först när klippet släpptes, ungefär en sekund vid varje öppning (uppmätt: luminans 119 under utglidningen mot 70 i vila; med `clip: rect()` 70 hela tiden).
    - Kontrasten bärs av `brightness()`, inte av fyllningen: samma ton utan `brightness()` ger 2,3:1 för Claudes svar över en vit app. Chrome räknar `brightness()` på de gammakodade sRGB-värdena (uppmätt).
    - `hud-contrast.test.ts` modellerar varje term i `--wb-hud-blur` som ändrar färgen, kalibreras mot pixlar uppmätta i Chrome, och fälls av två planterade läckor: den första, ljusare gradienten (`rgba(36, 86, 240, 0.96)` → `rgba(26, 63, 208, 0.97)`) och dagens ton utan `brightness()`.
    - Valet: tre varianter (klart blått glas, rökglas och frostat blått glas) mättes i riktig Chrome över grå yta, vit, mörk och färgstark app, och två domare rangordnade dem. Det blev oavgjort mellan klart och frostat; vid lika gäller läsbarheten, och det frostade klarade det strängaste fallet utan ändringar.
  - **Användarens rader:** `--wb-font` i `--wb-text-ui` (14,5 px, vikt 400) med `--wb-hud-user` (82 % vitt), utan bubbla.
  - **Claudes svar:** `--wb-font-reply` i `--wb-text-reply` (16,5 px). Typsnittet är systemets sans-serif (SF Pro), vikt 450, radhöjd 1,4 och spärrning −0,013em, med `text-wrap: pretty`. Ingen serif används någonstans i HUD:en (Anders: "serifftypsnitt känns inte tillräckligt modernt"). Ett första svar glider in (opacitet från 0, 420 ms). Ett svar som ersätter text som just syntes tonar från opacitet 0,5 till 1 på 240 ms, utan förflyttning.
  - **Aktivitetsraden:** `--wb-font-mono` i `--wb-text-mono` med `--wb-hud-muted`. En ny rad glider upp och ersätter den gamla. Första etiketten glider upp efter pricken. Stilarna ligger i `web/src/hud/activity.css`.
    - **Pricken:** en LED i samma formspråk som appens prick. Kärnan är 7 px med `--wb-dot-core` och `--wb-dot-glow`, vertikalt centrerad på texten, och texten börjar 16 px in. Halon är 26 px, i vitt blandat med `--wb-accent`, eftersom blått inte syns på det blå glaset. Den andas med världens nyckelbilder (skala 0,62→1,06, opacitet 0,55→1, `--wb-dot-breath`) och `playbackRate` 3,3, så perioden blir densamma som för appens prick under building (cirka 0,97 s), men inte nödvändigtvis fasen. Andningen går på dokumentets tidslinje från 0 (`startTime` 0), liksom kantljuset.
    - **Svepet:** ett svagt ljus vandrar över etiketten var 1,9 s, med samma kurva som fröytans ljusband. Ljuset är en vit kopia av etiketten i ett mjukt maskat fönster; fönstret och kopian flyttas lika långt åt var sitt håll med transform, så att texten står still. Ljuset gör texten ljusare, aldrig mörkare än `--wb-hud-muted`, och har samma fas på varje rad, även när en HUD som inte var aktiv blir aktiv och svepet syns igen, så att det inte börjar om när etiketten byts.
  - **Kantljuset** (Anders: "något i själva chattfönstret som andas och pulserar när den tänker"): bara medan status är `building` andas ett mjukt ljus i panelens innerkant, som ljus som fångats i kanten av glaset. Stilarna ligger i `web/src/hud/activity.css`.
    - Ljuset är `--wb-hud-text` blandat med `--wb-accent`: en skarp kant på 1 px (78 % vitt) och ett mjukt sken (52 % vitt). Det ligger i glaset, under text och kapsel, och når högst 14 px in, medan texten börjar 18 px in. Kontrasten är därför densamma i topp och dal (uppmätt).
    - Kanten och skenet andas med olika styrka (kanten 0,35→1, skenet 0,08→1): ljuset blir starkare och mjukare mot toppen och drar sig tillbaka till kanten i dalen.
    - Perioden är halva prickens takt (`playbackRate` 1,65, cirka 1,94 s). Andningen går på samma tidslinje som pricken (`startTime` 0) och börjar en kvarts varv in (`iterationStart` 0,25), så att varje topp sammanfaller med varannan av prickens toppar. En hel panel som pulserar var 0,97 s blir jäktig; 1,9 s är samma andetag som fröytans ljusband och svepet.
    - Bara opacitet animeras, aldrig skuggorna, och ingenting flyttas eller byter storlek. Kantljuset tonar in och ut på 160 ms och släcks direkt när HUD:en stängs. I ihopfällningens kopia står det fryst där det var och tonar ut med innehållet.
  - **Inmatningen:** en kapsel (`--wb-hud-composer`, radie 18) med synlig markör och utan platshållartext. Mikrofonen sitter till höger. Det finns ingen skicka-knapp, eftersom Enter skickar. Stoppknappen syns bredvid mikrofonen bara under building och waiting.
  - **Frågekort:** på `--wb-hud-card`. Primärknappen är vit med blå text, de andra genomskinliga med vit kant.
  - **Linjen till appen** (§13): 1,5 px i `--wb-accent` med runda ändar och ett svagt blått sken (`drop-shadow` 3 px). Den ligger i `.wbh-root` under alla paneler, så att den aldrig korsar en HUD:s text, men över fönstren. Den tonar in på 200 ms när panelen glidit ut och tonar bort när HUD:en sjunker in i pricken. I en HUD som inte är aktiv har den opacitet 0,45.
  - **En HUD som inte är aktiv** är lugnare, utan etiketter. En mörk slöja (`--wbh-calm-veil` i `hud.css`, `rgb(4 12 44 / 0.2)`) ligger i glaset under text och kapsel. Skuggan är plattare, inmatningen saknar kapsel (som i en tom HUD) och mikrofonen och stoppknappen har ⋯-knappens vilofärg (0,6). Aktivitetsradens svep syns inte och pricken står still. Kantljuset andas inte: det står stilla och svagt (kanten 0,45, skenet 0,18). Textens färger ändras aldrig. Slöjan tonar på 240 ms, och med minskad rörelse direkt. En ny HUD är lugn tills den blir aktiv, och ihopfällningens kopia behåller det lugna utseendet. HUD:arna staplas i den ordning de senast var aktiva, med den aktiva överst. Kopiorna som fälls ihop ligger över alla paneler.
  - **Kontrast:** all text ska ha minst 4,5:1, mätt mot grå yta, vit app och mörk app bakom, även i en HUD som inte är aktiv. Kontroller i vila (⋯, och mikrofonen och stoppknappen i en HUD som inte är aktiv) har minst 3:1 mot sin yta.
    - Undantaget är användarens rad för ett meddelande som aldrig kördes (§13), `--wbh-dropped` i `hud.css` (65 % vitt mot radernas 82 %): den ska synas dämpad men fortfarande läsas, så den har minst 4,5:1 över grå yta och mörk app och minst 3:1 över en vit app (3,7:1 vid gradientens ljusa topp).
- **Ihopfällning:**
  - HUD:en krymper på 370 ms (`p^1,7`) till en 11 px cirkel på pricken (`world.dotOf`), med icke-likformig skala och radie mot 50 %. Innehållet tonar ut under de första 30 %, och cirkeln smälter in i pricken under de sista 25 %. HUD:en fäller bara ihop sig.
  - Sväljningen ägs av världen. När en app försvinner ur `hud:state.open` "sväljer" appens prick 300 ms senare (skala 1,6, `--wb-spring-pop`) med en blixtring på 760 ms. Ett byte av aktiv HUD sväljer ingenting.
  - Öppning är samma rörelse baklänges från kanten.
- **Minskad rörelse:** med `prefers-reduced-motion: reduce` rör sig inget i världen av sig självt. Flygningar hoppar, prismor byter sida utan vridning och snurrar inte efter bygget, materialisering och upplösning är bara toningar (ingen skala eller oskärpa), strecket morfar inte, och pricken andas bara i ljusstyrka och sväljer inte HUD:en. HUD:ens kopia tonar bara ut (160 ms) och ⋯-menyn tonar bara in. Aktivitetsradens prick andas bara i ljusstyrka (halon står på skala 0,84), och inget ljus sveper över etiketten. Kantljuset andas inte: det står stilla, något ljusare än dalen (kanten 0,8, skenet 0,6), och tonar bara in och ut.
- **Prismor:** se §10.5 (platt i vila, titt vid kanten, ett varv efter bygge).
- **Kantmarkörer:** 8 px prickar i `--wb-accent` mörkad till 55 % (`color-mix` mot svart) med prickens sken (`--wb-dot-glow`), och `--wb-accent` vid hovring. De är blå, så att de inte kan tas för prickgridden, och har minst 3:1 mot ytan där de kan sitta (uppmätt i Chrome vid 1440 × 900: 3,6–4,7:1 runt vyns kant, och 3,2–4,1:1 mot sitt eget sken). Ren `--wb-accent` ger bara 1,6–2,0:1, lika lite som `--wb-grip` (1,6–1,7:1).

## 15. Tester

- **`npm test`** (`node --test`, `tests/unit/`) täcker:
  - kameramatematik
  - policyn
  - etiketter
  - resultattolkningen (avbruten/ok/fel)
  - kvotvarningen
  - manifestnormalisering
  - vakten (Host, Origin, Sec-Fetch, Service-Worker, `/@fs/`)
  - HTML-injektion (även doctype utan head)
  - statiska sökvägar (`..`, `%2F`, symbolisk länk, `/Data/`)
  - store
  - git-hjälparen: commit-meddelandena `` `touch pwned` $(touch pwned) "; touch pwned ``, `$(touch pwned)`, `` `touch pwned` `` och `"; touch pwned; echo "` får inte skapa någon fil. Det första fäller de naivaste implementationerna bara på syntaxfel, och de andra fäller dem på riktigt.
  - gör om (§6, §7.4, §13): tre commits, två ångra och två gör om ger filerna byte för byte och `data/` orörd, och en ny commit efter ett ångra tar bort gör om, också när referensen inte gick att ta bort (ett färskt lås) (`server-store-git.test.ts`); filer som heter `HEAD` och `HEAD~1` i appen (kalibrerat mot samma anrop utan `--`); bevakaren laddar inte om under gör om; vägen `POST /api/apps/:id/redo` (409 under en tur och utan något att göra om, ordningen, rev) och `canRedo` i svaret på ångra; raden i `<workbench>`-blocket netto; ett svar på ångra eller gör om som kommer efter appens `turn`-händelse sätter inte Gör om, medan en tur i en annan app inte hindrar det (`hud-store-redo.test.ts`); ⋯ Gör om i riktig Chrome, också raden vid 409 (`hud-browser.test.ts`). Fallen fälldes av den gamla koden och av planterade fel: ett ångra som alltid skriver över referensen, ett gör om som hoppar direkt till den eller går dit utan `--ancestry-path`, ett `canRedo` som bara frågar om referensen finns, en commit som låter den stå kvar, gör om utan bevakarens markering eller utan låset i REST, ett gör om som lämnar ångra-raden kvar, och ett skal som inte glömmer Gör om vid en tur, struntar i `canRedo` i svaret, sätter det ur ett svar som kom efter en tur, räknar turer för alla appar tillsammans eller kastar vid 409.
  - proxyns felvägar
  - startraderna (§7, `server-http-startup.test.ts`, servern körs på riktigt): en rad när `/usr/bin/sandbox-exec` eller `ffmpeg` saknas och ingen annars, mot en planterad rad som alltid skrivs
  - `<workbench>`-blocket
  - bryggans validering
  - XSS-fall i HUD:ens renderare (`<img src=x onerror=…>` ska visas som text)
  - flykttesterna i §4.5 (sandlåda på och planterad läcka), även delade tillfälliga kataloger och användarens kataloger bredvid TMPDIR (`C` och `0`, som var öppna före granskningen 17 oktober), de skrivspärrade katalogerna (§9), också `/Library/Fonts`, `/Library/Caches` och `/cores`, hårda länkar in i data/, `fork` med IPC och `open` via LaunchServices
  - backendernas livscykel (§9; `server-backends-supervisor.test.ts`, `server-http-backend.test.ts`, `server-backends-escape.test.ts`, `server-backends-guard.test.ts`): tomgångsstoppet, men inte mitt i en förfrågan eller medan en WebSocket eller SSE-ström är öppen (kalibrerat mot en workbench som inte räknar dem); `ensure()` medan backenden stoppas (ingen ny process under ett uttryckligt `stop()`, en ny direkt efter tomgångsstoppet); omstart när koden ändrats; vakten i barnbarn via NODE_OPTIONS, och att ett barns egen server ändå svarar på sin port; lsof under drift (kalibrerat mot kontrollen avslagen); och paketuppslaget med `apps/package.json` (CommonJS och ESM utan egen package.json, kalibrerat mot läsrätt till förfädernas package.json). `WB_TEST_NODE=<node>` kör samma backends under ännu en Node (24 och 26 föll utan gränsfilen)
  - hemligheterna (§8.2, §8.5) och hårda länkar (§4.6)
  - bryggans grind (§10.3), mot en planterad grind som släpper igenom allt
  - HUD:ens kontrast (§14): varje färgterm i `--wb-hud-blur`, kalibrerad mot pixlar från Chrome, mot den första gradienten och mot glaset utan `brightness()` som planterade läckor, och för en HUD som inte är aktiv (slöjan) mot en planterad `opacity: 0,86` på panelen
  - kantmarkörens kontrast (§14, `hud-contrast.test.ts`): minst 3:1 mot ytan längs hela vyns kant i flera vystorlekar, med ytan räknad som shadern gör (kalibrerad mot pixlar från Chrome), mot `--wb-grip` och ren `--wb-accent` som planterade fel
  - HUD:ens kantljus (§14): takten och fasen mot pricken, och att ljuset håller sig inom 14 px (`hud-model.test.ts`), mot planterade fel (`iterationStart` 0, en annan takt, en egen `startTime`, ett bredare sken)
  - Bash i sandlådan (§8.5 punkt 2): godkänns direkt efter policyn, men inte utan sandlåda, inte med en ask-regel och inte för andra verktyg
  - HUD:arnas ordning (`web/src/hud/stack.ts`: den aktiva, Esc-ordningen, automatiken bakom den aktiva och omladdningen), mot en planterad enkel-HUD som byter app och en planterad automatik som lägger sig överst
  - placeringen med flera HUD:ar: en äldre HUD väger dubbelt, lika kostnad behåller sidan, ett fönster som flyttas dit ger inget nytt val, och hysteresen (litet överlapp, kamera i rörelse)
  - HUD:arnas minne (`persist.ts`): flera HUD:ar, den aktiva, Esc-ordningen, sidan, och den äldre formen med en enda app
  - taket på levande processer när fler HUD:ar än taket är öppna, mot dagens undantag och mot ett planterat tak som struntar i öppna HUD:ar
  - fel som användaren ser och spåren efter Stopp (`server-claude-sessions.test.ts`): en planterad commit som misslyckas, en återupptagning som misslyckas och självtestets minnesfiler ger noter, samma läcka bara en gång; Stopp lämnar det delvisa svaret och "Avbröts …" efter turslutet; noterna för meddelanden som aldrig kördes har `dropped`; `turn` slut efter §8.6 steg 3, och direkt när servern stängs under stegen; gravstenen efter `forget`; tömningen och `sessions.note`, även under §8.6
  - supervisorns `onCrashed` (`server-backends-supervisor.test.ts`, även för en backend som lyssnade utanför loopback, efter redo och vid kontrollen under drift), en uppgiven backend som startar igen vid nästa `ensure()` när koden ändrats (kalibrerat: med samma kod startar den inte; fälldes av koden före rättelsen) och tomgångsstoppet, som varken anropar `onCrashed` eller lämnar backendens felrad till felsignalen (kalibrerat mot ett planterat stopp utan orsak, som gjorde både och), loggvägen `GET /api/apps/:id/logs` (`server-http-rest.test.ts`: vakten, `n`, okänd app, och raden när loggen är tom) och ringen som läses in ur `logs.txt` och `logs.txt.1` efter en omstart, också flerradiga poster, men inte efter `clear` (`server-store-logs.test.ts`; fälldes av den gamla ringen, som var tom) och signalerna (`server-http-shutdown.test.ts`: första signalen väntar ut turerna, den andra stänger direkt, kalibrerat mot den gamla hanteraren)
  - den dämpade raden i modellen (`hud-model.test.ts`) och kontrasten (`hud-contrast.test.ts`, mot en planterad för svag och en odämpad färg), och i riktig Chrome tillsammans med ⋯ Visa loggen och Stopp mitt i strömmen (`hud-browser.test.ts`)
  - noternas plats efter turslutet och uppläsningen när ett röstmeddelande skickas under §8.6 eller efter Stopp (`hud-model.test.ts`, kalibrerat mot den gamla uppläsningsregeln, och i riktig Chrome i `hud-browser.test.ts`)
  - flera HUD:ar i riktig Chrome (`hud-browser.test.ts` B1–B8):
    - två öppna med den nya aktiv och den andra lugn utan andning, och svepets fas när den lugna HUD:en blir aktiv igen
    - Esc-ordningen; tryck och drag; klick gör aktiv och ⌘K gäller den man skriver i
    - automatiken bakom den aktiva; omladdning med två; bara den aktiva spelar in
    - pricken stänger en HUD som inte är aktiv utan att ta fokus: mellanslaget blir tryck-och-prata i den aktiva, mot en planterad prick som tar fokus vid mousedown
    - ett besvarat hemlighetskort ger fokus tillbaka till inmatningen (fälldes av koden före rättelsen)
    - linjen (B9) går från varje apps prick till dess egen HUD, stark i den aktiva och svagare i den lugna, och följer kameran; mätningen kalibreras mot den andra appens prick
  - kromens zoner under ett fönster ovanför (`world-layout.test.ts`): den största fria delen av en kant, att fönster som inte når remsan inte påverkar den, och täckta hörn och punkter
  - en ny app från fältet (`world-layout.test.ts`, §10.9): mitten när den är fri, annars bredvid appen i fokus eller ett annat fönster utan överlapp, krympt när den inte ryms, och mitten när inget går; fälldes av den gamla platsen mitt i vyn. Minst 24 px från vyns kanter (fälldes av HUD:ens 12 px marginal, som lade nederkanten på 888 i en 900 px hög vy), utan fokus bredvid fönstret närmast mitten när bara en HUD står där (fälldes av mitten över HUD:en), och i 2 000 slumpade scener aldrig närmare kanten än 24 px eller med mer överlapp än mitten (fälldes i 888 respektive 28 scener av rättelsens första version). När vyn är full begraver den aldrig ett äldre fönster: tio byggen i rad som i QA:s körning, där det fjärde nu står ett trappsteg upp åt vänster från det första (fälldes av platsen före trappsteget, som gav det fjärde bygget det första fönstrets rektangel), och i de slumpade scenerna mer överlapp än mitten bara för att inte dölja ett fönster som mitten döljer och aldrig ett fönster dolt som mitten inte döljer (platsen före trappsteget dolde ett fönster i 139 av scenerna, i 17 av dem ett som mitten inte döljer; nu i 4, där varken trappsteg eller mitten går)
  - smart zoom på tom yta (`world-gestures.test.ts`): tillbaka, eller visa allt när tillbaka-stacken är tom (fälldes av koden före rättelsen, som då inte gjorde något)
  - pekaren mot världen i riktig Chrome (`world-pointer-browser.test.ts`): `wb-near` inom 96 px från fönstret och inte utanför (kalibrerat åt båda hållen), med greppets, knapparnas och sidprickarnas färger och verktygstipsen; en kantmarkör ovanpå ett fönster döljs och tar ingen pekare (kalibrerat: utan fönstret syns den och tar pekaren; fälldes av en markör som aldrig döljs); dubbelklick på tom yta visar allt och samma igen flyger tillbaka, men inte till en vy utan fönster, och inte heller Esc (fälldes av koden före rättelsen); ett dubbelklick stänger högst den aktiva HUD:en (kalibrerat: två enkla tryck stänger två); ett dubbelklick vars andra tryck blir ett drag ritar en app och rör inte kameran, och ett vars andra tryck avbryts med Esc gör ingenting (båda fälldes av koden före rättelsen, där kameran flög; kalibrerat: Chrome skickar dblclick i båda fallen); dubbelklick på greppet och i en app är som förut, och på en sidprick eller i HUD:ens inmatning rör det inte kameran (kalibrerat var för sig: när skalets kontroll av målet släpper igenom sidprickar eller HUD:en flyger den)
  - fältets igenkänning (`shared-open.test.ts`): adresser (inte tal, mejladresser eller `javascript:`), svenska datum med relativa dagar, veckodagar och veckor mot ett fast datum, och kontrollen av det som lämnas till appar; `opens` i manifestet; `sendOpen` som bara skickar giltiga och normaliserade värden
  - fältets röst och det hållna mellanslaget i riktig Chrome (`hud-browser.test.ts` F1–F2 och "mellanslaget som hålls i en HUD", Chromes låtsasmikrofon och tal till text i sidan):
    - håll mellanslag utan öppen HUD spelar in, och släppet ger texten i fältet och ett byggförslag som läses upp (skriven text läses inte upp); ett kort tryck på tom yta stänger bara fältet, och med en HUD öppen är mellanslaget tryck-och-prata i den
    - i det öppna fältet: på ett uppläst förslag (Bygg i fokus) ändrar ett kort tryck ingenting, och ett mellanslag som hålls talar in igen utan att trycka på Bygg, och inte heller på ett förslag till skriven text trycker mellanslaget på Bygg; efter ett fel gör den tomma inmatningen likadant i stället för att skriva mellanslag
    - blur och en gömd flik (`visibilitychange`) stoppar inspelningen som ett släpp, och efter blur trycker upprepningarna inte på Bygg; ett tappat släpp medan mikrofonen öppnas startar ingen inspelning
    - en HUD som öppnas av sig själv avbryter inspelningen utan att upprepningarna skriver något i den, och mikrofonen släpps när fältet stängs, även en som kommer efter Esc
    - i en HUD godkänner det hållna mellanslaget aldrig ett frågekort som tagit fokus under tiden, och släppet stoppar inspelningen även när kortet tog fokus från mikrofonknappen; kontroll: ett nytt tryck på Tillåt godkänner
    - Varje del fälldes först av koden före ändringen eller av ett planterat fel. Blur prövas mot en planterad lyssnare som stoppar fönstrets blur (i ett init-skript: vid fönstrets egen blur kör Chrome lyssnarna i registreringsordning, även capture; uppmätt), och den gömda fliken mot hanteraren utan sin lyssnare.
  - vägvalet (`server-claude-route.test.ts`): prompten med apparna som data, rensningen (bara byggda appar som finns), låtsas-Claude och att skalets påstådda värden kontrolleras igen; vägen `POST /api/route`
  - byggarens verktyg (`server-claude-tools.test.ts`, `server-claude-shots.test.ts`): verktygen läser app.json på nytt först, så att en sida som just lagts till går att skärmdumpa och prova och en ny backend nås av `call_backend`; `body_base64` (exakta byten, content-type, tak, fel före förfrågan); i riktig Chrome `upload`, `drop` och `paste` med provfilerna (kalibrerat utan steget), låtsad kamera och mikrofon bara med behörigheten, även i ramen för `open` (kalibrerat: utan den `NotAllowedError`; i ramen `fullscreen` och `clipboard-write` men inte det app.json inte anger) och `open` genom ramen till `wb.onOpen` (kalibrerat utan steget, mot ett slag som app.json inte anger och mot en planterad wb.js utan kontrollen av avsändaren), utan en enda förfrågan till skalets origin. Varje fall fälldes först av koden före rättelsen.
  - engångsfrågornas options (`server-claude-options.test.ts`): inga verktyg, och förslagsfrågans deny-regler för `data/secrets.json`, mot en planterad fråga byggd utan appens mapp
  - förslagen (`server-claude-ideas.test.ts`): rensningen, prompten med appens filer som data, en fråga per rev med cachen, samtidiga anrop som delar en fråga, ett tomt svar som inte sparas, och låtsas-Claude; vägen `POST /api/apps/:id/ideas` (GET 405, obyggd 409, fel 503 utan detaljer)
  - raden och flykten (`world-shelf.test.ts`): miniatyrens form, raden i ordning med nederkanterna i linje, ihopskjutningen när den inte ryms (kalibrerad mot en rad utan ihopskjutning), flykten från fönstret till rutan med ett varv runt två axlar, lutningen och oskärpan bara mitt i, och storleken före vridningen
  - `minimized` i scenen och i bryggans validering: heltal som inte är negativt, sparas och tas bort när fönstret tas fram
  - linjens geometri (`hud-tether.test.ts`): närmaste punkt på panelens rundade kant, prövad mot kanten punkt för punkt på 200 lägen och mot en planterad rak rektangel som missar hörnen
    - Varje fall fälldes först av den gamla enkel-HUD:en eller av ett planterat fel.
  - det ingen ser, i riktig Chrome (`world-offscreen.test.ts`, §10.5, §10.8, §14): iframes långt utanför vyn döljs men inte i vyn, i raden eller med fokus (kalibrerat: att dölja en iframe med fokus tar fokus från den), marginalen är minst en halv vy (fälld av ett planterat fel), i vila går bara de synliga prickarnas andning (koden före rättelsen hade tio animationer i stället för två), fröytans ljusband sveper bara under bygget och medan det tonar ut, pricken andas fortare under bygget och blinkar när appen väntar, och kromen utanför vyn göms, en armerad Ta bort avbryts och kromen kommer tillbaka på rätt plats i första bildrutan (DOM:en och en skärmbild av just den bildrutan, med rAF fryst efter den; kalibrerat mot en plats som rättas en bildruta för sent). Mätskripten i `tests/perf/` (`offscreen.mjs`, `offscreen-flash.mjs`) jämför med och utan på samma sida och körs för hand.
  - felsignalen (§7.2): i registret sätter ett ohanterat fel `trouble` och sänds en gång, och `bumpRev` och turens slut tar bort det; under en tur, med status error, i en obyggd app och från en sida med en äldre version eller utan version händer inget, och ett vanligt `console.error`, Nodes varningar och platsrader på stderr sätter inget, kalibrerat mot fyra planterade register (varje console.error, varje stderr-rad, även under en tur, oavsett version). Vägen från `/__wb/log` med `x-wb-rev` och huvudet på `/__wb/app.json`; i supervisorn lämnar en krasch sin felrad men ett hanterat fel på stderr inget, inte heller vid stopp (kalibrerat mot en supervisor som lämnar varje stderr-rad); prompten med felen och en fråga per rev. Skalet i riktig Chrome (`hud-browser.test.ts`): bärnstensfärgad prick och "Rätta felet" först i Förslag mot ett vanligt `console.error` i samma körning; den gamla sidan, som kastar tills den tas bort, sätter inte tillbaka felet på en ny version, varken efter en handredigering eller efter turen (kontroll: en ny version som kastar sätter det); och "Rätta felet" går att klicka med musen medan förslagen hämtas och när de inte gick att ta fram och skickar raden citerad (fälldes av väntans och felradens överlägg), medan **Försök igen** fortfarande tar sina klick
  - märket: bryggans validering (sträng eller null, kontroll- och formattecken bort, också U+061C, och en text av bara U+200B eller U+2060 blir null, vilket den gamla teckenklassen fälldes av; högst tre kodpunkter, samma hink; kalibrerat mot läckor utan klämning, tvätt och typkontroll), `wb.badge` i riktig Chrome, och kromen (`hud-browser.test.ts`): text bredvid kärnan, dolt under building och waiting, en fylld prick på miniatyren, borta efter en omladdning där sidan inte sätter det (kontroll: en sida som sätter det när den laddas), dolt och utan pekare där ett fönster ovanför täcker det (kontroll: samma punkt utan fönstret), och högst 44 px brett (fälldes av ett tecken som gav 121 px)
  - kanalen mellan sidorna (`bridge-browser.test.ts`): `wb.store.onChange` och `wb.faces` når den andra sidan efter att skrivningen gått igenom men aldrig avsändaren, med skrivningen fördröjd 300 ms så att en för tidig `onChange` läser det gamla värdet (kalibrerat mot en kanal som lämnar till avsändaren och en som sänder före skrivningen), och en sida som kommer senare läser värdet med `get`, hör ingen tidigare ändring men hör nästa (kalibrerat mot en kanal med historik)

  Varje test som ska visa att något *inte* läcker har först fällts av en planterad läcka.
- **Parallellt och i en färsk klon:** inget test lyssnar på en fast port. `tests/ports.ts` väljer en ledig port, eller ett portspann för backends utanför 18300–18499 med ett lås som bara en körning åt gången håller, om inte en miljövariabel anger porten; kanariet i flykttesterna är hemmets `Config.port`, så att profilen nekar just den. Varje krok som startar eller stoppar en process, en server, en webbläsare eller en socket har en tidsgräns, varje `listen` har en felväg, och båda skripten kör `node --test` med `--test-force-exit` och `--test-timeout=300000`, så att inget kan hänga sviten; unix-socketar ligger på korta sökvägar (högst 104 byte, hemsocketen under `~/Library/Caches`) och testernas tillfälliga kataloger har processens pid i namnet. Testriggens appar (`tests/bridge-harness/apps/`) är spårade (`.gitignore` förankrar `/apps/`, `/data/` och `/vault/`), webbläsartesterna hoppas över om Chrome saknas, och `scripts/fresh-clone-check.sh` är kontrollen före push: `npm run check` och `npm test` i en färsk klon av HEAD med över 150 teckens sökväg.
- **`npm run test:e2e`** (Playwright via `playwright-core`, `channel: 'chrome'`, alltid `--force-device-scale-factor=2` + `deviceScaleFactor: 2`) kör servern med `WORKBENCH_FAKE_CLAUDE=1`, egna portar och en tillfällig `WORKBENCH_HOME`. Porten läses ur `WB_E2E_PORT` (HMR är då porten + 9), annars väljs lediga portar, och den tillfälliga katalogen ur `WB_E2E_DIR`.
  - `tests/e2e/shell-flow.test.ts` kör skalet med riktig indata, ett ordnat flöde där varje steg kalibreras i samma körning:
    1. tom yta
    2. rita; Esc tar bort en orörd fyrkant, och ett nytt drag på samma ställe direkt efteråt ritar (K1; `WB_SHELL_PLANT=k1` planterar felet)
    3. inmatningen har fokus under 600 ms efter släppet
    4. skriv och Enter ger bygge (pricken pulserar, ljusbandet sveper)
    5. klart: ett svar i HUD:en och appens sida i iframen
    6. tryck på tom yta stänger HUD:en, och fönstret står kvar
    7. pricken öppnar igen
    8. omladdning: fönstret, HUD:en och utkastet finns kvar
    9. omladdning medan pekaren vilar över appen: ett nyp där zoomar innan skalet sett pekaren (§10.3, grindens blinda läge; kalibrerat mot en grind utan den regeln)
    10. ⋯ Ångra
    10b. ⋯ Gör om finns bara efter ett ångra och ger appen tillbaka (kalibrerat: före ångra finns ingen Gör om-rad)
    11. ⌘0 visar allt
    11b. knappen till höger om greppet minimerar appen till raden i nedre vänstra hörnet, HUD:en stängs och `minimized` sparas; ett klick på miniatyren tar fram den till exakt samma plats, i fokus
    12. en tresidig app (fyra sidor med Förslag, §10.8) ritas medan den första appens HUD är öppen: båda HUD:arna är öppna utan att överlappa, och den nya är aktiv och har fokus. Ett tryck på tom yta stänger bara den nya, och den första blir aktiv med fokus; ett andra tryck stänger den. Appen vrids med ⌃⌥→ och är platt i vila.
    13. två HUD:ar öppna med pricken: Esc stänger bara den aktiva, och den första blir aktiv med fokus; nästa Esc stänger den. Kalibrerad mot en planterad Esc som stänger alla HUD:ar.
    13b. fältet: utan öppen HUD öppnar första tecknet fältet, text som ingen app tar ger ett byggförslag och Avbryt bygger inget (kalibrerat: med en HUD öppen går tecknet till HUD:en)
    13c. fältet: två byggen i rad hamnar inte på varandra (fälldes av den gamla platsen mitt i vyn, som lade båda på 360, 250, 720 × 460) och står minst 24 px från vyns kanter (fälldes av HUD:ens 12 px marginal: det första stod på y 12,4)
    13d. fältet i en full vy: fyra byggen i rad på tom yta, och inget döljer ett äldre fönster (fälldes av platsen före trappsteget, som gav det fjärde det första fönstrets rektangel)
    14. Ta bort i ⋯-menyn med bekräftelse
    14b. krysset under fönstret tar bort appen först vid andra klicket; Esc avbryter (kalibrerat: ett klick tar inte bort)
    15. inga fel i skalets konsol
  - `tests/e2e/server-flow.test.ts` driver servern direkt (WS och HTTP): bland annat ångra och gör om med riktig git, backend via proxyn, en hemlighet via `request_secret` och `try_app`-isoleringen mot en kalibrering utan isolering, och `try_app`:s `upload` (uppladdningen stoppas), låtsade kamera (kalibrerad utan behörighet) och `open` genom ramen, med kameran även där, samt `call_backend` med `body_base64` och sedan GET, mot den riktiga vakten och en sandlådad backend.
  - Inte täckt av e2e än: skärpemåttet efter zoom (varians-av-Laplace mot en referens, kalibrerat mot en suddad kontroll; mätt för hand i Chrome med fönster, §4.4) och ctrl+wheel över en app mot sidzoom. `visualViewport.scale` går inte att kalibrera över en app-iframe. Mät därför standardhandlingen: ett ostoppat CDP-ctrl-hjul över ett scrollbart element scrollar det, ett stoppat gör det inte. Ett riktigt nyp med trackpaden provas för hand.
- **Pekaren i Playwright** måste röra sig in i en app med `steps`, som en riktig pekare som korsar skalet. Hoppar den rakt in i en app-iframe långt bortifrån släpper grinden (§10.3) appens hjul och nyp.
- **`tests/e2e/real-claude.test.ts`** körs bara med `WORKBENCH_REAL=1`. Den bygger en liten app med riktiga Claude.
- **Testkrok:** i dev (`import.meta.env.DEV`) exponerar `main.ts` `window.__wb = { store, bus, world }`, så att tester kan läsa tillstånd och sända bus-händelser. `world.debug` ger `camera`, `setCamera`, `views`, `focused`, `hudApp` (den aktiva HUD:ens app), `huds` (`{ open, active }`), `breathRate`, `toScreen` och `cull(on)`, som slår på (`true`) eller av (`false`) det som sparar på fönster utanför vyn (dolda iframes, gömd krom) så att mätningarna i `tests/perf/` kan jämföra med och utan på samma sida. I produktionsbygget finns kroken inte.
- Varje byggare provar sin del i en riktig webbläsare (eller mot en riktig process) innan den kallas klar. Varje byggare kör en egen instans med egna `WORKBENCH_PORT`, `WORKBENCH_HMR_PORT` och en tillfällig `WORKBENCH_HOME`.

## 16. Ägarskap och byggvågor

| Del | Ägare |
|---|---|
| `server/main.ts`, `stt.ts`, `http/**`, `live/hub.ts` + deras tester | server-http |
| `server/store/**`, `live/git.ts`, `live/watcher.ts` + tester | server-store |
| `server/claude/**` (utom `app-rules.md`, som bara ändras via CONTRACT, §8.11) + tester | server-claude |
| `server/backends/**` + tester | server-backends |
| `sdk/wb.js`, `web/src/bridge.ts` + tester | bridge |
| `web/src/world/**`, `web/src/styles/base.css` + kameratester | world |
| `web/src/hud/**` + renderartester | hud |
| `tests/e2e/**` | integration |
| `shared/`, `server/types.ts`, `server/config.ts`, `server/paths.ts`, `web/src/{types,bus,store,escape,main,env.d}.ts`, `web/index.html`, `web/src/styles/tokens.css`, `package.json`, `tsconfig.json`, `vite.config.ts`, `CONTRACT.md` | frusna; ändras bara via kontraktet |

Testfilerna heter `tests/unit/<del>-<ämne>.test.ts`.

**Våg 1** är server-http, server-store, server-claude, server-backends och bridge. Därefter integrerar och provar en integratör servern med låtsas-Claude. **Våg 2** är world och hud, mot den riktiga servern. **Våg 3** är granskning (säkerhet, robusthet, gränssnitt, appkvalitet) och rättningar per område (server, world, hud, dokumentation), medan användaren provar en fryst kopia av koden, så att rättningarnas omstarter inte avbryter hans Claude-turer. **Våg 4** är en ny granskning av våg 3:s rättningar (server, world, hud och skalets lagring) med rättningar, och ledarens prov med riktiga Claude (svenska och korta svar, appen syns tidigt, hemligheterna, npm i sandlådan). Ledaren har godkänt ändringarna i `app-rules.md` från våg 3 och 4 (§8.11). **Flera HUD:ar** (§13) byggdes efter en granskad plan, provades av två granskare (samspel och robusthet) och integrerades; de frusna `bus.ts` och `types.ts` ändrades i det bygget.

**Granskningen 17 oktober** gick igenom hela projektet med sju linser, och varje fynd prövades av en egen verifierare. Efter ett grundsteg (testerna går att köra var som helst och flera samtidigt) rättades fynden i nio kluster: backendernas sandlåda och livscykel, byggarens verktyg och regler, sessionerna (fel som användaren ser, Stopp, borttagning och omstart), var nya appar hamnar och kromen, det som ingen ser (iframes och krom utanför vyn, animationer i vila), appernas röst (felsignalen, märket och kanalen mellan sidorna), dokumentationen, gör om, och rösten i fältet. Varje kluster byggdes i en egen worktree från samma bas, granskades för sig och rättades efter granskningen, och sedan integrerades alla. Ledaren godkände ändringarna i de frusna filerna och i `app-rules.md` (§8.11), och regeln nedan om andras filer gällde inte i den rundan.

Ingen byggare skriver i någon annans filer. Behövs en ändring i en fryst fil eller hos någon annan, beskrivs den i slutrapporten i stället.
