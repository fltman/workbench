# Workbench

[![Support me on Patreon](https://img.shields.io/badge/Patreon-Support%20my%20work-FF424D?style=flat&logo=patreon&logoColor=white)](https://www.patreon.com/AndersBjarby)

En tom grå yta. Rita en fyrkant, säg vad du vill ha, och Claude Code bygger appen i fyrkanten, med backend om det behövs. Varje app har en blå prick som tar fram chatten igen så att du kan bygga vidare. Allt går att zooma, och en app kan ha flera sidor.

Kräver Node 25, Google Chrome och en inloggad Claude Code. Agent SDK:n använder samma inloggning.

## Starta

```bash
npm install
npm run dev                  # skalet på http://localhost:8220, HMR på 8229
```

Produktion: `npm run build` och sedan `npm start`.

- Varje app ligger på sin egen adress, `http://<id>.localhost:8220`.
- `npm run dev` startar om servern när något i `server/` eller `shared/` ändras. En omstart avbryter pågående Claude-turer, och sessionen fortsätter vid nästa meddelande. Sidan laddas om, och öppna HUD:ar kommer tillbaka med det du hunnit skriva.
- `WORKBENCH_FAKE_CLAUDE=1` kör ett låtsas-Claude som inte förbrukar kvot.
- Andra portar och kataloger: `WORKBENCH_PORT`, `WORKBENCH_HMR_PORT` och `WORKBENCH_HOME` (där `apps/` och `data/` ligger).
- Tal till text går till en lokal Whisper-server (`WHISPER_URL`, standard `127.0.0.1:54205`), annars till OpenAI om `OPENAI_API_KEY` finns.

## Ytan och kameran

| Gest | Gör |
|---|---|
| Tryck och dra på tom yta | ritar en ny app. Mindre än 120×80 px tonar bort. Öppna HUD:ar står kvar. Ett tryck på tom yta stänger den aktiva HUD:en. |
| Nyp, eller ctrl + hjul | zoomar kring pekaren |
| Tvåfingers scroll | panorerar. Över en app scrollar appen om den kan, annars panoreras ytan. |
| ⌘ + scroll | panorerar alltid, även över en app |
| Tvåfingers dubbeltryck (smart zoom) | flyger till fönstret under pekaren, eller tillbaka |
| ⌘0 | visar allt |
| Prick vid vyns kant | en app utanför bild; klick flyger dit |

## Fönster

| Gest | Gör |
|---|---|
| Dra greppet (pillen under fönstret) | flyttar fönstret |
| Dubbelklick på greppet | flyger till fönstret; samma igen flyger tillbaka |
| Dra en kant eller ett hörn | ändrar storlek, och appen flödar om |
| ⇧ + dra i ett hörn | skalar fönstret utan omflödning |
| ⌥ + nyp över ett fönster | skalar fönstret |
| Klick i ett fönster | lägger det överst och ger det fokus (för ⌘K och ⌃⌥←/→) |
| Pilen till höger om greppet | minimerar appen: den tumlar ned på rad i nedre vänstra hörnet |
| Krysset längst till höger | tar bort appen: första klicket frågar (röd "Ta bort"), det andra tar bort |
| Klick på en minimerad app | tar fram den till sin plats |

Esc under ett drag avbryter det, och fönstret går tillbaka.

## Appar med flera sidor

Varje byggd app har en sista sida, Förslag, där Claude föreslår förbättringar. Ett klick på ett förslag bygger det.

| Gest | Gör |
|---|---|
| ⌥ + vågrätt svep över fönstret | vrider prisman; den följer fingrarna och snäpper till en sida |
| ⌃⌥← / ⌃⌥→ | vrider prisman i fokus en sida |
| Sidprickarna bredvid greppet | vrider fram den sidan |
| Pekaren precis utanför fönstrets vänstra eller högra kant | prisman tittar mot nästa sida; klick där vrider |

## HUD:arna

Flera appar kan ha sin HUD öppen samtidigt. Den du skriver i är aktiv och ligger överst; de andra dämpas. En blå linje går mellan appens fönster och dess HUD.

| Gest | Gör |
|---|---|
| Klick på den blå pricken | öppnar eller stänger appens HUD. Andra öppna HUD:ar står kvar. |
| ⌘K | öppnar eller stänger HUD:en för appen i fokus |
| Klick i en HUD | gör den aktiv: den hamnar överst, det du skriver hamnar där, och ⌘K och ⌃⌥←/→ gäller dess app |
| Enter / ⇧Enter | skickar / ny rad. Skickar du medan Claude bygger köas meddelandet. |
| Skriv var som helst | när en HUD är öppen och fokus inte ligger i en app eller ett annat fält hamnar tecknen i den aktiva HUD:en. Utan öppen HUD öppnas fältet: en adress går till webbläsaren, ett datum till kalendern, och passar ingen app föreslås en ny. |
| Håll mikrofonen, eller håll mellanslag i en tom inmatning | talar in ett meddelande, som skickas när du släpper. Första meningen i Claudes svar läses då upp. |
| Stoppknappen | stoppar turen och det som köats efter den |
| ⋯ | Ångra senaste ändringen, Öppna i egen flik, Minimera, Ta bort appen |
| Esc | det innersta först: avbryter ett drag, stänger den aktiva HUD:en, flyger tillbaka |

- Esc på en nyritad fyrkant där inget skickats och inmatningen är tom tar bort fyrkanten. Med text i inmatningen stänger Esc bara HUD:en.
- Väntar Claude på svar (ett kort i HUD:en) kan du också skriva svaret. Texten besvarar kortet.
- Väntar en app på svar öppnas dess HUD av sig själv. Skriver du i en annan HUD tar den inte fokus, och den blir aktiv när du stänger den du skriver i.
- Pricken andas lugnt i vila, snabbare när Claude bygger och blinkar när Claude väntar på dig. Den blir bärnstensfärgad vid fel.

Hur det hänger ihop står i `CONTRACT.md`.
