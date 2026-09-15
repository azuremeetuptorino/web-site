# Azure Meetup Torino — da bozza statica a sito su Azure Static Web Apps

## Context

Oggi il repo è una bozza: un solo `index.html` (1136 righe, CSS e JS inline) con team, eventi e sponsor scritti a mano nel markup, più `LICENSE`. Nessun build, nessun dato, nessuna configurazione Azure, nessuna area di amministrazione. Ogni modifica a una persona o a uno sponsor richiede di editare HTML duplicato e fare un commit — e i 6 sponsor attuali sono placeholder inventati con il logo disegnato come SVG inline, quindi inserire uno sponsor vero oggi significa scrivere markup a mano.

L'obiettivo è un sito pubblicato su **Azure Static Web Apps (piano Free)** in cui:
- gli **eventi** arrivano automaticamente da **Meetup** (account Pro disponibile), con un filtro temporale usabile sull'archivio;
- **team** e **sponsor** sono modificabili da una pagina **`/admin`** protetta dall'autenticazione integrata di SWA (Entra ID), logo e avatar inclusi;
- i dati sono **semplici file JSON**, senza database, su **Azure Blob Storage**;
- il frontend resta **statico vanilla, senza build step**.

Costo a regime: SWA Free €0, Storage ≈ €0,05/mese, GitHub Actions gratis su repo pubblico.

### Vincoli verificati (non negoziabili, condizionano il design)

| Vincolo | Conseguenza |
|---|---|
| Su SWA **Free** funzionano provider preconfigurati, ruoli custom via **inviti** (max 25 utenti) e `allowedRoles`. Solo "assegna ruoli con una function" è Standard. | `/admin` protetta gratis. |
| Il provider `aad` preconfigurato è **multi-tenant + account Microsoft personali**: chiunque può *autenticarsi*. | L'autorizzazione è il vero cancello: ruolo `admin` assegnato solo per invito. Serve una pagina 403 decente in italiano. |
| SWA **non mette in cache le risposte `/api`** e `globalHeaders` non le tocca. Le managed functions sono su Consumption: **cold start 1–3 s**. | Il sito pubblico **non** deve leggere i dati da `/api`. Legge direttamente dal container blob pubblico. |
| Le **managed functions di SWA non supportano Managed Identity**, né Key Vault references. | Connection string dello storage in una **app setting** SWA (`DATA_STORAGE_CONNECTION`). Account storage dedicato, niente altro dentro. |
| Prefissi di app setting riservati: `AZUREBLOBSTORAGE_`, `WEBSITE_`, `FUNCTIONS_`, `AzureWeb`, … | Mai chiamare il setting `AzureWebJobsStorage` o `AZUREBLOBSTORAGE_*`. |
| Le route rules **non** si applicano alle richieste servite da `navigationFallback`. | `/admin/index.html` deve essere un file reale e `/admin/*` va in `exclude`. |
| L'accesso anonimo ai blob è **disabilitato di default** (account + container). | **Gate di P1**: verificare che nessuna Azure Policy blocchi `AllowBlobPublicAccess`. Se è bloccato, fermarsi e passare al piano B (`/api/public/*` con cold start accettato). |
| Meetup: endpoint **`https://api.meetup.com/gql-ext`**, 500 punti/60 s. `Group.pastEvents`/`upcomingEvents` **rimossi** dopo feb-2025 a favore di `events(filter:)`. | Con l'account Pro si usa il percorso documentato `proNetwork(urlname).eventsSearch(input:{filter:{status:…}})`. Query isolata in un solo modulo. |

---

## Architettura

```
Browser pubblico ──► SWA CDN (HTML/CSS/JS statici)
        └─────────► https://<account>.blob.core.windows.net/public/{team,sponsors,events}.json
                    + /public/{avatars,sponsors}/…          (lettura anonima, ETag/304)

Browser /admin ────► SWA (allowedRoles: admin, Entra ID)
        └─────────► /api/* (managed functions) ──► container privato `site-data` (master + cache)
                                               └─► ripubblica su `public/` ad ogni salvataggio

GitHub Actions cron (ogni 6h) ──► POST /api/refresh-events ──► Meetup gql-ext ──► public/events.json
```

