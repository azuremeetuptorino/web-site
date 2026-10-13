# Deploy su Azure Static Web Apps

Guida operativa per pubblicare il sito. Da eseguire una volta sola; dopo, ogni
push su `main` fa il deploy da solo.

## Le risorse

Tutto vive in `rg-meetuptorino-p`, subscription *Sponsorship 10k - 3*.

| Risorsa | Regione | Ruolo |
|---|---|---|
| `swa-meetup` | West Europe | Static Web App Free: hosting, managed functions, auth |
| `stazuremeetuptorino2` | italynorth | Dati del sito: container `public` e `site-data` |
| `afd-meetup` | Global | Front Door Standard: ingresso di `torino.azuremeetup.it`, inoltra alla SWA |

La SWA sta in West Europe perche in italynorth non esiste: le regioni valide
sono West Europe, Central US, East US 2, West US 2 ed East Asia. Lo storage
invece resta vicino a chi legge.

> `torino.azuremeetup.it` e un dominio custom del Front Door `afd-meetup`
> (endpoint `torinomeetup`, certificato gestito da Azure). La route `/*` inoltra
> in HTTPS all'origin group `swa-meetup`, cioe all'hostname
> `*.azurestaticapps.net` della SWA, senza cache: ogni richiesta arriva alla
> SWA, che ha gia la propria distribuzione globale. Prima puntava al container
> `$web` del vecchio storage `stazuremeetuptorino` (**senza** il 2), che non
> serve piu a questo sito.
>
> La SWA resta sul piano Free, dove `forwardingGateway` e `networking` di
> `staticwebapp.config.json` non sono disponibili. Due conseguenze da sapere:
> l'hostname `*.azurestaticapps.net` resta raggiungibile direttamente, e il
> login admin costruisce i redirect con quell'hostname. Chi entra da
> `torino.azuremeetup.it/login` si ritrova, a login fatto, su
> `<hostname SWA>/admin/`: e normale, l'area admin si usa da li.

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

TOKEN=$(az staticwebapp secrets list -n swa-meetup -g rg-meetuptorino-p \
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
  -n stazuremeetuptorino2 -g rg-meetuptorino-p --query connectionString -o tsv)

az staticwebapp appsettings set -n swa-meetup -g rg-meetuptorino-p \
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

## 4b. Promemoria social (facoltativo)

La scheda **Promemoria** dell'admin funziona senza configurare niente: mostra i
testi già adattati al limite di ogni canale, si copiano e si pubblicano a mano.
Le due integrazioni qui sotto tolgono lavoro, ma nessuna delle due è necessaria.

**Telegram: pubblicare davvero dal pannello.** È l'unico dei quattro canali con
un'API utilizzabile senza approvazioni. WhatsApp non espone i canali, LinkedIn e
Instagram richiedono un'app in review, e Instagram pretende pure un account
Business: per quei tre il flusso resta copia-incolla.

