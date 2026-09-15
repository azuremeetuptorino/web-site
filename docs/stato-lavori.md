# Stato dei lavori

Aggiornato al **15 settembre 2026**. Documento di ripresa: serve a ricominciare
da dove si è lasciato senza rileggere tutto.

Piano completo: [docs/piano.md](piano.md).
Note sulla configurazione SWA: [docs/configuration.md](configuration.md).
Provisioning e deploy: [docs/deploy.md](deploy.md).

## Dove siamo

Branch **`feat/azure-static-web-apps`**, mai pushato.

| Fase | Contenuto | Stato |
|---|---|---|
| P0 | Refactor statico, contenuti su JSON | fatto, verificato |
| P1 | Configurazione SWA, pagine di errore, CI/CD | codice fatto, **risorse Azure da creare** |
| P2 | `/admin` e autenticazione Entra ID | fatto, verificato con l'emulatore |
| P3 | CRUD team su Blob Storage | fatto, verificato in locale contro Azurite |
| P4 | CRUD sponsor e upload loghi | da fare, è il prossimo |
| P5 | Integrazione Meetup e filtro temporale eventi | da fare |
| P6 | Telemetria, SEO, accessibilità | da fare |

## Cosa è entrato con la P3

- `api/src/lib/blob.js` — lettura e scrittura JSON su Blob Storage con ETag. Il
  412 dello storage diventa una `ConflictError`. Unica dipendenza nuova:
  `@azure/storage-blob`.
- `api/src/lib/validate.js` — validazione a mano, senza `ajv`. Raccoglie tutti
  gli errori insieme e restituisce un documento ripulito: sul blob finisce
  quello, mai il body del client.
- `api/src/functions/team.js` — `GET`/`PUT /api/team`, una sola registrazione
  per i due metodi. Ogni `PUT` scrive il master e ripubblica su `public/`.
- Editor del team in `/admin`, con riordino, anteprima, errori accanto al campo
  e gestione del 409.
- `scripts/seed-blob.mjs` + `npm run seed` — carica `src/data/*.json` sul blob.
  Serviva: il provisioning crea i container ma non ci mette dentro niente.
- `src/assets/js/config.js` legge dal container pubblico; `127.0.0.1:10000`
  aggiunto a `img-src` e `connect-src` nella CSP.
- 45 test (`npm test`), nessuna dipendenza di test: `node --test` e uno store
  finto con lo stesso contratto di `blob.js`.

Verificato end-to-end sull'emulatore contro Azurite: `GET` con ETag, `PUT` che
ripubblica, secondo `PUT` con lo stesso ETag → **409 con la copia del server**,
payload sporco → **400 con le issues per campo**, anonimo su `/api/team` → login.
La copia pubblica esce con `Cache-Control: public, max-age=300,
stale-while-revalidate=86400` e l'`ETag` giusto.

## Decisioni già prese

Non vanno ridiscusse salvo ripensamenti espliciti.

| Tema | Scelta |
|---|---|
| Hosting | Azure Static Web Apps, piano **Free** |
| Dati | File JSON su **Azure Blob Storage**, nessun database |
| Admin | Protetta dall'autenticazione integrata di SWA, provider Entra ID preconfigurato, ruolo `admin` per invito |
| Cosa si gestisce da `/admin` | **Team e sponsor**. Non le sessioni. |
| Eventi | Da **Meetup GraphQL** — l'account **Meetup Pro c'è**, quindi si usa il flusso JWT server-to-server |
| Sessionize | **Fuori scope** per ora |
| Frontend | Vanilla, **nessun build step**: `src/` va su Azure verbatim |
| Ambiente di sviluppo | **Devcontainer**, non tooling sull'host |
| Concorrenza | Optimistic con ETag, 409 con la copia del server. Niente lock |
| `order` dei membri | Non è un campo da compilare: si riordina con le frecce e si rinumera 10, 20, 30 al salvataggio |

## Vincoli verificati

Sono stati controllati sulla documentazione o sul campo, non sono supposizioni.

