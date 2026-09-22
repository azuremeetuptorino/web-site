# Deploy su Azure Static Web Apps

Guida operativa per pubblicare il sito. Da eseguire una volta sola; dopo, ogni
push su `main` fa il deploy da solo.

## Le risorse

Tutto vive in `rg-lrizzi-meetup` (italynorth), subscription *Sponsorship 14k*.

| Risorsa | Regione | Ruolo |
|---|---|---|
| `swa-meetup` | West Europe | Static Web App Free: hosting, managed functions, auth |
| `stazuremeetuptorino2` | italynorth | Dati del sito: container `public` e `site-data` |

La SWA sta in West Europe perche in italynorth non esiste: le regioni valide
sono West Europe, Central US, East US 2, West US 2 ed East Asia. Lo storage
invece resta vicino a chi legge.

> Nella stessa resource group ci sono `stazuremeetuptorino` (**senza** il 2),
> `afd-meetup` e il dominio `torino.azuremeetup.it`. Sono il sito **vecchio**:
> Front Door davanti al container `$web` di quell'account, che ha shared key e
> accesso anonimo disabilitati di proposito. Questa soluzione non li tocca e non
> deve usarli. Spostare `torino.azuremeetup.it` su `swa-meetup` e un intervento
> a se, da fare sapendo che SWA gestisce gia il proprio dominio custom e che
> l'auth Entra ID passa per `/.auth/*`.

## Cosa costa

| Risorsa | Piano | Costo |
|---|---|---|
| Static Web App | Free | 0 € |
| Storage account | Standard_LRS, pochi MB | ~0,05 €/mese |
| GitHub Actions | repo pubblico | 0 € |

