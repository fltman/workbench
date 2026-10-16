# CLAUDE.md — Workbench

Ett zoombart fönsterhanteringssystem i webbläsaren där varje app byggs av en egen Claude Code-session. **Läs `CONTRACT.md` först.** Det är bibeln, och frusna filer ändras bara via det.

## Kommandon

```bash
npm run dev       # server + Vite-middleware på http://localhost:8220 (HMR på 8229), startar om vid ändringar i server/ och shared/
npm start         # produktion (bygg först med npm run build)
npm run check     # tsc --noEmit
npm test          # enhetstester (node --test, tests/unit)
npm run test:e2e  # Playwright mot riktiga Chrome, låtsas-Claude, tillfällig WORKBENCH_HOME
```

- `WORKBENCH_FAKE_CLAUDE=1` kör ett skriptat låtsas-Claude, så att man kan testa UI:t utan att förbruka kvot.
- Skalet ligger på `http://localhost:8220` och varje app på `http://<id>.localhost:8220`.
- Kolla både skalet (8220) och att HMR (8229) svarar efter varje omstart.
- Egna instanser bredvid Anders: egna `WORKBENCH_PORT` och `WORKBENCH_HMR_PORT` och en tillfällig `WORKBENCH_HOME`. Varje port får en egen Vite-cache (`node_modules/.vite-<port>`). `tests/e2e/server-flow.test.ts` tar porten ur `WB_E2E_PORT`, och `tests/unit/hud-browser.test.ts` ur `HUD_TEST_PORT`, `HUD_TEST_HMR_PORT` och `HUD_TEST_HOME_DIR`.

## Regler

- UI-text på svenska med å, ä, ö. Språk lagas aldrig med regexp.
- Minimalt UI: inga förklarande etiketter, platshållare, statuspiller eller emojis.
- `apps/`, `data/` och `vault/` committas aldrig. Varje app har sitt eget git-repo, och valvet är privat.
- En omstart av servern dödar pågående Claude-sessioner. De återupptas vid nästa meddelande.

## Fällor (uppmätta, se vault/Arkitektur.md)

- **Hjul:** lyssnare måste ha `{ passive: false }` och anropa `preventDefault` redan på första händelsen, annars zoomar Chrome hela sidan.
- **Drag:** sätt skölden `html.wb-dragging iframe { pointer-events: none }`. Annars stjäl iframes rörelserna trots pointer capture.
- **Glas:** en förälder med `clip-path`, `filter`, `opacity` under 1 eller `mask` blir backdrop root, och då ser `backdrop-filter` inte sidan bakom (glaset blir klart och ljust). Klipp med `clip: rect()` eller `overflow` i stället.
- **Fokus:** en app kan ta fokus från skalet när den laddas (dn.se:s kakdialog i en webbläsarapp gjorde det). Skalets inmatningar tar tillbaka det med `web/src/hud/focusguard.ts`, och ett prov måste köras mot en riktig sådan app: `focus()` och `showModal()` i en enkel app tog aldrig fokus i provet.
- **3D:** låt aldrig en app vila under en 3D-transform, för den blir varaktigt suddig. Snäpp och platta till prismor.
- **Claude-sessioner:**
  - Städa alltid miljön (`CLAUDECODE`, `CLAUDE_CODE_*`).
  - Sätt `permissionMode` explicit.
  - Kör aldrig två processer på samma session.
- **Node 25:** sätt felhanterare på varje socket i proxyn, annars tar EPIPE ner processen.
- **Backendens sandlåda:** att neka `launchservicesd` räcker inte för att stoppa `open -a`. Neka också `com.apple.lsd.*` och `quarantine-resolver`.
- **E2E i Playwright:**
  - Starta Chrome med `--force-device-scale-factor=2`. Emulerad DSF når inte iframes i andra processer.
  - Playwright stänger av lagringspartitionering, så slå på den igen när du testar lagring.
  - Flytta musen in i en app med `steps`. Bryggans grind släpper en apps hjul och nyp om skalet inte sett pekaren nära appen, så ett hopp rakt in i en iframe ser ut som en attack.