- Su SWA **Free** funzionano: provider preconfigurati, ruoli custom **per invito**
  (max 25 utenti), `allowedRoles`, managed functions. Solo "assegna ruoli con una
  function" richiede Standard.
- Il provider `aad` preconfigurato è **multi-tenant e accetta account Microsoft
  personali**: chiunque può autenticarsi. Il cancello è l'**autorizzazione**.
- SWA **non mette in cache le risposte `/api`**, e `globalHeaders` non le tocca.
  Cold start 1-3 s: per questo il sito pubblico non legge i dati da `/api`.
- Le managed functions **non supportano Managed Identity** né Key Vault: serve
  la connection string in una app setting, `DATA_STORAGE_CONNECTION` (i prefissi
  `AZUREBLOBSTORAGE_`, `WEBSITE_`, `FUNCTIONS_`, `AzureWeb` sono riservati).
- Le managed functions sono **solo HTTP**: niente timer trigger, il refresh di
  Meetup lo schedula un cron di GitHub Actions.
- Meetup: endpoint `https://api.meetup.com/gql-ext`, 500 punti/60 s.
  `Group.pastEvents` e `upcomingEvents` sono stati **rimossi** dopo febbraio
  2025. Con l'account Pro si usa
  `proNetwork(urlname).eventsSearch(input:{filter:{status:…}})`.
  **La query va provata nel playground prima di scriverne il codice.**

## Trappole già pagate

Errori trovati testando, non in astratto.

1. **Una chiave non prevista in `staticwebapp.config.json` fa scartare tutta la
   configurazione, in silenzio** — e `/admin/` torna a rispondere 200 a un
   anonimo. L'unico segnale è `Error reading workflow configuration` nel log
   dell'emulatore. Le spiegazioni stanno in `docs/configuration.md`, non nel
   JSON.

2. **`navigationFallback` era sbagliato qui.** Soft 404 verso la homepage e —
   peggio — le richieste servite dal fallback **saltano le route rules**.
   Rimosso: il sito non è una SPA.

3. **L'emulatore già in esecuzione serve la configurazione vecchia.** Rilegge
   `staticwebapp.config.json` solo all'avvio, e un secondo `npm start` sulla
   porta occupata fallisce quasi in silenzio: si continua a interrogare il
   processo di prima e si conclude che la modifica "non ha effetto". Prima di
   dare la colpa alla config, `pkill -f "swa start"` e riavvia.

4. **I container di Azurite non c'erano.** Il `post-create.sh` li creava con
   `|| true` e l'errore era sparito nel nulla: `/api/team` avrebbe risposto 500
   al primo avvio su una macchina nuova. Ora lo script crea i container,
   configura la **CORS** (serve: il sito è su `:4280` e i dati su `:10000`) e
   lancia `npm run seed`. È stato anche rimesso il `cp` di
   `api/local.settings.json`, tolto per sbaglio nel commit *DevContainer*:
   senza quel file le function non hanno la connection string.

5. **L'emulatore risponde 302, non 403, a un utente autenticato senza ruolo.**
   La `403.html` in locale non si vede per quella strada. Da verificare in
   produzione con un account non invitato.

## Bloccanti

1. **Le risorse Azure non esistono.** Nessuno ha ancora lanciato
   `scripts/provision-azure.ps1`. Serve una subscription e `az login`.
   **Punto di attenzione:** lo script crea lo storage con
   `--allow-blob-public-access true`. Se una Azure Policy lo vieta, il comando
   fallisce e **va ripianificata la lettura dei dati** (il sito dovrebbe leggere
   da `/api` accettando il cold start, invece che dal blob con ETag).
   Dopo il provisioning servono tre cose, in [deploy.md](deploy.md): l'app
   setting `DATA_STORAGE_CONNECTION`, un `npm run seed`, e il nome dell'account
   dentro `STORAGE_ACCOUNT` (`config.js`) **e** nella CSP.

2. **L'editor del team non è mai stato aperto in un browser.** L'API è
   verificata con curl e i test, il cablaggio DOM è verificato a tavolino
   (ogni `id`, `data-field` e `data-preview` usato dal JS esiste nel template),
   ma nessuno ha visto la pagina. Nel devcontainer non c'è un browser headless.
   Da fare a mano: `npm start`, login emulato con ruolo `admin`, e provare
   aggiunta, riordino, eliminazione, errori di validazione e il 409 con due
   schede aperte.