1. Da Telegram, scrivere a [@BotFather](https://t.me/BotFather), `/newbot`, e
   segnarsi il token.
2. Aggiungere il bot come **amministratore** del canale, con il solo permesso
   *Pubblica messaggi*. Senza questo passaggio l'API risponde «bot is not a
   member of the channel chat».
3. `TELEGRAM_CHAT_ID` è lo username pubblico con la chiocciola
   (`@AzureMeetupTorino`); per un canale privato serve l'id numerico `-100…`.

```bash
az staticwebapp appsettings set -n swa-meetup -g rg-meetuptorino-p \
  --setting-names TELEGRAM_BOT_TOKEN="123456:AA..." TELEGRAM_CHAT_ID="@AzureMeetupTorino"
```

**GPT-6 Astra su Foundry: far riscrivere i testi.** Aggiunge il pulsante *Riscrivi
con AI*, che genera le quattro versioni in una chiamata sola. Il risultato non
viene pubblicato: diventa una bozza modificabile, e va comunque riletta prima di
mandarla.

1. Creare una risorsa **Microsoft Foundry** e deployare `gpt-6-astra`
   (Standard Global o Data Zone EU). Non serve richiesta di accesso, ma sotto
   il Tier 5 di quota può servire una richiesta di quota.
2. `FOUNDRY_BASE_URL` è `https://<risorsa>.openai.azure.com/openai/v1/`: la
   Responses API su questo endpoint non vuole `api-version`.
3. `FOUNDRY_DEPLOYMENT` è il **nome del deployment**, che di solito coincide con
   l'id del modello ma può essere stato cambiato al momento della creazione.
4. Si usa la chiave API e non Entra ID: le managed functions non hanno Managed
   Identity.

```bash
az staticwebapp appsettings set -n swa-meetup -g rg-meetuptorino-p \
  --setting-names FOUNDRY_BASE_URL="https://<risorsa>.openai.azure.com/openai/v1/" \
                  FOUNDRY_API_KEY="<chiave>" \
                  FOUNDRY_DEPLOYMENT="gpt-6-astra"
```

Una riscrittura sono un migliaio di token in ingresso e qualche migliaio in
uscita, ragionamento compreso. Astra parte da 10 dollari per milione di token in
ingresso, e l'uscita costa parecchio di più: conviene guardare il listino
Foundry prima di usarlo tutti i giorni. Si paga a consumo sulla sottoscrizione
Azure, insieme al resto.

**Lo stato dei promemoria** vive in `site-data/reminders.json`, nel container
privato. Non ha copia pubblica e non va nel seed: nasce da solo alla prima azione.

## 5. Verifica

```bash
SITE=$(az staticwebapp show -n swa-meetup -g rg-meetuptorino-p --query defaultHostname -o tsv)

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

`torino.azuremeetup.it` **non** e configurato come custom domain della SWA: il
DNS punta (CNAME) all'endpoint del Front Door `afd-meetup`, che inoltra alla
SWA. Dominio e certificato si gestiscono dal Front Door, non dalla SWA.

Per rifare o verificare il collegamento Front Door -> SWA (subscription
*Sponsorship 10k - 3*):

```bash
S=d1c41152-00b1-441b-bbbc-a41ea0dbaefc
AFD="--subscription $S -g rg-meetuptorino-p --profile-name afd-meetup"
SWA_HOST=$(az staticwebapp show -n swa-meetup -g rg-meetuptorino-p --subscription $S --query defaultHostname -o tsv)

az afd origin-group create $AFD --origin-group-name swa-meetup \
  --probe-request-type HEAD --probe-protocol Https --probe-interval-in-seconds 100 --probe-path / \
  --sample-size 4 --successful-samples-required 3 --additional-latency-in-milliseconds 50
az afd origin create $AFD --origin-group-name swa-meetup --origin-name swa-meetup \
  --host-name "$SWA_HOST" --origin-host-header "$SWA_HOST" --http-port 80 --https-port 443 \
  --priority 1 --weight 1000 --enabled-state Enabled --enforce-certificate-name-check true
az afd route update $AFD --endpoint-name torinomeetup --route-name torinomeetup \
  --origin-group swa-meetup --forwarding-protocol HttpsOnly --https-redirect Enabled \
  --supported-protocols Http Https --link-to-default-domain Enabled
```

La propagazione richiede qualche minuto. Verifica: la home su
`https://torino.azuremeetup.it/` deve rispondere con l'header
`Content-Security-Policy` (lo mette solo la SWA) ed essere identica a quella
sull'hostname `*.azurestaticapps.net`.

Se un giorno si volesse togliere il Front Door, il piano Free consente 2 domini
per app: dal portale della SWA **Custom domains > Add**, poi le istruzioni DNS
(CNAME per un sottodominio, TXT + ALIAS/ANAME per l'apex). Il certificato
viene emesso e rinnovato da Azure. In quel caso il login admin funzionerebbe
anche dal dominio custom.

## 7. Sito Global Azure (secondo hostname, stessa SWA)

Il sito di Global Azure Torino non e un deploy a parte: e la pagina
`/global-azure/` della stessa SWA, servita alla radice di un hostname dedicato
dal Front Door `afd-meetup`. Sull'endpoint `torinomeetup` ci sono due route con
pattern `/*`, distinte per dominio:

| Route | Domini | Rule set |
|---|---|---|
| `torinomeetup` | `torino.azuremeetup.it` | nessuno |
| `global-azure` | hostname di default `torinomeetup-ffc6avhbfjg7frhb.z03.azurefd.net` (+ il dominio definitivo, quando ci sara) | `globalazure` |

Entrambe inoltrano in HTTPS all'origin group `swa-meetup`, senza cache. La rule
set `globalazure` ha una sola regola, `RootToGlobalAzure`: se il path e la
radice (`/`) lo riscrive in `/global-azure/`. Tutto il resto passa invariato:
e indispensabile, perche la pagina referenzia CSS, JS e dati con percorsi
assoluti (`/assets/...`), che con un *origin path* sulla route si romperebbero.
Conseguenza: sull'hostname Global Azure `/eventi/` e gli altri percorsi del
sito principale restano raggiungibili.

L'hostname di default dell'endpoint e l'**anteprima permanente**:
`https://torinomeetup-ffc6avhbfjg7frhb.z03.azurefd.net/` mostra la pagina
Global Azure. Il sito principale non lo usa (il DNS pubblico arriva con host
`torino.azuremeetup.it`).

### Quando il dominio definitivo esiste

```bash
S=d1c41152-00b1-441b-bbbc-a41ea0dbaefc
AFD="--subscription $S -g rg-meetuptorino-p --profile-name afd-meetup"
HOST=<hostname definitivo>

az afd custom-domain create $AFD --custom-domain-name global-azure --host-name "$HOST" \
  --certificate-type ManagedCertificate --minimum-tls-version TLS12
az afd custom-domain show $AFD --custom-domain-name global-azure --query validationProperties
```

Nel DNS del dominio, due record:

1. `TXT  _dnsauth.<hostname>` = il `validationToken` restituito sopra. Il token
   scade dopo 7 giorni: se nel frattempo non e stato validato, rigenerarlo con
   `az afd custom-domain regenerate-validation-token $AFD --custom-domain-name global-azure`.
2. `CNAME <hostname>` -> `torinomeetup-ffc6avhbfjg7frhb.z03.azurefd.net`.

Quando `domainValidationState` e `Approved`, agganciare il dominio alla route:

```bash
az afd route update $AFD --endpoint-name torinomeetup --route-name global-azure \
  --formatted-custom-domains "[{id:/subscriptions/$S/resourceGroups/rg-meetuptorino-p/providers/Microsoft.Cdn/profiles/afd-meetup/customDomains/global-azure}]"
```

Il certificato gestito viene emesso da Azure in qualche minuto; la propagazione
della route fino a 20-30. Verifica: `https://<hostname>/` deve essere identica
a `https://<hostname SWA>/global-azure/`, e `https://<hostname>/assets/css/global-azure.css`
deve rispondere 200.

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
