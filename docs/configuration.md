# Note su `src/staticwebapp.config.json`

JSON non ammette commenti e **lo schema di Static Web Apps rifiuta le proprietà
non previste al primo livello**: aggiungere una chiave `_comment` fa scartare
*tutta* la configurazione, in silenzio. Il sintomo è perfido — il sito continua
a funzionare, ma route rules, `allowedRoles`, header e pagine di errore
spariscono, quindi `/admin` resta aperto a chiunque. Per questo le spiegazioni
stanno qui e non nel file.

Se hai un dubbio, l'emulatore lo dice: `npm start` stampa
`Error reading workflow configuration` quando il file viene scartato.

## Niente `navigationFallback`

L'assenza è deliberata. Il sito non è una SPA: ogni pagina è un file reale e
non c'è routing client-side.

- Con un fallback verso `/index.html`, qualsiasi URL inesistente risponderebbe
  **200 con la homepage** invece di 404 — un soft 404, che confonde i crawler.
- Soprattutto: **le richieste servite dal `navigationFallback` saltano le route
  rules.** `/admin/*` diventerebbe raggiungibile senza autenticazione ogni volta
  che il percorso non corrisponde a un file esistente.

Se un domani servisse routing client-side, il fallback va aggiunto insieme a un
`exclude` che contenga almeno `/api/*` e `/admin/*`.

## L'ordine delle route conta

La valutazione si ferma alla **prima** corrispondenza. Due conseguenze:

- `/api/me` deve precedere `/api/*`. Altrimenti un utente autenticato ma senza
  ruolo `admin` non riuscirebbe nemmeno a sapere perché è bloccato, perché la
  chiamata che serve a dirglielo verrebbe rifiutata insieme alle altre.
- `/admin/index.html` è elencata esplicitamente oltre a `/admin/*`: la
  documentazione Azure avverte che una regola su una cartella non copre
  automaticamente il suo `index.html`.

## Il `responseOverrides` 401 è globale

Non si può limitare a una route. A sessione scaduta, anche una
`fetch('/api/team')` dalla pagina admin riceve un **302 verso la pagina HTML di
login**, non un 401 JSON — e `fetch` segue il redirect in automatico.

Per questo `src/assets/js/admin/api.js` non guarda lo status per capire se la
sessione è caduta, ma il `content-type`: se la risposta di `/api` non è JSON,
allora siamo stati rimbalzati al login.

## Autorizzazione, non autenticazione

Il provider `aad` preconfigurato è multi-tenant e accetta anche account
Microsoft personali: **chiunque può autenticarsi**. Limitare l'accesso a un solo
tenant richiederebbe una registrazione custom, disponibile solo sul piano
Standard.

Il cancello vero è quindi il ruolo `admin`, che si assegna solo per invito. È
verificato in due punti, apposta:

1. nelle `allowedRoles` delle route rules — il gate reale, perché le managed
   functions non hanno un hostname pubblico e l'header `x-ms-client-principal`
   lo inietta solo il runtime di SWA;
2. dentro ogni function (`api/src/lib/auth.js`) — perché una singola route rule
   messa nell'ordine sbagliato aprirebbe tutto in silenzio, e perché passando un
   domani alle *bring your own functions* l'app diventerebbe indirizzabile
   dall'esterno e l'header falsificabile.

Il provider GitHub è disattivato con una regola che risponde 404 su
`/.auth/login/github`: teniamo un solo percorso di accesso.

## Header di sicurezza

`style-src` conserva `'unsafe-inline'` perché Swiper scrive stili inline sugli
elementi del carosello. `script-src` invece è `'self'` puro: è il motivo per cui
Swiper e Bootstrap Icons sono vendorizzati in `src/assets/vendor/` invece di
arrivare da un CDN.

`img-src` è `https:`, cioè qualunque host in HTTPS. È una scelta, non una
distrazione. Le foto del team e i loghi degli sponsor si caricano dall'admin e
finiscono sul nostro storage, ma il campo resta scrivibile a mano: chi preferisce
puntare al proprio avatar GitHub o a un logo già ospitato altrove deve poterlo
fare, e con una allowlist di host quella URL non darebbe errore — semplicemente
l'immagine non comparirebbe, senza dire perché.

Il costo è modesto: un'immagine non esegue codice, e `script-src` resta `'self'`,
quindi per abusarne servirebbe prima riuscire a iniettare uno script. Quello che
si perde è la capacità di accorgersi, dalla sola CSP, che qualcuno ha messo una
URL di terzi in un campo foto — e per quello c'è la revisione del JSON.

Gli SVG caricati sono il caso delicato, perché il container è pubblico e
raggiungibile per URL diretta: vengono sanificati e salvati con
`Content-Disposition: attachment`, così aprirli in una scheda li scarica invece
di renderizzarli. Dentro un `<img>` continuano a funzionare, perché per le
sottorisorse quell'header è ignorato.

`connect-src` e `img-src` elencano anche `http://127.0.0.1:10000`, che è
Azurite. In sviluppo il sito gira su `:4280` e legge i dati dal container
pubblico su `:10000`: è una richiesta cross-origin, e senza quella voce il
browser la blocca. Il sito continuerebbe a funzionare — `data.js` ripiega sui
JSON del deploy — ma si testerebbe proprio il ramo di riserva invece del
percorso di produzione. Un host locale in CSP non allarga la superficie di
attacco in modo interessante: `script-src` resta `'self'`, quindi per sfruttarlo
servirebbe prima riuscire a iniettare uno script.

Quando lo storage account esisterà, il suo host va aggiunto **sia** a `img-src`
(gli avatar e i loghi caricati dall'admin) **sia** a `connect-src` (il `fetch`
dei JSON), insieme alla costante `STORAGE_ACCOUNT` di
`src/assets/js/config.js`. Vedi [deploy.md](deploy.md).

## L'emulatore non distingue 403 da 401

Provato con un principal autenticato ma senza ruolo `admin`: l'emulatore
risponde **302 verso il login** (cioè tratta il caso come 401) sia su `/admin/`
sia su `/api/team`, invece del 403 che si aspetta da Azure. La pagina
`403.html` quindi in locale non si vede mai per quella strada, e va verificata
in produzione con un account reale non invitato.

È una delle divergenze che la CLI stessa annuncia all'avvio
(*This emulator may not match the cloud environment exactly*). Non cambia
niente lato sicurezza — l'accesso resta negato in entrambi i casi.
