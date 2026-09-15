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
| P4 | CRUD sponsor e upload loghi | fatto, verificato in locale contro Azurite |
| P4b | Contenuti della home editabili | fatto, verificato in locale contro Azurite |
| P5 | Integrazione Meetup e filtro temporale eventi | da fare, è il prossimo |
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
- `api/src/lib/image.js` + `POST /api/assets` — **anticipati dalla P4**. Cap 512
  KB, allowlist di content-type verificata sui **byte** (un `.exe` rinominato
  `.png` viene fermato lì), nome con l'impronta del contenuto, SVG sanificati e
  salvati con `Content-Disposition: attachment`. L'endpoint è già generico:
  accetta `kind: 'sponsor'`, quindi la P4 non ci torna sopra.
- Editor del team in `/admin`, con riordino, anteprima, errori accanto al campo,
  gestione del 409 e bottone **Carica** per la foto (`admin/upload.js`, scritto
  per essere riusato dall'editor sponsor).
- `scripts/seed-blob.mjs` + `npm run seed` — carica `src/data/*.json` sul blob.
  Serviva: il provisioning crea i container ma non ci mette dentro niente.
- `src/assets/js/config.js` legge dal container pubblico; `127.0.0.1:10000`
  aggiunto a `connect-src` e `img-src` allargato a `https:` nella CSP.
- 73 test (`npm test`), nessuna dipendenza di test: `node --test` e uno store
  finto con lo stesso contratto di `blob.js`.

Verificato end-to-end sull'emulatore contro Azurite: `GET` con ETag, `PUT` che
ripubblica, secondo `PUT` con lo stesso ETag → **409 con la copia del server**,
payload sporco → **400 con le issues per campo**, anonimo su `/api/team` → login.
La copia pubblica esce con `Cache-Control: public, max-age=300,
stale-while-revalidate=86400` e l'`ETag` giusto.

Anche l'upload: PNG caricato → 201 con la URL, sul blob con
`max-age=31536000, immutable`; SVG con `onload` e `<script>` → salvato **senza**
né l'uno né l'altro e con `Content-Disposition: attachment`; `.exe` rinominato
`.png` → 415; 600 KB → 413; anonimo → login.

## Cosa è entrato con la P4

Poco codice nuovo: quasi tutto era già lì dalla P3, ed è stato messo in comune
invece che copiato.

- `api/src/lib/document.js` — il contratto GET/PUT (ETag, 409 con la copia del
  server, ripubblicazione) estratto da `team.js`. Team e sponsor sono due righe
  di configurazione sopra lo stesso modulo: `team.js` è passato da ~120 righe a
  30, e `sponsors.js` ne è costato altrettante.
- `validateSponsors` accanto a `validateTeam`, sopra uno scheletro comune.
  `since` vuole un anno e non una data; `logoUrl` è obbligatoria, perché senza
  la card sarebbe un rettangolo vuoto.
- `src/assets/js/admin/collection-editor.js` — stessa operazione lato browser.
  Gli editor sono ora la sola *forma* dei dati (`fill`, `collect`, `preview`);
  riordino, conflitto, errori per campo e upload stanno in un posto solo.
- Editor sponsor in `/admin`, con due caricatori di logo (normale e per fondo
  scuro).
- `render-sponsors.js` raggruppa per fascia e il CSS dimensiona il logo dal
  `data-tier`. Uno sponsor con una fascia sconosciuta **non sparisce**: finisce
  fra i Partner. Il sito pubblico non valida niente, e far scomparire in
  silenzio chi ci sostiene sarebbe il modo peggiore di reagire a un dato
  inatteso.
- `npm run seed` crea anche il master `site-data/sponsors.json`.
- 90 test.

Verificato end-to-end sull'emulatore: `GET /api/sponsors` con ETag, `PUT` che
ripubblica, secondo `PUT` con lo stesso ETag → 409 con la copia del server,
`tier` inventato e `since: "ieri"` → 400 con quattro issues sul campo giusto.

## Cosa è entrato con la P4b

Anticipata mentre l'accesso a Meetup non c'era ancora. Rende editabile quello
che restava scritto a mano dentro `index.html`: **foto principale**, logo,
**"Chi siamo"**, le due **statistiche** e il **footer** (introduzione, email,
riga legale, canali e profili social).

- `site.json` + `GET/PUT /api/site` + `validateSite`. Tutti i campi sono
  facoltativi, e non è una scorciatoia: vedi la regola qui sotto.
- `src/assets/js/render-site.js` — **quello che non arriva non si tocca**.
  L'HTML conserva i testi attuali e il JavaScript sovrascrive solo ciò che
  riceve. Tre motivi: la pagina funziona senza JavaScript, i crawler e le
  anteprime dei link vedono contenuto vero, e se il blob tace il sito non
  diventa una pagina di scheletri. Il rovescio, da dire a chi la usa:
  **svuotare un campo dall'admin non cancella il testo dal sito**, lo riporta a
  quello dell'HTML.
- `src/assets/js/admin/editor-core.js` — il nucleo dei tre editor. La P4 aveva
  già messo in comune le liste; qui serviva anche un modulo con dentro tre
  listine, quindi il nucleo è diventato generico: le liste si dichiarano col
  nome che hanno nel documento (`data-list="footer.channels"`), così un errore
  su `footer.channels[0].url` trova da solo la sua riga senza configurazione.
- `POST /api/assets` accetta un terzo `kind`, `site`, per foto e logo.
- Terza scheda **Home e footer** nell'admin, con anteprima delle due immagini.
- Il **titolo della scheda** del browser è `brand.name | brand.tagline` (o il solo
  nome se la tagline manca: sono due campi perché il nome compare anche nella
  barra in alto e nel footer, dove un "| Community" appiccicato dietro sarebbe
  sbagliato), e la **favicon** è `brand.logoUrl`. Entrambi restano scritti anche
  nell'HTML, che è quello che vedono i crawler e le anteprime dei link.
- 107 test.

Il testo di "Chi siamo" ha l'apertura in grassetto come campo separato
(`about.lead`), ed **ammette `**grassetto**` e `[link](url)`** nel corpo —
serviva a segnalare l'iscrizione al prossimo evento senza toccare il repo.

Non è HTML, ed è una scelta precisa: `src/assets/js/rich-text.js` scappa tutto
e poi reintroduce solo il markup che ha generato lui. Accettare HTML nel
textarea avrebbe voluto dire rinunciare all'escaping proprio dove il testo è
modificabile, e sanificarlo a valle è un lavoro che basta sbagliare una volta
per aprire un buco (lo si era già visto con gli SVG). Il server rifiuta con un
400 i link che puntano altrove che a `https://`, a un percorso del sito o a una
sezione; il rendering pubblico, se uno passa lo stesso, lo degrada a testo.

Limite noto: un link dentro il grassetto funziona, il grassetto dentro il testo
di un link no.

## Passata sul mobile

`layout.css` non aveva **nessuna** media query: il sito era disegnato a 1280 px
e basta. Su un telefono i cinque link della barra finivano fuori schermo, e
`overflow-x: hidden` sul body lo nascondeva invece di segnalarlo.

- Menu a pannello sotto i 900 px (`src/assets/js/nav.js`): si chiude da solo
  dopo aver scelto una voce, con Esc, toccando fuori e tornando a schermo largo.
- Logo e imbottitura della testata rimpiccioliti su mobile. Le misure stanno in
  `main.js` e non nel CSS perché quella funzione scrive **stili inline**, che
  batterebbero qualunque media query.
- Altezza della hero in una variabile, in `svh` dove supportato: `vh` su mobile
  è la finestra a barre nascoste (la foto risulta più alta dello schermo),
  `dvh` cambia in continuazione mentre le barre entrano ed escono e fa saltare
  una hero `position: fixed`.
- Sponsor due per riga, bottoni del footer a tutta larghezza, frecce del
  carosello nascoste (c'è lo swipe), paragrafo di "Chi siamo" allineato a
  sinistra: dieci righe centrate su schermo stretto sono sfrangiate da
  entrambi i lati.

### Tre bug trovati guardando, non leggendo

Nessuno dei tre era solo mobile.

1. **La CSP bloccava il font delle frecce di Swiper.** `swiper-bundle.min.css`
   imbarca il glifo come URL `data:`, e `font-src` non la ammetteva: le frecce
   del carosello eventi erano vuote **dalla P0**, su ogni schermo. Aggiunto
   `data:` a `font-src`.

2. **Il footer finiva sotto la hero.** Sta fuori da `<main>` ed era
   `position: static`: un elemento `position: fixed` con z-index 0 dipinge
   sopra uno statico, quindi arrivati in fondo il rettangolo nero della hero
   copriva metà footer. Anche questo su ogni schermo.

3. **I loghi sponsor venivano tagliati.** Gli SVG scrivono il nome con
   `font-family="Inter, …"`, ma caricati dentro un `<img>` sono un documento
   isolato che **non può usare il font della pagina**: cadono su un font di
   sistema più largo, e il `viewBox` (che per un `<svg>` esterno vale
   `overflow: hidden`) tagliava la coda della parola. Risolto con
   `textLength` + `lengthAdjust`, che fissa la larghezza qualunque font ci sia.

Mancavano anche gli `scroll-margin-top`: arrivando da un'ancora il titolo della
sezione finiva sotto la testata fissa — cioè proprio usando il menu nuovo.

### Come guardare

Nel devcontainer non c'è un browser, ma si installa in un minuto e serve
esattamente a questo (i tre bug sopra erano invisibili leggendo il codice):

```bash
npm i -D playwright-core && npx playwright install chromium
sudo npx playwright install-deps chromium
```

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
| Foto e loghi | Si **caricano**, non si linkano: finiscono sul nostro storage. Il campo URL resta scrivibile per chi ha già l'immagine altrove, e per questo `img-src` è `https:` |
| Fascia sponsor | È l'unico dato che governa dimensione del logo, raggruppamento e ordine. Aggiungere uno sponsor non deve mai voler dire toccare il CSS |
| Contenuti della home | L'HTML resta il fallback e il JavaScript sovrascrive solo ciò che riceve: la pagina deve avere senso senza JavaScript e non svuotarsi se il blob tace |

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

2. **I contenuti veri non ci sono.** Gli 11 membri del team e i 6 sponsor sono
   inventati, foto e loghi compresi. Gli editor ci sono e il caricamento
   funziona: **servono i nomi, le foto delle persone e i loghi degli sponsor**.
   Da lì in poi si fa tutto da `/admin`, senza toccare il repo.

3. **Gli editor sponsor e "Home e footer" non sono mai stati aperti in un
   browser.** Quello del team sì, upload compreso. Il lato server è verificato
   con curl (200 con ETag, 409, 400 con le issues) e il cablaggio DOM a
   tavolino — uno script confronta ogni `id`, `data-field`, `data-list` e
   `data-add` usato dal JavaScript con quello che c'è nel markup — ma le pagine
   no. Il **sito pubblico** invece è stato guardato davvero, con un browser
   headless (vedi *Passata sul mobile*): quello che resta scoperto sono le due
   schede nuove dell'admin.

4. **Logo e hero puntano a URL esterne volatili** (CDN di LinkedIn e Unsplash).
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

## Prossimo passo: P5

Eventi da Meetup. È la fase con più incognite esterne di tutte.

- **Prima di scrivere codice: provare la query nel playground.**
  `Group.pastEvents` e `upcomingEvents` sono stati rimossi dopo febbraio 2025;
  con l'account Pro si passa da
  `proNetwork(urlname).eventsSearch(input:{filter:{status:…}})`. Finché la query
  non torna dati veri, tutto il resto è congettura.
- `meetup/jwt.js` + `token.js`: il JWT si firma con `node:crypto`, senza
  librerie. Il token va in cache su `site-data/_cache/meetup-token.json` e si
  riusa finché mancano più di 300 s alla scadenza.
- `meetup/query.js` + `map.js`: la query sta in un modulo solo, e `map.js`
  traduce la risposta nello schema di `public/events.json`. `id` è una **stringa
  opaca**: gli id Meetup sembrano numeri ma non vanno parsati come tali.
- `POST /api/refresh-events`: accetta **o** un principal `admin` **o** l'header
  `x-refresh-token` confrontato con `crypto.timingSafeEqual`. No-op dentro il
  TTL di un'ora, forzabile con `?force=1`. **Su qualsiasi errore Meetup si serve
  l'ultimo `public/events.json` buono e si risponde 200**: un breaking change
  dello schema Meetup non deve mai svuotare il sito.
- `.github/workflows/refresh-events.yml`: cron ogni 6 ore. Serve perché le
  managed functions sono **solo HTTP**, dentro SWA non esiste timer trigger.
- Poi il nuovo rendering eventi e il filtro `Prossimi | Passati` con le chip per
  anno, disegnato in [docs/piano.md](piano.md), sezione *Filtro temporale*.

Attenzione: questa è la prima fase che **non** si può verificare davvero con
l'emulatore, perché dipende da credenziali vere. `MEETUP_MOCK=true` in
`api/local.settings.json` serve a sviluppare il resto senza chiamare Meetup.

## Cose lasciate indietro di proposito

- **Sessioni/talk**: fuori scope. Rientrerebbero come `sessions.json` con lo
  stesso schema di `team.json`, collegate agli eventi tramite l'id Meetup.
- **SEO degli eventi**: spostandoli su rendering client-side sono diventati
  invisibili ai crawler senza JS e alle anteprime dei link su LinkedIn e
  WhatsApp. Recuperabile in P6 con uno snapshot statico generato dal job di
  refresh.
- **I 6 sponsor sono finti** (CloudNova, TechFlow, …), come i loghi. Adesso
  l'editor c'è: vanno sostituiti con quelli veri, e **servono i loghi**.
- **Gli 11 membri del team sono placeholder** con foto Unsplash, tranne forse
  Matteo Contessa. Adesso però si correggono da `/admin` invece che a mano nel
  JSON.
