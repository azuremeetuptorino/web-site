# Deploy su Azure Static Web Apps

Guida operativa per pubblicare il sito. Da eseguire una volta sola; dopo, ogni
push su `main` fa il deploy da solo.

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
pwsh -File ./scripts/provision-azure.ps1 -StorageAccountName azmeetuptorino -WhatIf
pwsh -File ./scripts/provision-azure.ps1 -StorageAccountName azmeetuptorino
```

`-StorageAccountName` deve essere **globalmente univoco**, 3-24 caratteri, solo
minuscole e cifre.

> **Punto di non ritorno.** Lo script crea lo storage account con
> `--allow-blob-public-access true`. Se la subscription ha la Azure Policy
> *"Storage accounts should prevent anonymous access"*, il comando fallisce.
> Non aggirarla: fermati e dimmelo, perché cambia l'architettura di lettura
> (il sito dovrebbe leggere i dati da `/api`, pagando un cold start di 1-3 s
> sulla prima visita invece di leggerli direttamente dal blob con ETag).

## 3. Collegare il repo

Dal portale Azure, sulla Static Web App appena creata: **Deployment > Source**,
scegli GitHub e autorizza il repo `azuremeetuptorino/web-site`, branch `main`.

Azure crea nel repo il secret `AZURE_STATIC_WEB_APPS_API_TOKEN`.

**Se Azure aggiunge un suo file di workflow, cancellalo.** Il nostro è
`.github/workflows/azure-static-web-apps.yml` e ha due cose che quello
generato non ha: `skip_app_build: true` (il frontend non ha build, `src/` va
caricato verbatim) e la guardia sulle PR da fork, che altrimenti fallirebbero
a ogni contributo esterno perché non ricevono i secret.

## 4. Verifica

```bash
SITE=$(az staticwebapp show -n swa-azure-meetup-torino -g rg-azure-meetup-torino --query defaultHostname -o tsv)

curl -I "https://$SITE/"                # 200 + header di sicurezza
curl -I "https://$SITE/data/team.json"  # 200, Cache-Control 300s
curl -o /dev/null -w '%{http_code}\n' "https://$SITE/pagina-inesistente"   # 404
curl -o /dev/null -w '%{http_code}\n' "https://$SITE/admin/"               # 302 verso il login
```

In PowerShell non chiamare la variabile `$host`: è una variabile automatica
riservata e l'assegnazione fallisce.

Nel browser, DevTools aperto: nessuna violazione CSP in console, carosello team
in movimento, eventi e sponsor renderizzati.

## 5. Dominio custom

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

## Configurazione da aggiornare dopo il provisioning

Il nome dello storage account non si conosce finché non esiste, quindi due
punti vanno allineati a mano (P3, quando il sito inizia a leggere dal blob):

1. `src/assets/js/config.js` → `PUBLIC_DATA_BASE`
2. `src/staticwebapp.config.json` → l'host del blob dentro `img-src` e
   `connect-src` nella `Content-Security-Policy`

## Rollback

Ogni deploy è una versione della SWA. Per tornare indietro basta rifare push
del commit precedente: il workflow ridistribuisce. I dati JSON sul blob hanno
versioning e soft delete a 7 giorni, quindi anche una scrittura sbagliata
dall'admin è recuperabile dal portale (Storage > Container > blob > Versions).