3. **Logo e hero puntano a URL esterne volatili** (CDN di LinkedIn e Unsplash).
   Sono in `img-src` nella CSP per non rompere nulla, ma il logo vero andrebbe
   scaricato in `src/assets/img/`. **Serve il file del logo**, non ce l'ho.

## Punto aperto: Node 20 o 22

Il devcontainer è passato a `javascript-node:1-22-bookworm` nel commit
*DevContainer*, mentre README e piano dicono Node 20 perché è la major delle
managed functions e perché Core Tools v4 non partiva su Node 22+. Nel container
gira **Node 22.16 con Core Tools 4.14 e l'emulatore funziona**, API comprese.

Resta che in produzione le function girano su Node 20: il rischio non è
l'avvio, è usare senza accorgersene qualcosa che c'è solo su 22. Da decidere:
tornare all'immagine Node 20 o allineare la documentazione alla scelta fatta.

## Come si riprende

```bash
git checkout feat/azure-static-web-apps
```

Poi in VS Code: *Reopen in Container*.

```bash
npm start     # emulatore SWA su http://localhost:4280
npm test      # test delle managed functions
npm run seed  # ricarica i dati su Azurite
```

Per entrare in `/admin` con l'emulatore: apri `/.auth/login/aad`, metti uno
username qualsiasi e nel campo dei ruoli scrivi `admin`, uno per riga.

> L'emulatore rilegge `staticwebapp.config.json` **solo all'avvio**: dopo averlo
> modificato riavvia `npm start`, altrimenti stai testando la vecchia config.

## Prossimo passo: P4

Sponsor e upload dei loghi. Il grosso è riuso diretto della P3:

- `GET/PUT /api/sponsors` — stesso schema di `team.js`, con
  `validateSponsors()` accanto a `validateTeam()`: `tier ∈
  gold|silver|bronze|partner|venue|media` è l'unico dato che governa dimensione
  del logo, raggruppamento e ordine delle fasce, così aggiungere uno sponsor non
  tocca mai il CSS.
- Editor sponsor nell'admin: il pannello e il `<template>` ricalcano quelli del
  team, e `team-editor.js` è già scritto per essere ricalcato (le uniche parti
  specifiche sono i campi e le anteprime).
- `POST /api/assets` con `lib/image.js`: body JSON con base64 (niente
  multipart), cap 512 KB, allowlist di content-type, nome normalizzato più
  suffisso hash. Gli **SVG vanno sanificati** prima della scrittura — `<script>`,
  `<foreignObject>`, attributi `on*` e `href`/`xlink:href` non-`#`: un `<img>`
  non esegue lo script di un SVG, ma il blob è raggiungibile per URL diretto e
  lì lo eseguirebbe.
- Rendering sponsor raggruppato per tier in `render-sponsors.js`.

Lo schema di `sponsors.json` è in [docs/piano.md](piano.md), sezione
*Modelli dati*.

## Cose lasciate indietro di proposito

- **Sessioni/talk**: fuori scope. Rientrerebbero come `sessions.json` con lo
  stesso schema di `team.json`, collegate agli eventi tramite l'id Meetup.
- **"Chi siamo", footer e statistiche** (`1.2k+ membri`, `30+ meetup`): ancora
  scritti a mano nell'HTML.
- **SEO degli eventi**: spostandoli su rendering client-side sono diventati
  invisibili ai crawler senza JS e alle anteprime dei link su LinkedIn e
  WhatsApp. Recuperabile in P6 con uno snapshot statico generato dal job di
  refresh.
- **I 6 sponsor sono finti** (CloudNova, TechFlow, …), come i loghi. Vanno
  sostituiti con quelli veri quando ci sarà l'editor di P4.
- **Gli 11 membri del team sono placeholder** con foto Unsplash, tranne forse
  Matteo Contessa. Adesso però si correggono da `/admin` invece che a mano nel
  JSON.
