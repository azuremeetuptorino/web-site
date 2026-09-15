# Azure Meetup Torino — sito della community

Sito di [Azure Meetup Torino](https://www.meetup.com/it-IT/azure-meetup-torino/),
community tech indipendente piemontese dedicata a Microsoft Azure, cloud
architecture, DevOps e AI.

Ospitato su **Azure Static Web Apps** (piano Free). Gli eventi arrivano da
Meetup; team e sponsor si modificano da una pagina `/admin` protetta
dall'autenticazione integrata di SWA. I dati sono file JSON, niente database.

## Stack

Nessun build step. `src/` viene caricato su Azure così com'è.

- HTML, CSS e JavaScript vanilla (moduli ES nativi)
- [Swiper 11](https://swiperjs.com/) e [Bootstrap Icons 1.11.3](https://icons.getbootstrap.com/)
  vendorizzati in `src/assets/vendor/` — nessun CDN di terze parti a runtime,
  così la CSP può restare `script-src 'self'`
- Azure Functions (Node 20) come API della sola area amministrativa
- Azure Blob Storage per i dati JSON

## Struttura

```
src/                      quello che finisce su Azure, verbatim
  index.html
  403.html  404.html
  staticwebapp.config.json    route, header di sicurezza, ruoli
  assets/css   assets/js   assets/img   assets/vendor
  data/                    team.json, sponsors.json, events.json
api/                      managed functions (dalla P2)
scripts/                  provisioning Azure
docs/                     deploy, runbook
```

## Sviluppo locale

Usa il **devcontainer**: `.devcontainer/` contiene tutto (Node 20, Azure
Functions Core Tools, Azurite, SWA CLI, Azure CLI, GitHub CLI, PowerShell).

In VS Code: *Reopen in Container*. Alla creazione vengono installate le
dipendenze, creati i container Azurite `public` e `site-data`, e Azurite parte
da solo a ogni avvio.

```bash
npm start            # emulatore SWA su http://localhost:4280
npm test             # test delle managed functions
npm run seed         # ricarica src/data/*.json sul blob (Azurite)
```

> **Node 20 non è un capriccio.** È la major che gira sulle managed functions
> di Azure, e Azure Functions Core Tools v4 *rifiuta* di partire su Node 22+.
> Sviluppando sull'host con un Node recente, `swa start` non riesce ad avviare
> l'API. È il motivo per cui esiste il devcontainer.

L'emulatore applica davvero `staticwebapp.config.json` (route, `allowedRoles`,
header, pagine di errore) ed emula il login: da `/.auth/login/aad` si inserisce
uno username e i **ruoli, uno per riga** — scrivere `admin` per entrare in
`/admin`.

> L'emulatore **rilegge `staticwebapp.config.json` solo all'avvio**. Dopo averlo
> modificato, riavvia `npm start`, altrimenti continui a testare la vecchia
> configurazione.

Le impostazioni locali dell'API stanno in `api/local.settings.json`, creato al
primo avvio da `api/local.settings.example.json` e non versionato.

## Dati

La sorgente primaria è il **container blob pubblico**, letto direttamente dal
browser — non da `/api`, che pagherebbe 1-3 s di cold start a ogni visita. I
file in `src/data/*.json` restano come rete di sicurezza: se il blob non
risponde il sito mostra i dati imbarcati nell'ultimo deploy invece di svuotarsi.
Il rendering sta nei moduli `src/assets/js/render-*.js`.

In sviluppo il container pubblico è quello di Azurite. In produzione, finché la
costante `STORAGE_ACCOUNT` di `src/assets/js/config.js` è vuota, si leggono i
file del deploy: è lo stato corretto prima che le risorse Azure esistano.

Il giro di una modifica:

```
/admin  ──PUT /api/team──►  site-data/team.json   (master, scrittura con ETag)
                              └──ripubblica──►  public/team.json
                                                  └──► il sito, entro 5 minuti
```

Due schede aperte sullo stesso editor non si sovrascrivono: la seconda riceve
un 409 con la copia del server e decide cosa tenere. È l'unica difesa possibile,
perché le function scalano su più istanze e un lock in-process non servirebbe.

Le foto dei membri (e dalla P4 i loghi degli sponsor) si caricano dall'admin con
`POST /api/assets` e finiscono nel container pubblico: PNG, JPEG, WebP o SVG,
max 512 KB, tipo verificato sui byte e non sul nome del file. Il nome del blob
contiene l'impronta del contenuto, così la cache può durare un anno e cambiare
foto cambia URL. Gli SVG vengono sanificati e serviti come allegato. Resta
possibile incollare a mano una URL `https://` già ospitata altrove.

## Deploy

Ogni push su `main` fa il deploy tramite
`.github/workflows/azure-static-web-apps.yml`. Per il primo setup delle
risorse Azure vedi [docs/deploy.md](docs/deploy.md).

## Stato

| Fase | Contenuto | Stato |
|---|---|---|
| P0 | Refactor statico, contenuti su JSON | fatto |
| P1 | Configurazione SWA, pagine di errore, CI/CD | fatto (risorse Azure da creare) |
| P2 | `/admin` e autenticazione Entra ID | fatto |
| P3 | CRUD team su Blob Storage | fatto (risorse Azure da creare) |
| P4 | CRUD sponsor e upload loghi | da fare |
| P5 | Integrazione Meetup e filtro temporale eventi | da fare |
| P6 | Telemetria, SEO, accessibilità | da fare |

## Riprendere il lavoro

[docs/stato-lavori.md](docs/stato-lavori.md) tiene il punto della situazione:
cosa e fatto, le decisioni gia prese, i bloccanti aperti e il prossimo passo.
Il piano completo e in [docs/piano.md](docs/piano.md).

## Licenza

[MIT](LICENSE)