Due container in un account storage dedicato:
- **`public`** — access level `Blob`, CORS a livello di servizio `GET/HEAD/OPTIONS`, origins `*`, exposed headers `ETag, Content-Length`. Contiene `team.json`, `sponsors.json`, `events.json`, `avatars/`, `sponsors/`.
- **`site-data`** — privato. Contiene i master `team.json`, `sponsors.json` e `_cache/`.

CORS con origins `*` e non una allowlist: la CORS dei blob è a livello di **servizio**, non di container, e gli ambienti di preview di SWA ottengono hostname `*.azurestaticapps.net` casuali che romperebbero qualsiasi allowlist. I dati sono pubblici per definizione, `*` non costa nulla.

Attivare su questo account **blob versioning + soft delete 7 giorni**: costo nullo, assicurazione contro un `PUT` sbagliato dall'admin.

---

## Struttura del repo

```
/
├─ .github/workflows/
│  ├─ azure-static-web-apps.yml      # deploy
│  └─ refresh-events.yml             # cron Meetup
├─ src/                              # app_location — caricato verbatim, nessun build
│  ├─ index.html
│  ├─ 403.html  404.html
│  ├─ staticwebapp.config.json
│  ├─ admin/index.html
│  └─ assets/
│     ├─ css/    tokens.css base.css layout.css components.css events.css admin.css
│     ├─ js/     config.js data.js render-team.js render-sponsors.js render-events.js
│     │          events-filter.js swiper-init.js main.js
│     │          admin/  api.js team-editor.js sponsors-editor.js upload.js app.js
│     ├─ img/    logo.svg og.png placeholder-avatar.svg placeholder-event.svg placeholder-logo.svg
│     └─ vendor/ swiper-bundle.min.{css,js}  bootstrap-icons/
├─ api/                              # api_location — unico punto con npm install
│  ├─ host.json  package.json  local.settings.json(gitignored)
│  └─ src/
│     ├─ functions/ me.js team.js sponsors.js assets.js refreshEvents.js
│     └─ lib/       blob.js auth.js validate.js image.js http.js
│                   meetup/ jwt.js token.js query.js map.js
├─ data/
│  ├─ schema/ team.schema.json sponsors.schema.json events.schema.json
│  └─ seed/   team.json sponsors.json events.sample.json
├─ docs/  deploy.md meetup-setup.md runbook.md
├─ swa-cli.config.json
├─ package.json                      # solo devDeps: @azure/static-web-apps-cli, azurite
└─ .gitignore  README.md  LICENSE
```

---

## Frontend (P0) — refactor senza build

Lo split di `index.html` è il passo a più alto rischio di regressione: va fatto **da solo**, prima di qualunque cosa cloud, con verifica pixel-identica.

