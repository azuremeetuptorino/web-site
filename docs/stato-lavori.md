# Stato dei lavori

Aggiornato al **22 settembre 2026**. Documento di ripresa: serve a ricominciare
da dove si è lasciato senza rileggere tutto.

Piano completo: [docs/piano.md](piano.md).
Note sulla configurazione SWA: [docs/configuration.md](configuration.md).
Provisioning e deploy: [docs/deploy.md](deploy.md).

## Dove siamo

Branch **`feat/azure-static-web-apps`**, mai pushato.

| Fase | Contenuto | Stato |
|---|---|---|
| P0 | Refactor statico, contenuti su JSON | fatto, verificato |
| P1 | Configurazione SWA, pagine di errore, CI/CD | fatto, **in produzione su swa-meetup** |
| P2 | `/admin` e autenticazione Entra ID | fatto, verificato con l'emulatore |
| P3 | CRUD team su Blob Storage | fatto, verificato in locale contro Azurite |
| P4 | CRUD sponsor e upload loghi | fatto, verificato in locale contro Azurite |
| P4b | Contenuti della home editabili | fatto, verificato in locale contro Azurite |
| P5 | Eventi dall'admin, importazione dal link Luma/Meetup | fatto, API verificate contro Azurite e le pagine vere |
| P5b | Cinque eventi in home, archivio filtrabile su `/eventi/` | fatto, **guardato in un browser** |
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

## Cosa è entrato con la P5

**Cambio di rotta rispetto al piano.** La P5 doveva tirare giù gli eventi
dall'API GraphQL di Meetup con un cron. Due fatti l'hanno resa inutile: la
**chiave API Meetup non c'è**, e la community pubblica gli eventi **anche su
Luma**. Gli eventi sono quindi diventati un documento come team e sponsor, con
una scorciatoia che rende il lavoro a mano quasi nullo.

- `GET/PUT /api/events` — `createDocumentResource` su `events.json` con
  `validateEvents`: trenta righe, come `sponsors.js`. Il seed è passato a
  `master: true`, quindi `npm run seed` crea anche `site-data/events.json`.
