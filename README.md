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

I contenuti stanno in `src/data/*.json` e sono renderizzati a runtime dai
moduli in `src/assets/js/render-*.js`.

Dalla P3 la sorgente primaria diventa il container blob pubblico e i file in
`src/data/` restano come rete di sicurezza: se il blob non risponde il sito
continua a mostrare i dati imbarcati nell'ultimo deploy invece di svuotarsi.

## Deploy

Ogni push su `main` fa il deploy tramite
`.github/workflows/azure-static-web-apps.yml`. Per il primo setup delle
risorse Azure vedi [docs/deploy.md](docs/deploy.md).

## Stato

| Fase | Contenuto | Stato |
|---|---|---|
| P0 | Refactor statico, contenuti su JSON | fatto |
| P1 | Configurazione SWA, pagine di errore, CI/CD | fatto (risorse Azure da creare) |
| P2 | `/admin` e autenticazione Entra ID | da fare |
| P3 | CRUD team su Blob Storage | da fare |
| P4 | CRUD sponsor e upload loghi | da fare |
| P5 | Integrazione Meetup e filtro temporale eventi | da fare |
| P6 | Telemetria, SEO, accessibilità | da fare |

## Licenza

[MIT](LICENSE)
