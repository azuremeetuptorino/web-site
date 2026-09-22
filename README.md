# Azure Meetup Torino — sito della community

Sito di [Azure Meetup Torino](https://www.meetup.com/it-IT/azure-meetup-torino/),
community tech indipendente piemontese dedicata a Microsoft Azure, cloud
architecture, DevOps e AI.

Ospitato su **Azure Static Web Apps** (piano Free). Team, sponsor, eventi e
contenuti della home si modificano da una pagina `/admin` protetta
dall'autenticazione integrata di SWA. Gli eventi si **importano dal link** della
loro pagina pubblica su Luma o Meetup. I dati sono file JSON, niente database.

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
  eventi/index.html            l'archivio completo degli eventi
  403.html  404.html
  staticwebapp.config.json    route, header di sicurezza, ruoli
  assets/css   assets/js   assets/img   assets/vendor
  data/                    site.json, team.json, sponsors.json, events.json
api/                      managed functions (dalla P2)
scripts/                  provisioning Azure, seed, import dell'archivio Meetup
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

# una tantum: carica l'archivio degli eventi passati da Meetup
node scripts/import-meetup-past.mjs --dry-run
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

Il giro di una modifica, uguale per team, sponsor, eventi e contenuti della home:

```
/admin  ──PUT /api/team──►  site-data/team.json   (master, scrittura con ETag)
                              └──ripubblica──►  public/team.json
                                                  └──► il sito, entro 5 minuti
```

Due schede aperte sullo stesso editor non si sovrascrivono: la seconda riceve
un 409 con la copia del server e decide cosa tenere. È l'unica difesa possibile,
perché le function scalano su più istanze e un lock in-process non servirebbe.

Le foto dei membri e i loghi degli sponsor si caricano dall'admin con
`POST /api/assets` e finiscono nel container pubblico: PNG, JPEG, WebP o SVG,
max 512 KB, tipo verificato sui byte e non sul nome del file. Il nome del blob
contiene l'impronta del contenuto, così la cache può durare un anno e cambiare
foto cambia URL. Gli SVG vengono sanificati e serviti come allegato. Resta
possibile incollare a mano una URL `https://` già ospitata altrove.

### Eventi

Gli eventi si pubblicano su **Luma** e su **Meetup**, e non abbiamo una chiave
API per nessuno dei due. Non serve: dalla scheda **Eventi** dell'admin si incolla
il link della pagina pubblica dell'evento e `POST /api/events/import` la
scarica, ne legge il blocco **JSON-LD `schema.org/Event`** (quello che Google usa
per i risultati arricchiti) e restituisce la scheda compilata: titolo, inizio e
fine, luogo, immagine, descrizione breve e link per iscriversi. Dove il JSON-LD
e tirchio si integra con i dati che la pagina lascia in `__NEXT_DATA__` (Meetup
tronca la descrizione a 150 caratteri, Luma non scrive il nome della sala). La
scheda si controlla, si corregge e si salva con **Salva e pubblica** come
qualunque altra: l'importazione non scrive niente da sola.

L'identificativo viene dalla piattaforma (`luma-2ffi3qjx`, `meetup-316647090`):
reimportando lo stesso link la scheda esistente si **aggiorna** invece di
duplicarsi, che e quello che serve quando cambia l'orario.

L'archivio storico — i **27 incontri dal 2018 a oggi** — è stato caricato una
volta sola con `scripts/import-meetup-past.mjs`. Quello non poteva passare dal
JSON-LD: l'elenco degli eventi passati di un gruppo lo dà solo `www.meetup.com/gql2`,
l'endpoint GraphQL interno del sito, che risponde senza autenticazione ma non è
documentato. Sta in uno script e non in una function apposta: se Meetup lo cambia
si rompe uno script che ha già fatto il suo lavoro, non la `/admin`. Da qui in
avanti gli eventi entrano uno alla volta dal link.

In **home** ne compaiono **cinque**: i prossimi in ordine di data e, se il
futuro non ne riempie cinque, gli ultimi fatti. Sotto c'e un bottone *Vedi tutti
gli eventi* che porta a **`/eventi/`**, l'archivio completo: griglia, segmentato
`Prossimi | Passati` e chip per anno generate dai dati, con lo stato nella query
string (`/eventi/?stato=passati&anno=2025`) perche un anno dell'archivio si
possa mandare a qualcuno. Il calendario di una community che dura cresce di un
evento al mese, e un carosello lungo cinquanta card non si guarda: si trascina.

La function scarica **solo** da `luma.com`, `lu.ma` e `meetup.com`, redirect
compresi, con timeout e tetto ai byte letti: una function che scarica una URL
scelta dall'utente e altrimenti un proxy verso qualunque indirizzo. Per
aggiungere una piattaforma basta il suo host in `ALLOWED_HOSTS` di
`api/src/lib/event-import.js`, purche la pagina esponga JSON-LD `Event`.

Le date stanno sul blob in **UTC** e ogni evento porta il suo fuso (`timezone`,
di default `Europe/Rome`): il sito scrive l'orario in ora italiana a chiunque lo
guardi. Sul sito i prossimi eventi vengono prima in ordine di data, poi i
passati dal piu recente; `active: false` toglie un evento dalla pagina senza
cancellarlo.

Il testo di "Chi siamo" ammette `**grassetto**` e `[link](https://...)` — un
sottoinsieme minimo, utile per esempio a segnalare l'iscrizione al prossimo
evento. Non è HTML: `src/assets/js/rich-text.js` scappa tutto e poi reintroduce
solo il markup che ha generato lui, così non esiste un percorso per cui del
markup scritto nell'editor arrivi intatto nella pagina.

I contenuti fissi della home — foto principale, logo, "Chi siamo", le due
statistiche, il footer, il titolo della scheda del browser e la favicon — stanno in `site.json` e si modificano dalla scheda
**Home e footer**. Qui vale una regola diversa dalle altre sezioni: l'HTML
conserva i testi attuali e il JavaScript **sovrascrive solo ciò che riceve**.
La pagina ha senso anche senza JavaScript, i crawler vedono contenuto vero, e un
campo svuotato dall'admin non svuota il sito — lo riporta al testo di partenza.

Per gli sponsor, la **fascia** (`diamond`, `platinum`, `gold`, `silver`,
`bronze`, `partner`) è l'unico dato che governa dimensione del logo, raggruppamento e ordine
in pagina. È deliberato: aggiungere uno sponsor non deve mai voler dire toccare
il CSS.

## Deploy

Ogni push su `main` fa il deploy tramite
`.github/workflows/azure-static-web-apps.yml`, che si autentica col secret
`AZURE_STATIC_WEB_APPS_API_TOKEN`. Il repo **non** è collegato dal portale: così
Azure non genera un secondo workflow accanto al nostro.

Le risorse stanno in `rg-lrizzi-meetup`: la Static Web App `swa-meetup` (West
Europe) e lo storage `stazuremeetuptorino2` (italynorth). Nella stessa resource
group vivono anche `stazuremeetuptorino` e `afd-meetup`, che servono il sito
**vecchio** su `torino.azuremeetup.it` e non c'entrano con questa soluzione.
Dettagli e runbook in [docs/deploy.md](docs/deploy.md).

## Stato

| Fase | Contenuto | Stato |
|---|---|---|
| P0 | Refactor statico, contenuti su JSON | fatto |
| P1 | Configurazione SWA, pagine di errore, CI/CD | fatto |
| P2 | `/admin` e autenticazione Entra ID | fatto |
| P3 | CRUD team su Blob Storage | fatto |
| P4 | CRUD sponsor e upload loghi | fatto |
| P4b | Contenuti della home editabili (foto, "Chi siamo", statistiche, footer) | fatto |
| P5 | Eventi gestiti dall'admin, importazione dal link Luma/Meetup | fatto |
| P5b | Cinque eventi in home e archivio filtrabile su `/eventi/` | fatto |
| P6 | Telemetria, SEO, accessibilità | da fare |

## Riprendere il lavoro

[docs/stato-lavori.md](docs/stato-lavori.md) tiene il punto della situazione:
cosa e fatto, le decisioni gia prese, i bloccanti aperti e il prossimo passo.
Il piano completo e in [docs/piano.md](docs/piano.md).

## Licenza

[MIT](LICENSE)