- `api/src/lib/event-import.js` + `POST /api/events/import` — dal **link
  pubblico** dell'evento alla scheda compilata. Entrambe le piattaforme
  incorporano un blocco **JSON-LD `schema.org/Event`** (titolo, `startDate`,
  `endDate`, `location`, `image`, `description`, `url`): lo si legge da lì,
  senza API né chiavi, con un parser unico. Poi due integrazioni
  opportunistiche dal `__NEXT_DATA__`: da Meetup la descrizione completa (il
  JSON-LD la tronca a 150 caratteri) e il venue pulito; da Luma il fuso e il
  **nome della sala** (`geo_address_info.description`, "Aula 10 dell'ITS ICT
  Piemonte"), che nel JSON-LD non c'è. Se quel formato cambia si perde il
  dettaglio e resta il JSON-LD.
- **Difese della function**: si contattano solo `luma.com`, `lu.ma` e
  `meetup.com`, **redirect compresi** (seguiti a mano con `redirect: 'manual'`),
  timeout di 10 s, lettura fino a 3 MB. Senza, `/api/events/import` sarebbe un
  proxy verso qualunque indirizzo, inclusi quelli interni alla rete di Azure.
  Ogni errore ha il suo codice (`host-not-allowed`, `no-event-found`,
  `upstream-timeout`, …) e l'editor lo traduce in italiano.
- L'`id` viene dalla piattaforma: `luma-2ffi3qjx`, `meetup-316647090`.
  Reimportando lo stesso link (o lo stesso `eventUrl`) l'editor **aggiorna la
  scheda esistente** invece di creare un doppione, conservando l'id salvato.
- Schema: `id`, `title`, `dateTime` e `endTime` **in UTC** sul blob, `timezone`
  (default `Europe/Rome`) per scrivere l'ora italiana a chi guarda da altrove,
  `isOnline`, `eventUrl`, `imageUrl`, `excerpt` (max 300), `venue
  {name,address,city}`, `active`. Via `status`, `going`, `group`, `source`.
- `editor-core.js` ora **espone** `add`, `refill`, `rows`, `value`, `setAlert`,
  `clearAlert`, `markDirty`, `handleError`: servono alla barra di importazione,
  che vive accanto alla lista ma fuori dalle sue convenzioni. `autoSlug`
  accetta il nome del campo sorgente (`'title'`), non più solo `name`.
- Quarta scheda **Eventi** nell'admin. L'ordine in lista è dal più recente;
  le date si modificano con `datetime-local` nell'ora del computer di chi
  modifica. `POST /api/assets` accetta `kind: 'event'` per una copertina nostra.
- Il rendering pubblico mostra **data e luogo** sulla card (`<time datetime>`,
  ora nel fuso dell'evento) e salta gli eventi con `active: false`. Il carosello
  resta: cambiarlo è la P5b.
- **Trovato per strada:** il link "Seguici su Meetup" del sito, `MEETUP_GROUP_URL`
  e il testo di "Chi siamo" puntavano a `azure-meetup-torino`, che oggi apre la
  pagina di **un altro gruppo**. Il gruppo vero è
  `meetup-microsoft-azure-torino`. Corretti tutti e tre.
- Via da `local.settings` le chiavi `MEETUP_*` e `REFRESH_TOKEN`: non le legge
  più nessuno.
- 167 test. Le fixture di `event-import.test.js` sono le **pagine vere** di Luma
  e Meetup ridotte ai soli dati strutturati (5 KB invece di 130): se una
  piattaforma cambia qualcosa che conta, il test fallisce; se cambia un banner,
  no.

Verificato contro le pagine vere (`luma.com/2ffi3qjx` e l'evento Meetup
`316647090`, che sono lo stesso evento): stessa data e ora, stesso indirizzo,
`id` stabile, l'estratto Meetup senza `\|` e grassetti. Sull'emulatore: `GET`
con ETag, `PUT` che ripubblica, import reale da Luma → 200 con la scheda, host
esterno → 400 con la lista degli host ammessi.

## Cosa è entrato con la P5b

La home mostrava tutti gli eventi in un carosello. Con un evento al mese
quell'elenco diventa una fila che si trascina, senza mai vederne l'insieme:
adesso in home ce ne sono **cinque** e il resto sta su **`/eventi/`**.

- `src/eventi/index.html` — pagina vera, servita da SWA senza nessuna route
  nuova (`/eventi` → 301 → `/eventi/`, ci pensa `trailingSlash: auto`). Testata
  e footer sono quelli della home e si popolano dallo stesso `site.json`;
  `renderSite` ha preso un'opzione `title: false`, perché qui il titolo della
  scheda è quello della pagina e non `brand.name | tagline`.
- `render-events.js` è diventato **una card sola in due involucri**: la slide
  del carosello e la cella della griglia, che in più mostra la descrizione.
  `renderEvents(..., { limit: 5 })` è tutto quello che distingue la home.
- `events-filter.js` — la logica pura: `splitEvents`, `yearsOf`, `selectEvents`,
  `readFilter`, `filterToSearch`. Sta a parte per poterla provare senza browser,
  ed è il file da leggere per sapere cosa si vede quando.
- `events-page.js` — il DOM della pagina: segmentato `Prossimi | Passati` come
  `role="tablist"` con le frecce, chip per anno come `aria-pressed`, "Mostra
  altri" 12 alla volta, stato nella **query string**
  (`?stato=passati&anno=2025`) via `replaceState`.
- `events.css` + `.page-inner` in `layout.css`: le pagine interne non hanno la
  foto alta 65% dello schermo, e la testata è opaca dall'inizio con le misure
  ferme (in home le scrive `main.js` mentre si scorre).
- `email-copy.js` — la barra dell'email era dentro `main.js`, ma il footer c'è
  su tutte le pagine e una barra che non copia niente è peggio di una assente.
- 188 test: 21 nuovi in `api/test/events-view.test.js`, che coprono i cinque
  della home, l'ordine, l'escaping della card, gli anni e il filtro.

### Tre cose trovate guardando, non leggendo

Il browser headless (vedi *Come guardare*) è servito di nuovo.

1. **Le card del carosello erano di altezze diverse.** Swiper mette le slide a
   `height: 100%`, che dentro un contenitore di altezza automatica significa
   "quanto il tuo contenuto": la fila finiva sfrangiata, e il luogo in fondo
   alla card non si allineava. `.swiper-events .swiper-slide { height: auto }`
   e il flex le stira tutte quanto la più alta. Era così **da sempre**, si
   notava poco perché la card aveva solo il titolo.
2. **`text-transform: capitalize` scriveva "Ven 16 Ott 2026".** In italiano il
   mese è minuscolo. Ora la maiuscola è solo la prima, con `::first-letter`.
3. **`hidden` non è garantito.** Basta una regola del foglio che dia un
   `display` a un elemento perché l'attributo smetta di funzionare: lo stile
   dell'autore batte quello del browser. Aggiunta `[hidden] { display: none
   !important }` in `base.css`, che copre anche i casi futuri.

Verificato nel browser, a 1280 e a 390 px: cinque card in home con le altezze
allineate e il bottone con il totale; il click porta su `/eventi/`; segmentato,
chip e "Mostra altri" (provati con 25 eventi finti su quattro anni, iniettati
con `page.route`); link profondo `?stato=passati&anno=2023` che riapre la
pagina dov'era; nessun evento futuro → messaggio con il link a Meetup; blob che
risponde 500 → messaggio e pagina ancora in piedi; nessuno scorrimento
orizzontale su telefono; console pulita.

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
| Cosa si gestisce da `/admin` | **Team, sponsor, eventi e contenuti della home**. Non le sessioni. |
| Eventi | **Dall'admin**, come team e sponsor, importandoli dal **link pubblico** Luma o Meetup (JSON-LD). Niente API Meetup: la chiave non c'è e gli eventi stanno anche su Luma. Il cron di refresh non esiste più |
| Piattaforme importabili | Solo gli host in `ALLOWED_HOSTS` (`luma.com`, `lu.ma`, `meetup.com`). Aggiungerne una è una riga, purché la pagina esponga JSON-LD `Event` |
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
- Le pagine pubbliche di **Luma e Meetup incorporano JSON-LD
  `schema.org/Event`** (verificato il 21/09/2026 su `luma.com/2ffi3qjx` e
  sull'evento Meetup `316647090`). Meetup tronca `description` a 150 caratteri
  nel JSON-LD; quella completa sta in `__NEXT_DATA__ → __APOLLO_STATE__ →
  Event:<id>`. Luma mette fuso e nome della sala in `__NEXT_DATA__ →
  props.pageProps.initialData.data.event`. Meetup serve la pagina completa solo
  a uno `User-Agent` da browser.
- (Storico, non più usato) Meetup GraphQL: endpoint
  `https://api.meetup.com/gql-ext`, `Group.pastEvents`/`upcomingEvents` rimossi
  dopo febbraio 2025, con l'account Pro si passa da `proNetwork(urlname)`.

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

1. ~~**Le risorse Azure non esistono.**~~ **Risolto.** `provision-azure.ps1` è
   stato lanciato su `rg-lrizzi-meetup`: esistono `swa-meetup` (West Europe) e
   `stazuremeetuptorino2` (italynorth) con i container `public` e `site-data`,
   CORS, versioning e soft delete. L'app setting `DATA_STORAGE_CONNECTION` è
   impostata, il seed è passato e `STORAGE_ACCOUNT` e la CSP sono allineati.
   Nessuna Azure Policy vietava l'accesso anonimo, quindi la lettura dal blob
   con ETag è rimasta com'era progettata.

   Il repo è collegato via secret da CLI e non dal portale, per non farsi
   generare da Azure un secondo workflow: vedi [deploy.md](deploy.md#3-collegare-il-repo).
   Il primo deploy è passato e il sito è su
   `https://icy-coast-028c85103.5.azurestaticapps.net` — home 200 con CSP e
   header di sicurezza, `/eventi/` 200, `/admin/` e `/api/*` 302 al login,
   404 sulla pagina inesistente, e la fetch del blob dall'origin del sito
   risponde 200 con `Access-Control-Allow-Origin` ed ETag.

2. **I contenuti veri non ci sono.** Gli 11 membri del team e i 6 sponsor sono
   inventati, foto e loghi compresi. Gli editor ci sono e il caricamento
   funziona: **servono i nomi, le foto delle persone e i loghi degli sponsor**.
   Da lì in poi si fa tutto da `/admin`, senza toccare il repo.

3. **Della `/admin` resta da guardare la barra di importazione.** Il log
   dell'emulatore mostra la pagina aperta in un browser con tutti e quattro gli
   editor che caricano i loro dati (`/api/me`, team, sponsor, eventi, site), e
   gli sponsor sono stati modificati davvero. Quello che nessuno ha ancora
   provato in una pagina vera è **incollare un link e premere Importa**, con le
   `datetime-local` che si riempiono. Il cablaggio DOM è controllato da uno
   script (ogni `data-field` e `data-preview` usato dal JavaScript esiste nel
   template e viceversa) e le API con curl. Il **sito pubblico**, eventi
   compresi, è stato guardato in un browser. Il lato server è verificato
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

## Prossimo passo: P6

Restano due cose piccole prima delle fasi vere:

- **Importare un evento dalla `/admin` in un browser** (bloccante 3): incollare
  il link Luma, controllare le date, salvare, vedere la card sul sito. Ora si può
  fare in produzione, non più solo contro Azurite.
- **Invitare il primo `admin`** dal portale (Role management > Invite): finché
  non c'è nessuno col ruolo, `/admin` risponde 403 a chiunque, anche a chi ha
  creato le risorse.

Poi la P6: Application Insights — la risorsa `appi-meetup` è già in
`rg-lrizzi-meetup`, con la connection string pronta —, `robots.txt`,
`sitemap.xml` (ora ci sono due URL da dichiarare, `/` e `/eventi/`), tag Open
Graph, passata Lighthouse e axe.

Sulla SEO degli eventi la situazione è cambiata a metà: `/eventi/` **è un
indirizzo vero**, condivisibile e indicizzabile, ma le card le disegna ancora il
JavaScript. Lo snapshot statico generato al salvataggio resta l'idea giusta, e
ora ha una pagina dove atterrare invece di doverla inventare.

## Cose lasciate indietro di proposito

- **Sessioni/talk**: fuori scope. Rientrerebbero come `sessions.json` con lo
  stesso schema di `team.json`, collegate agli eventi tramite il loro `id`.
- **Altre piattaforme (Eventbrite, …)**: basta l'host in `ALLOWED_HOSTS`, se la
  pagina espone JSON-LD `Event`. Non fatto perché oggi non serve.
- **Scaricare la copertina sul nostro storage**: oggi `imageUrl` punta al CDN di
  Luma o Meetup (`img-src https:` lo ammette). Se una piattaforma cambiasse le
  URL, la card ripiega sul segnaposto; il bottone **Carica** c'è già per
  metterci un file nostro.
- **SEO degli eventi**: le card le disegna il JavaScript, quindi restano
  invisibili ai crawler senza JS e alle anteprime dei link su LinkedIn e
  WhatsApp. Con la P5b almeno l'archivio ha un indirizzo suo (`/eventi/`).
  Recuperabile in P6 con uno snapshot statico scritto al salvataggio.
- **Ricerca testuale nell'archivio**: rimandata a quando gli eventi passeranno
  la quarantina. Prima di allora si trova prima guardando che scrivendo.
- **Una card grande per l'evento unico in arrivo**: la griglia con una card sola
  si legge già bene, e sarebbe un secondo layout da mantenere per un caso solo.
- **I 6 sponsor sono finti** (CloudNova, TechFlow, …), come i loghi. Adesso
  l'editor c'è: vanno sostituiti con quelli veri, e **servono i loghi**.
- **Gli 11 membri del team sono placeholder** con foto Unsplash, tranne forse
  Matteo Contessa. Adesso però si correggono da `/admin` invece che a mano nel
  JSON.
