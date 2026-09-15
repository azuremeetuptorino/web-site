# Stato dei lavori

Aggiornato al **15 settembre 2026**. Documento di ripresa: serve a ricominciare
da dove si è lasciato senza rileggere tutto.

Piano completo: [docs/piano.md](piano.md).
Note sulla configurazione SWA: [docs/configuration.md](configuration.md).
Provisioning e deploy: [docs/deploy.md](deploy.md).

## Dove siamo

Branch **`feat/azure-static-web-apps`**, 4 commit avanti rispetto a `main`,
mai pushato.

```
80b034e  Aggiorna lo stato delle fasi nel README
7c2c285  P2: area /admin protetta da Entra ID, devcontainer e primi test
6d2ed9d  P1: configurazione Static Web Apps, pagine di errore e CI/CD
23d5888  P0: modularizza il sito statico e sposta i contenuti su JSON
```

| Fase | Contenuto | Stato |
|---|---|---|
| P0 | Refactor statico, contenuti su JSON | fatto, verificato |
| P1 | Configurazione SWA, pagine di errore, CI/CD | codice fatto, **risorse Azure da creare** |
| P2 | `/admin` e autenticazione Entra ID | fatto, verificato con l'emulatore |
| P3 | CRUD team su Blob Storage | da fare, è il prossimo |
| P4 | CRUD sponsor e upload loghi | da fare |
| P5 | Integrazione Meetup e filtro temporale eventi | da fare |
| P6 | Telemetria, SEO, accessibilità | da fare |

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

## Vincoli verificati

Sono stati controllati sulla documentazione, non sono supposizioni.

- Su SWA **Free** funzionano: provider preconfigurati, ruoli custom **per invito**
  (max 25 utenti), `allowedRoles`, managed functions. Solo "assegna ruoli con una
  function" richiede Standard.
- Il provider `aad` preconfigurato è **multi-tenant e accetta account Microsoft
  personali**: chiunque può autenticarsi. Limitarlo a un tenant richiede una
  registrazione custom, cioè il piano Standard (~9 €/mese). Il cancello è quindi
  l'**autorizzazione**, non l'autenticazione.
- SWA **non mette in cache le risposte `/api`**, e `globalHeaders` non le tocca.
  Le managed functions sono su Consumption: **cold start 1-3 s**. Per questo il
  sito pubblico non deve leggere i dati da `/api`.
- Le managed functions **non supportano Managed Identity** né riferimenti a Key
  Vault: serve la connection string dello storage in una app setting.
- Prefissi di app setting **riservati**: `AZUREBLOBSTORAGE_`, `WEBSITE_`,
  `FUNCTIONS_`, `AzureWeb`, … Il nostro setting si chiama
  `DATA_STORAGE_CONNECTION` apposta.
- Le managed functions sono **solo HTTP**: niente timer trigger, quindi il
  refresh di Meetup lo schedula un cron di GitHub Actions.
- Meetup: endpoint `https://api.meetup.com/gql-ext`, 500 punti/60 s.
  `Group.pastEvents` e `upcomingEvents` sono stati **rimossi** dopo febbraio
  2025. Con l'account Pro si usa
  `proNetwork(urlname).eventsSearch(input:{filter:{status:…}})`.
  **La query va provata nel playground prima di scriverne il codice.**

## Trappole già pagate

Due errori trovati testando, non in astratto. Vale la pena ricordarli.

1. **Una chiave non prevista in `staticwebapp.config.json` fa scartare tutta la
   configurazione, in silenzio.** Avevo aggiunto chiavi `_comment_*` per
   documentare le scelte: lo schema non le ammette, e il risultato è che route
   rules, `allowedRoles`, header di sicurezza e pagine di errore vengono
   ignorati. Il sito continua a funzionare, ma **`/admin/` rispondeva 200 a un
   anonimo**. L'unico segnale è `Error reading workflow configuration` nel log
   dell'emulatore. JSON non ha commenti: le spiegazioni stanno in
   `docs/configuration.md`.

2. **`navigationFallback` era sbagliato qui.** Rimandava ogni URL inesistente
   alla homepage con status 200 (soft 404) e — peggio — le richieste servite dal
   fallback **saltano le route rules**, quindi `/admin/*` sarebbe rimasta
   raggiungibile. Rimosso: il sito non è una SPA, ogni pagina è un file reale.

## Bloccanti

1. **Le risorse Azure non esistono.** Nessuno ha ancora lanciato
   `scripts/provision-azure.ps1`. Serve una subscription e `az login`.
   **Punto di attenzione:** lo script crea lo storage con
   `--allow-blob-public-access true`. Se una Azure Policy lo vieta, il comando
   fallisce e **va ripianificata la lettura dei dati** (il sito dovrebbe leggere
   da `/api` accettando il cold start, invece che dal blob con ETag).

2. **Il devcontainer non è mai stato costruito.** È scritto ma sulla macchina di
   sviluppo il motore di Docker Desktop era spento. Va provato: build, Azurite,
   `npm start` con l'API vera, login emulato end-to-end su `/api/me`.

3. **Logo e hero puntano a URL esterne volatili** (CDN di LinkedIn e Unsplash).
   Sono in `img-src` nella CSP per non rompere nulla, ma il logo vero andrebbe
   scaricato in `src/assets/img/`. **Serve il file del logo**, non ce l'ho.

## Come si riprende

```bash
git checkout feat/azure-static-web-apps
```

Poi in VS Code: *Reopen in Container* (serve Docker Desktop avviato).

```bash
npm start     # emulatore SWA su http://localhost:4280
npm test      # test delle managed functions
```

Per entrare in `/admin` con l'emulatore: apri `/.auth/login/aad`, metti uno
username qualsiasi e nel campo dei ruoli scrivi `admin`, uno per riga.

> L'emulatore rilegge `staticwebapp.config.json` **solo all'avvio**: dopo averlo
> modificato riavvia `npm start`, altrimenti stai testando la vecchia config.

## Prossimo passo: P3

CRUD del team su Blob Storage. Il disegno è già deciso nel piano, in sintesi:

- `api/src/lib/blob.js` — lettura e scrittura con **ETag**: la GET restituisce
  l'ETag, la PUT lo rimanda in `If-Match`. Il 412 dello storage diventa un **409**
  con la copia del server, così l'admin vede "modificato da qualcun altro" invece
  di sovrascrivere in silenzio. È l'unica difesa possibile: le function scalano
  su più istanze, i lock in-process non servono a niente.
- `api/src/lib/validate.js` — validazione scritta a mano, niente `ajv` (una
  dipendenza e un costo di cold start per pochi tipi di oggetto).
- `GET/PUT /api/team` — legge e scrive `site-data/team.json`, e a ogni scrittura
  **ripubblica** il file su `public/team.json` con
  `Cache-Control: public, max-age=300, stale-while-revalidate=86400`.
- Editor del team in `/admin`, con gestione del 409.
- Poi `src/assets/js/config.js` → `PUBLIC_DATA_BASE` punta al blob, e l'host
  dello storage va aggiunto a `img-src` e `connect-src` nella CSP.
- Sullo storage vanno attivati **versioning e soft delete a 7 giorni** (lo fa già
  lo script di provisioning): è la rete di sicurezza contro una PUT sbagliata.

Lo schema di `team.json` è in [docs/piano.md](piano.md), sezione *Modelli dati*,
ed è già quello usato da `src/data/team.json`.

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
  Matteo Contessa.