- CSS attuale (righe 14–565) → `assets/css/*.css`, mantenendo le custom properties esistenti (`--azure-blue: #0078D4`, `--azure-dark`, `--color-meetup`, …) invariate in `tokens.css`.
- JS attuale (righe 1015–1135: `handleScroll`, `teamSwiper`, events Swiper, `copyEmail`) → `assets/js/*.js`.
- [index.html:995](index.html#L995) usa `onclick="copyEmail(this)"` inline: sostituire con `addEventListener`, altrimenti la CSP con `script-src 'self'` lo blocca.
- **Vendorizzare Swiper 11 e Bootstrap Icons** in `assets/vendor/`: sono file statici, non servono build, e rimuovono la dipendenza da jsDelivr permettendo `script-src 'self'`. Google Fonts resta via CDN (consentito in `style-src`/`font-src`).
- Membri, sponsor ed eventi hardcoded diventano `data/seed/{team,sponsors,events.sample}.json`, renderizzati client-side. I 6 loghi SVG inline degli sponsor placeholder (righe 904–969) vengono estratti in `src/assets/img/` come file `.svg` e referenziati per URL: da lì in poi il rendering è identico sia per i seed sia per i dati reali dal blob.
- `assets/js/config.js` risolve la base URL dei dati senza build step:
  ```js
  export const PUBLIC_DATA_BASE =
    ['localhost', '127.0.0.1'].includes(location.hostname)
      ? 'http://127.0.0.1:10000/devstoreaccount1/public'
      : 'https://<account>.blob.core.windows.net/public';
  ```
- `<link rel="preconnect" href="https://<account>.blob.core.windows.net" crossorigin>` in `<head>`.
- Se il fetch dei dati fallisce, **non** svuotare la sezione: lasciare il markup statico di fallback già presente.

### Filtro temporale eventi (scelta di design)

Segmentato a due stati **`Prossimi | Passati`**, deep-linkabile via `#eventi?stato=passati&anno=2025`.

- **`Prossimi`** → 0–3 card in flex row; con un solo evento diventa una card hero larga con data, venue, numero di iscritti e CTA diretta a Meetup.
- **`Passati`** → griglia responsive + riga di **chip per anno** (costruite da `new Set(events.map(e => e.dateTime.slice(0,4)))`) + bottone "Mostra altri" (client-side, 12 alla volta).

Perché così:
- Sono le due sole domande che porta chi arriva: "quando è il prossimo?" e "di cosa avete parlato?".
- **Il carosello va tolto dagli eventi.** Oggi è configurato `slidesPerView: 4` a ≥1024px: con 2 eventi futuri si vede una track mezza vuota con frecce morte. E per l'archivio, che cresce ogni mese, un carosello orizzontale è il peggior controllo possibile — nessuna visione d'insieme, ~8 drag per arrivare al 2023, niente tastiera, niente deep link. La griglia mostra l'ampiezza dell'archivio, che è esattamente il capitale sociale che il sito deve comunicare.
- **Chip per anno, non date picker**: la cadenza è mensile e si pensa "l'anno scorso", non "dal 3/4 al 17/9". Sono sei bottoni generati dai dati; un date picker sarebbe una libreria, un problema di locale e un'interazione che nessuno compie.
- **Ricerca testuale rimandata** a quando l'archivio supera ~40 eventi.
- Stati vuoti in italiano: nessun evento futuro → si seleziona `Passati` all'avvio e nello slot Prossimi resta una card *"Nessun evento in programma — seguici su Meetup per non perdere il prossimo."*
- Accessibilità (costa poco qui): segmentato come `role="tablist"` con `aria-selected` e frecce; chip come `<button aria-pressed>`; ogni card un `<article>` con `<time datetime="…">`; `prefers-reduced-motion` disattiva l'autoplay del marquee team (oggi `speed: 4000, delay: 0` è incondizionato ed è un trigger vestibolare).

Swiper resta **solo** su `#partecipanti`, dove il marquee è il controllo giusto.

### Sezione sponsor

Il layout attuale (griglia di card con logo + nome + descrizione) si conserva, ma diventa **raggruppato per tier**: i logo dei tier alti si rendono più grandi, quelli bassi in una fascia compatta. Il tier è l'unico dato che governa dimensione e ordine, così aggiungere uno sponsor non richiede mai di toccare il CSS.

---

## `src/staticwebapp.config.json`

L'ordine delle route conta: la valutazione si ferma alla prima corrispondenza, quindi `/api/me` e `/api/refresh-events` devono precedere `/api/*`.

```json
{
  "$schema": "https://json.schemastore.org/staticwebapp.config.json",
  "trailingSlash": "auto",
  "platform": { "apiRuntime": "node:20" },
  "routes": [
    { "route": "/login",  "rewrite": "/.auth/login/aad" },
    { "route": "/logout", "redirect": "/.auth/logout" },
    { "route": "/.auth/login/github", "statusCode": 404 },

    { "route": "/api/me", "methods": ["GET"], "allowedRoles": ["authenticated"] },
    { "route": "/api/refresh-events", "methods": ["POST"], "allowedRoles": ["anonymous"] },
    { "route": "/api/*", "allowedRoles": ["admin"] },

    { "route": "/admin", "redirect": "/admin/", "statusCode": 301 },
    { "route": "/admin/index.html", "allowedRoles": ["admin"], "headers": { "Cache-Control": "no-store" } },
    { "route": "/admin/*",          "allowedRoles": ["admin"], "headers": { "Cache-Control": "no-store" } },

    { "route": "/assets/vendor/*", "headers": { "Cache-Control": "public, max-age=31536000, immutable" } },
    { "route": "/assets/img/*",    "headers": { "Cache-Control": "public, max-age=2592000" } }
  ],
  "navigationFallback": {
    "rewrite": "/index.html",
    "exclude": ["/api/*", "/admin/*", "/assets/*", "/*.{png,jpg,jpeg,svg,webp,ico,txt,xml,json,webmanifest}"]
  },
  "responseOverrides": {
    "401": { "statusCode": 302, "redirect": "/.auth/login/aad?post_login_redirect_uri=/admin/" },
    "403": { "rewrite": "/403.html", "statusCode": 403 },
    "404": { "rewrite": "/404.html", "statusCode": 404 }
  },
  "globalHeaders": {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://secure.meetupstatic.com https://<account>.blob.core.windows.net; connect-src 'self' https://<account>.blob.core.windows.net; frame-ancestors 'none'; base-uri 'self'; form-action 'self' https://login.microsoftonline.com"
  }
}
```

`style-src` tiene `'unsafe-inline'` perché Swiper scrive stili inline e in `index.html` ci sono attributi `style=` (righe 978, 1008).

**Attenzione in `admin/api.js`**: il `responseOverrides` 401 è globale e non scopabile per route — a sessione scaduta una `fetch('/api/team')` riceve un 302 verso una pagina HTML di login, non un JSON. Il client deve trattare un content-type non-JSON da `/api` come "sessione scaduta → ricarica".

---

## API (`api/`, Node 20, modello v4, `authLevel: 'anonymous'`)

SWA è il cancello reale (le managed functions non hanno hostname pubblico), ma **ogni function ricontrolla il principal** leggendo e decodificando `x-ms-client-principal` e verificando `userRoles.includes('admin')` — ~10 righe in `lib/auth.js`. Una sola route rule messa in ordine sbagliato aprirebbe tutto in silenzio. Nota: la copia del principal lato API **non ha l'array `claims`**.

| Route | Metodo | Ruolo | Scopo |
|---|---|---|---|
| `/api/me` | GET | `authenticated` | eco del principal per l'header dell'admin |
| `/api/team` | GET / PUT | `admin` | master `site-data/team.json` |
| `/api/sponsors` | GET / PUT | `admin` | master `site-data/sponsors.json` |
| `/api/assets` | POST | `admin` | upload di un logo o avatar in `public/{sponsors,avatars}/` |
| `/api/refresh-events` | POST | `anonymous` in route rule, ma la function accetta **o** un principal `admin` **o** l'header `x-refresh-token` confrontato con `crypto.timingSafeEqual` | pull Meetup → pubblica `public/events.json`. Serve sia al cron sia al bottone "Aggiorna eventi" nell'admin |

**Contratti**

```
GET  /api/team  → 200 { "etag": "\"0x8DC…\"", "data": { … } }
PUT  /api/team    If-Match: "0x8DC…"
     → 200 { "etag": "…", "publishedAt": "…" }
     → 400 { "error": "validation", "issues": [{ "path": "members[3].name", "message": "obbligatorio" }] }
     → 409 { "error": "conflict", "etag": "…", "data": { …copia server… } }      // dal 412 dello storage
POST /api/assets   { "kind": "sponsor"|"avatar", "filename": "acme.svg",
                     "contentType": "image/svg+xml", "dataBase64": "…" }
     → 201 { "url": "https://<account>.blob.core.windows.net/public/sponsors/acme-a1b2c3.svg" }
     → 413 { "error": "too-large", "maxBytes": 524288 }
     → 415 { "error": "unsupported-type", "allowed": ["image/png","image/jpeg","image/webp","image/svg+xml"] }
POST /api/refresh-events
     → 200 { "refreshed": true,  "count": 34, "generatedAt": "…" }
     → 200 { "refreshed": false, "reason": "fresh", "age": 812 }
     → 200 { "refreshed": false, "reason": "meetup-error", "served": "stale" }   // mai 5xx
```

**Upload (`lib/image.js`)**: body JSON con base64 (niente multipart, niente dipendenze di parsing), cap **512 KB**, allowlist di content-type, nome file normalizzato + suffisso hash breve per evitare collisioni e cache stantia. Gli **SVG vengono sanificati** prima della scrittura — rimozione di `<script>`, `<foreignObject>`, attributi `on*` e `href`/`xlink:href` non-`#`: un `<img>` non esegue lo script di un SVG, ma il blob è raggiungibile per URL diretto e lì lo eseguirebbe. In alternativa l'admin può sempre incollare una URL `https:` già hostata, senza passare dall'upload.

**Concorrenza**: `lib/blob.js` incapsula il contratto — GET restituisce l'ETag, PUT lo rimanda in `If-Match`. Le function possono scalare su più istanze, quindi i lock in-process sono inutili; l'unica difesa è l'optimistic concurrency dello storage. Il 409 nell'admin mostra "modificato da qualcun altro" con la copia del server.

**Scritture**: ogni PUT valida, scrive il master privato e **ripubblica** il file su `public/` con
`blobHTTPHeaders: { blobCacheControl: 'public, max-age=300, stale-while-revalidate=86400', blobContentType: 'application/json; charset=utf-8' }`.

**Cache**:
- token Meetup → `site-data/_cache/meetup-token.json` `{ access_token, expires_at }`, riusato finché mancano >300 s alla scadenza;
- eventi grezzi → `site-data/_cache/meetup-raw.json` `{ fetched_at, ttl: 3600, payload }`; `/api/refresh-events` è no-op dentro il TTL (il bottone admin può forzare con `?force=1`);
- **su qualsiasi errore Meetup si serve l'ultimo `public/events.json` buono**. Un breaking change dello schema Meetup non deve mai svuotare il sito.
- risposte `/api`: `Cache-Control: no-store` impostato **dentro** la function (le `headers` delle route non arrivano alle risposte API).

**Validazione**: `lib/validate.js` scritto a mano (~80 righe). Niente `ajv`: è una dipendenza e un costo di cold start per pochi tipi di oggetto. I file in `data/schema/*.json` restano come documentazione e IntelliSense.

**Dipendenze npm in `api/`**: solo `@azure/functions` ^4 e `@azure/storage-blob` ^12. Il JWT si firma con `node:crypto`, senza librerie.

---

## Modelli dati

`site-data/team.json` (pubblicato tale e quale su `public/team.json`):

```json
{
  "version": 1,
  "updatedAt": "2026-09-15T10:12:00Z",
  "updatedBy": "alberto.annunziata@alveo.it",
  "members": [
    {
      "id": "elena-rossi",
      "name": "Elena Rossi",
      "nick": "@elena_cloud",
      "role": "Co-Founder",
      "roleKey": "co-founder",
      "bio": "Cloud Solution Architect & MVP. Serverless e AI.",
      "avatarUrl": "https://<account>.blob.core.windows.net/public/avatars/elena-rossi-a1b2c3.jpg",
      "link": { "type": "linkedin", "url": "https://www.linkedin.com/in/…" },
      "order": 10,
      "active": true
    }
  ]
}
```

Regole: `id` `^[a-z0-9][a-z0-9-]{1,48}$` univoco; `roleKey ∈ co-founder|organizer|core-team|speaker|staff` (pilota ordinamento e raggruppamento, mentre `role` è l'etichetta libera già renderizzata da `.member-role-tag`); `link.type ∈ linkedin|github|x|blog|website|mastodon|bluesky` mappato in JS su una classe Bootstrap Icons; `avatarUrl` solo `https:`; ordinamento per `order` poi `name`; `active:false` nasconde dal sito senza perdere lo storico.

`site-data/sponsors.json`:

```json
{
  "version": 1,
  "updatedAt": "2026-09-15T10:12:00Z",
  "updatedBy": "alberto.annunziata@alveo.it",
  "sponsors": [
    {
      "id": "acme-cloud",
      "name": "ACME Cloud",
      "tier": "gold",
      "logoUrl": "https://<account>.blob.core.windows.net/public/sponsors/acme-cloud-a1b2c3.svg",
      "logoDarkUrl": null,
      "websiteUrl": "https://acme.example",
      "description": "Partner infrastrutturale dal 2025.",
      "since": "2025",
      "order": 10,
      "active": true
    }
  ]
}
```

Regole: `tier ∈ gold|silver|bronze|partner|venue|media` — è l'**unico** dato che governa dimensione del logo, raggruppamento e ordine delle fasce, così aggiungere uno sponsor non tocca mai il CSS; ordinamento per `tier` poi `order` poi `name`; `logoUrl` obbligatoria e `https:`; `logoDarkUrl` opzionale per i loghi che scompaiono su fondo scuro; `websiteUrl` opzionale (se assente la card non è un link); `description` opzionale, max 200 caratteri; `active:false` sposta lo sponsor nello storico senza cancellarlo.

`public/events.json` (generato da Meetup):

```json
{
  "generatedAt": "…", "source": "meetup",
  "group": { "urlname": "azure-meetup-torino", "name": "Azure Meetup Torino", "link": "…" },
  "events": [{
    "id": "301234567", "title": "…", "status": "upcoming",
    "dateTime": "2026-03-12T18:30:00+01:00", "endTime": "…", "timezone": "Europe/Rome",
    "isOnline": false, "eventUrl": "…", "imageUrl": "…", "excerpt": "…", "going": 42,
    "venue": { "name": "Talent Garden", "city": "Torino", "address": "…" }
  }]
}
```

`id` è una **stringa opaca** (gli id Meetup sembrano numerici ma non vanno parsati come numeri).

---

## Integrazione Meetup

Endpoint **`https://api.meetup.com/gql-ext`**, `Authorization: Bearer <access_token>`, 500 punti/60 s.

**Prima di scrivere `meetup/query.js`**: provare la query nel playground (`https://www.meetup.com/api/playground/#graphQl-playground`) con le credenziali reali e fissare quella che risolve. Query primaria (percorso Pro, documentato):

```graphql
query NetworkEvents($urlname: ID!, $status: String!, $first: Int!, $after: String) {
  proNetwork(urlname: $urlname) {
    eventsSearch(input: { first: $first, after: $after, filter: { status: $status } }) {
      totalCount
      pageInfo { hasNextPage endCursor }
      edges { node {
        id title eventUrl description dateTime endTime timezone going status
        featuredEventPhoto { baseUrl id }
        venue { name address city country lat lng }
        group { urlname name }
      } }
    }
  }
}
```

Due chiamate: `status: "UPCOMING"` (`first: 20`) e `status: "PAST"` (`first: 50`, paginando fino a `hasNextPage === false`, cap ~200). Se la Pro network contiene più gruppi, filtrare su `node.group.urlname`.

Firma RS256 senza dipendenze (`api/src/lib/meetup/jwt.js`):

```js
import { createSign, createPrivateKey } from 'node:crypto';
const b64url = (v) => Buffer.from(v).toString('base64url');

export function buildAssertion({ clientKey, memberId, signingKeyId, privateKeyPem }) {
  const now = Math.floor(Date.now() / 1000);
  const header  = { kid: signingKeyId, typ: 'JWT', alg: 'RS256' };
  const payload = { sub: String(memberId), iss: clientKey, aud: 'api.meetup.com', exp: now + 120 };
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const key = createPrivateKey({ key: privateKeyPem, format: 'pem' });
  return `${input}.${b64url(createSign('RSA-SHA256').update(input).end().sign(key))}`;
}
// POST https://secure.meetup.com/oauth2/access
//   grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer & assertion=<jwt>
//   → { access_token, token_type, refresh_token, expires_in: 3600 }
```

`sub` deve essere l'id del membro proprietario dell'OAuth client. La chiave privata PEM è multiriga mentre le app setting sono su una riga: salvarla come **`MEETUP_PRIVATE_KEY_B64`** e decodificarla con `Buffer.from(…, 'base64').toString('utf8')`.

**App settings SWA**: `DATA_STORAGE_CONNECTION`, `CONTAINER_PRIVATE=site-data`, `CONTAINER_PUBLIC=public`, `PUBLIC_BASE_URL`, `MEETUP_URLNAME`, `MEETUP_CLIENT_KEY`, `MEETUP_MEMBER_ID`, `MEETUP_SIGNING_KEY_ID`, `MEETUP_PRIVATE_KEY_B64`, `REFRESH_TOKEN`.

---

## CI/CD

`.github/workflows/azure-static-web-apps.yml` — `app_location: "src"`, `api_location: "api"`, `output_location: ""`, `skip_app_build: true`. Così `src/` sale verbatim (nessun Oryx sul frontend) mentre `api/` riceve il suo `npm install`. Il job va guardato con `github.event.pull_request.head.repo.full_name == github.repository`: su repo pubblico le PR da fork non ricevono i secret e il deploy fallirebbe rumorosamente a ogni contributo esterno. Job separato `action: close` sulla chiusura delle PR.

`.github/workflows/refresh-events.yml` — `schedule: cron "17 */6 * * *"` + `workflow_dispatch`, un `curl -fsS -X POST https://${{ vars.SITE_HOST }}/api/refresh-events -H "x-refresh-token: ${{ secrets.REFRESH_TOKEN }}"`. Serve perché le managed functions sono **solo HTTP**: non esiste timer trigger dentro SWA.

---

## Sviluppo locale

`package.json` di root con sole devDependencies (`@azure/static-web-apps-cli`, `azurite`) — il frontend continua a non avere build.

1. `npx azurite --silent --location .azurite` (gitignorare `.azurite/`).
2. Creare una volta i container su `UseDevelopmentStorage=true`: `site-data` (privato) e `public` (`--public-access blob`). Azurite supporta container anonimi e CORS, quindi il percorso di lettura di produzione è fedelmente testabile in locale.
3. `npx swa start` → `http://localhost:4280`.
4. **Auth emulata**: `/.auth/login/aad` apre un form della CLI dove si inseriscono username e **ruoli uno per riga** → scrivere `admin`. La CLI applica davvero le `allowedRoles` di `staticwebapp.config.json` e inietta un `x-ms-client-principal` di forma reale, quindi si testano sia le route rules sia il controllo in-function.
5. `api/local.settings.json` (gitignorato) con `MEETUP_MOCK=true`, così `meetup/query.js` restituisce `data/seed/events.sample.json` e non servono né chiave privata né rate limit.

---

## Fasi

| # | Contenuto | Gate di uscita |
|---|---|---|
| **P0** | Split di `index.html` in `src/` + CSS/JS separati; vendorizzazione Swiper e Bootstrap Icons; rimozione dell'`onclick` inline; estrazione dei 6 logo SVG inline in file; dati seed in `data/seed/*.json` renderizzati client-side da file locali. **Nessun Azure.** | Pixel-identico a oggi servito da un qualsiasi static server. Si committa da solo. |
| **P1** | SWA Free + account storage dedicato con `public` (access level Blob) e `site-data`; CORS di servizio; upload dei seed; workflow di deploy; `staticwebapp.config.json` (senza `/api`); `403.html`/`404.html`; dominio custom; versioning + soft delete. | **Verificare che `AllowBlobPublicAccess=true` non sia bloccato da policy. Se lo è, fermarsi e ripianificare il percorso di lettura.** Il sito legge i dati dal blob. |
| **P2** | `/admin/index.html`, login Entra, auto-invito al ruolo `admin`, `/api/me`, `lib/auth.js`. Nessun dato. | Utente senza ruolo → 403 in italiano; con ruolo → pagina admin; logout funzionante. |
| **P3** | `lib/blob.js` con ETag, `lib/validate.js`, `GET/PUT /api/team`, ripubblicazione su `public/`, editor team nell'admin con gestione del 409. | Modifica dall'admin visibile sul sito pubblico entro 5 minuti; due tab in conflitto → messaggio, nessuna perdita di dati. |
| **P4** | `GET/PUT /api/sponsors` + editor sponsor (stesso pattern di P3, riuso diretto di `blob.js`/`validate.js`); `POST /api/assets` con `lib/image.js` e sanificazione SVG; rendering sponsor raggruppato per tier. | Sponsor creato da zero nell'admin, logo caricato dal disco, visibile sul sito con la dimensione del suo tier. |
| **P5** | `meetup/{jwt,token,query,map}.js` (query verificata nel playground); `/api/refresh-events` + secret + cron + bottone admin; `public/events.json`; stale-on-error. Poi il nuovo rendering eventi e il filtro temporale di §Filtro. | Eventi reali dal gruppo Meetup; staccando Meetup il sito continua a mostrare l'ultimo stato buono. |
| **P6** | Application Insights, runbook rotazione chiavi in `docs/`, `robots.txt`/`sitemap.xml`/OG tags, passata Lighthouse + axe. Opzionale: il job di refresh scrive anche uno snapshot statico `eventi.html` per recuperare SEO e anteprime LinkedIn/WhatsApp. | — |

**Fuori scope** (restano hardcoded): sessioni/talk, sezione "Chi siamo", footer. Le sessioni sono facilmente aggiungibili in seguito come `sessions.json` con lo stesso pattern di `team.json`, collegate agli eventi tramite l'id Meetup.

**Regressione nota accettata**: spostando gli eventi da HTML a rendering client-side, diventano invisibili ai crawler senza JS e alle anteprime dei link social. Recuperabile in P6 con lo snapshot statico.

---

## Verifica end-to-end

1. **P0 locale** — `npx serve src` (o qualsiasi static server), confronto visivo a 375 / 768 / 1280 / 1920 px con la pagina attuale; console senza errori; copia email funzionante dopo la rimozione dell'`onclick`.
2. **SWA CLI** — `npx swa start`: `/` renderizza dai seed; `/admin/` senza login → redirect a login; login emulato **senza** ruolo `admin` → 403.html; con ruolo → admin caricata; `GET /api/team` → 200 con ETag; `PUT` con `If-Match` stantio → 409; `PUT` con payload invalido → 400 con `issues`.
3. **Sponsor e upload** — creare uno sponsor con logo PNG e uno con SVG; verificare che l'SVG salvato sul blob **non** contenga più `<script>` né attributi `on*`; file da 1 MB → 413; `.exe` rinominato `.png` → 415; sponsor `gold` e `bronze` renderizzati in fasce di dimensione diversa; sponsor senza `websiteUrl` → card non cliccabile.
4. **Meetup** — query provata nel playground prima del codice; poi `curl -X POST localhost:4280/api/refresh-events -H 'x-refresh-token: dev'` con credenziali reali → conteggio eventi coerente col gruppo; seconda chiamata entro il TTL → `{"refreshed": false, "reason": "fresh"}`; con chiave privata errata → `{"served": "stale"}` e il sito ancora popolato.
5. **Blob** — `curl -I https://<account>.blob.core.windows.net/public/events.json` da anonimo → 200 + `ETag` + `Cache-Control`; ripetuto con `If-None-Match` → 304; preflight CORS `OPTIONS` con `Origin` arbitrario → 200.
6. **Produzione** — deploy su `main`; login Entra reale con un account **non** invitato → 403; account invitato → admin; salvataggio di un membro → visibile sul sito pubblico dopo la scadenza dei 300 s di cache; `workflow_dispatch` di `refresh-events` → nuovo `generatedAt`.
7. **Sicurezza** — DevTools: nessuna violazione CSP; header `X-Frame-Options`/`HSTS`/`nosniff` presenti; nessun segreto nel bundle client; `/api/team` in incognito → redirect a login, non JSON.
8. **Accessibilità/perf** — Lighthouse ≥ 90 su Performance e Accessibility in mobile; axe DevTools senza violazioni serie; tastiera sul segmentato e sulle chip; con `prefers-reduced-motion` il marquee team è fermo.