Il piano Free della SWA basta per tutto quello che serve qui: hosting globale,
certificato TLS, managed functions, provider di autenticazione preconfigurati,
ruoli custom assegnati per invito (fino a 25 utenti) e regole `allowedRoles`.
L'unica cosa che richiederebbe il piano Standard è la registrazione di un
provider Entra ID **custom**, cioè limitare il login a un solo tenant — vedi
[Autenticazione](#autenticazione) per come ce la caviamo senza.

## 1. Prerequisiti

- Una subscription Azure con permessi di creazione risorse
- Permessi di amministrazione sul repo GitHub
- Azure CLI e PowerShell

Azure CLI e PowerShell sono **già dentro il devcontainer**: aprendo il repo in
VS Code con *Reopen in Container* non serve installare nulla. Fuori dal
container servono [Azure CLI](https://aka.ms/installazurecliwindows) e
PowerShell installati a mano.

```bash
az login
az account set --subscription "<nome o id della subscription>"
```

## 2. Provisioning

Lo script è idempotente: rilanciarlo non rompe nulla. Prima una prova a vuoto:

```bash
pwsh -File ./scripts/provision-azure.ps1 -StorageAccountName stazuremeetuptorino2 -StorageLocation italynorth -WhatIf
pwsh -File ./scripts/provision-azure.ps1 -StorageAccountName stazuremeetuptorino2 -StorageLocation italynorth
```

`-StorageAccountName` deve essere **globalmente univoco**, 3-24 caratteri, solo
minuscole e cifre. `-StorageLocation` separa la regione dello storage da quella
della SWA: senza, lo storage finirebbe in West Europe con la Static Web App.

> **Punto di non ritorno.** Lo script crea lo storage account con
> `--allow-blob-public-access true` e `--allow-shared-key-access true`. Se la
> subscription ha la Azure Policy *"Storage accounts should prevent anonymous
> access"*, il comando fallisce. Non aggirarla: fermati e dimmelo, perché cambia
> l'architettura di lettura (il sito dovrebbe leggere i dati da `/api`, pagando
> un cold start di 1-3 s sulla prima visita invece di leggerli direttamente dal
> blob con ETag).
>
> Anche la shared key non e negoziabile: le managed functions di SWA non
> supportano né Managed Identity né i riferimenti a Key Vault, quindi l'unico
> modo che hanno di scrivere sul blob e la chiave dell'account. Disabilitarla
> sull'account significa rinunciare all'admin.

## 3. Collegare il repo

Il workflow ha bisogno di una cosa sola: il secret
`AZURE_STATIC_WEB_APPS_API_TOKEN` nel repo. Da CLI, senza passare dal portale:

```bash
gh auth login   # servono gli scope repo e workflow, e ADMIN sul repo

TOKEN=$(az staticwebapp secrets list -n swa-meetup -g rg-lrizzi-meetup \
  --query "properties.apiKey" -o tsv)

gh secret set AZURE_STATIC_WEB_APPS_API_TOKEN -b "$TOKEN" \
  -R azuremeetuptorino/web-site
```

Da qui in poi ogni push su `main` deploya. È la strada preferibile: collegando
il repo dal portale (**Deployment > Source**) Azure genera **un secondo file di
workflow** accanto al nostro, e i due si pesterebbero i piedi. Il nostro è
`.github/workflows/azure-static-web-apps.yml` e ha due cose che quello generato
non ha: `skip_app_build: true` (il frontend non ha build, `src/` va caricato
verbatim) e la guardia sulle PR da fork, che altrimenti fallirebbero a ogni
contributo esterno perché non ricevono i secret.

Se un giorno si passa comunque dal portale, **cancella il workflow che Azure
aggiunge.**

Conseguenza di questa scelta: sulla SWA i campi `repositoryUrl` e `branch`
restano vuoti (`az staticwebapp show`), e il portale mostra la sorgente come non
configurata. È normale — il deploy lo fa GitHub Actions con il token, non il
collegamento.

## 4. Storage: app setting e primo caricamento

Il provisioning crea i container ma non ci mette dentro niente, e le managed
functions non sanno ancora dove sta lo storage. Due cose, in quest'ordine.

**La connection string come app setting.** Le managed functions di SWA non
supportano Managed Identity né i riferimenti a Key Vault: la connection string
sta in chiaro in una app setting. Il nome `DATA_STORAGE_CONNECTION` non è
negoziabile — i prefissi `AZUREBLOBSTORAGE_`, `WEBSITE_`, `FUNCTIONS_` e
`AzureWeb` sono riservati da SWA e verrebbero ignorati o rifiutati.

```bash
CONN=$(az storage account show-connection-string \
  -n stazuremeetuptorino2 -g rg-lrizzi-meetup --query connectionString -o tsv)

az staticwebapp appsettings set -n swa-meetup -g rg-lrizzi-meetup \
  --setting-names DATA_STORAGE_CONNECTION="$CONN"
```

**Il primo caricamento dei dati.** Senza, il sito legge 404 dal blob e ripiega
per sempre sui JSON imbarcati nel deploy — funziona, ma l'admin non cambierebbe
niente di visibile.

```bash
DATA_STORAGE_CONNECTION="$CONN" npm run seed
```

`PUBLIC_BASE_URL` è **facoltativa**: senza, le URL dei file caricati si
ricavano dall'endpoint dell'account. Va impostata solo se un giorno lo storage
finisse dietro un dominio custom o una CDN.

Il comando carica `src/data/*.json` sul container pubblico e crea il master
privato `site-data/team.json`. Il master **non** viene sovrascritto se esiste
già: quello è il documento che l'admin modifica, e rimetterci sopra il seed
cancellerebbe il suo lavoro. Per forzare serve `npm run seed -- --force`.

## 5. Verifica

```bash
SITE=$(az staticwebapp show -n swa-meetup -g rg-lrizzi-meetup --query defaultHostname -o tsv)

curl -I "https://$SITE/"                # 200 + header di sicurezza
curl -I "https://$SITE/data/team.json"  # 200, Cache-Control 300s
curl -o /dev/null -w '%{http_code}\n' "https://$SITE/pagina-inesistente"   # 404
curl -o /dev/null -w '%{http_code}\n' "https://$SITE/admin/"               # 302 verso il login

# Il blob pubblico, da anonimo: 200, ETag e Cache-Control di 300 s
curl -I "https://stazuremeetuptorino2.blob.core.windows.net/public/team.json"

# Il container privato non deve rispondere da anonimo (404, non 403: Azure non
# conferma nemmeno che il blob esista)
curl -o /dev/null -w '%{http_code}\n' \
  "https://stazuremeetuptorino2.blob.core.windows.net/site-data/team.json"

# Il preflight CORS deve dare 200 con Access-Control-Allow-Origin: senza, ogni
# fetch dal sito fallisce e si ripiega in silenzio sui dati del deploy
curl -X OPTIONS -H "Origin: https://$SITE" -H "Access-Control-Request-Method: GET" \
  -D - -o /dev/null "https://stazuremeetuptorino2.blob.core.windows.net/public/team.json"
```

In PowerShell non chiamare la variabile `$host`: è una variabile automatica
riservata e l'assegnazione fallisce.

Sempre in PowerShell, su Linux, un `*` passato a un comando nativo **da una
variabile o da un array** viene espanso contro i file della directory corrente:
la regola CORS diventa una allowlist con dentro i nomi dei file del repo, `az`
la accetta senza lamentarsi e il preflight risponde 403 a ogni fetch. Per questo
lo step `[6/7]` di `provision-azure.ps1` e l'unico che non passa da `Invoke-Az`
ma scrive gli asterischi inline. Ne il backtick ne
`$PSNativeCommandArgumentPassing` cambiano le cose (verificato su 7.6).

Nel browser, DevTools aperto: nessuna violazione CSP in console, carosello team
in movimento, eventi e sponsor renderizzati.

## 6. Dominio custom

Il piano Free consente 2 domini per app. Dal portale: **Custom domains > Add**,
poi segui le istruzioni DNS (CNAME per un sottodominio, TXT + ALIAS/ANAME per
l'apex). Il certificato viene emesso e rinnovato da Azure.

## Autenticazione

Il provider Entra ID **preconfigurato** (`/.auth/login/aad`) è multi-tenant e
accetta anche account Microsoft personali: chiunque può *autenticarsi*. È
accettabile perché il cancello vero è l'**autorizzazione** — il ruolo `admin`
si assegna solo per invito, e `/admin` lo richiede sia nelle route rules sia
dentro ogni function.

Per invitare una persona: portale Azure > Static Web App > **Role management**
> *Invite*, provider `Microsoft Entra ID` (la cosiddetta `aad`), email
dell'invitato, ruolo `admin`, scadenza dell'invito. Il link va consegnato alla
persona, che accettandolo si lega il ruolo all'account.

Conseguenza da tenere a mente: uno sconosciuto che arriva su `/admin` vede
prima un login Microsoft e poi la nostra pagina 403. È voluto.

## Configurazione legata al nome dello storage

Il nome dello storage account compare in due punti del codice, già allineati a
`stazuremeetuptorino2`. Se un giorno cambia, vanno cambiati **entrambi**:

1. `src/assets/js/config.js` → la costante `STORAGE_ACCOUNT`.
2. `src/staticwebapp.config.json` → l'host del blob dentro `connect-src` (e
   `img-src`, che oggi passa per il generico `https:`) nella
   `Content-Security-Policy`.

Con `STORAGE_ACCOUNT` giusto e la CSP ferma sul nome vecchio il browser blocca
la lettura del blob e il sito ripiega in silenzio sui dati del deploy — sembra
funzionare, ma l'admin non cambia più niente di visibile. Svuotare
`STORAGE_ACCOUNT` è il modo pulito per tornare a leggere i JSON del deploy.

Attenzione a `staticwebapp.config.json`: una chiave inattesa al primo livello fa
scartare **tutto** il file, `allowedRoles` compresi, lasciando `/admin` aperto.
Vedi [configuration.md](configuration.md).

## Rollback

Ogni deploy è una versione della SWA. Per tornare indietro basta rifare push
del commit precedente: il workflow ridistribuisce. I dati JSON sul blob hanno
versioning e soft delete a 7 giorni, quindi anche una scrittura sbagliata
dall'admin è recuperabile dal portale (Storage > Container > blob > Versions).
