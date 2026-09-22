<#
.SYNOPSIS
    Crea le risorse Azure del sito Azure Meetup Torino.

.DESCRIPTION
    Provisiona, in modo idempotente:
      - un resource group
      - una Static Web App (piano Free)
      - un account di storage dedicato con due container:
          * public    -> lettura anonima, dati e immagini serviti al sito pubblico
          * site-data -> privato, master JSON e cache
      - CORS di servizio sul blob e versioning + soft delete

    Lo script NON collega il repo GitHub: quel passaggio si fa una volta sola
    dal portale (o con --source/--token) e produce il secret di deploy.

    Richiede Azure CLI:  https://aka.ms/installazurecliwindows
    Prima di lanciarlo:  az login

.PARAMETER StorageAccountName
    Deve essere globalmente univoco, 3-24 caratteri, solo minuscole e cifre.

.PARAMETER StorageLocation
    Regione dello storage account, separata da quella della Static Web App perche
    la SWA esiste solo in alcune regioni (West Europe, Central US, East US 2,
    West US 2, East Asia) mentre lo storage puo stare piu vicino a chi legge.

.EXAMPLE
    ./scripts/provision-azure.ps1 -StorageAccountName stazuremeetuptorino2 -StorageLocation italynorth -WhatIf
    ./scripts/provision-azure.ps1 -StorageAccountName stazuremeetuptorino2 -StorageLocation italynorth
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $ResourceGroup = 'rg-lrizzi-meetup',
    [string] $Location = 'westeurope',
    [string] $StaticWebAppName = 'swa-meetup',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9]{3,24}$')]
    [string] $StorageAccountName,

    [string] $StorageLocation = $Location,

    [string] $PublicContainer = 'public',
    [string] $PrivateContainer = 'site-data'
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    param([string[]] $Arguments, [string] $What)
    # L'eco del comando e utile per capire cosa sta succedendo, ma la connection
    # string contiene la chiave dell'account: finirebbe nel log del terminale,
    # nella cronologia della shell e in quella della CI. Va oscurata.
    $echoed = @()
    for ($i = 0; $i -lt $Arguments.Count; $i++) {
        $echoed += $Arguments[$i]
        if ($Arguments[$i] -eq '--connection-string' -and $i + 1 -lt $Arguments.Count) {
            $echoed += '***'
            $i++
        }
    }
    Write-Host "  az $($echoed -join ' ')" -ForegroundColor DarkGray
    if (-not $PSCmdlet.ShouldProcess($What, 'az')) { return $null }
    $output = & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "az ha restituito $LASTEXITCODE per: $What" }
    return $output
}

if ($null -eq (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI non trovata. Installala da https://aka.ms/installazurecliwindows, poi esegui az login.'
}

Write-Host "`n[1/7] Resource group $ResourceGroup" -ForegroundColor Cyan
# Su una RG che esiste gia il comando e idempotente e non ne sposta la regione:
# passiamo $StorageLocation perche e li che sta il grosso delle risorse.
Invoke-Az @('group', 'create', '--name', $ResourceGroup, '--location', $StorageLocation, '--output', 'none') "resource group $ResourceGroup"

Write-Host "`n[2/7] Static Web App $StaticWebAppName (piano Free)" -ForegroundColor Cyan
Invoke-Az @('staticwebapp', 'create',
    '--name', $StaticWebAppName,
    '--resource-group', $ResourceGroup,
    '--location', $Location,
    '--sku', 'Free',
    '--output', 'none') "static web app $StaticWebAppName"

Write-Host "`n[3/7] Storage account $StorageAccountName ($StorageLocation)" -ForegroundColor Cyan
# allow-blob-public-access serve al container pubblico: se una Azure Policy
# lo vieta, questo comando fallisce ed e il momento di fermarsi e ripianificare.
# allow-shared-key-access e il default, ma lo chiediamo esplicito perche qui non
# e negoziabile: le managed functions di SWA non supportano Managed Identity ne i
# riferimenti a Key Vault, quindi l'unico modo che hanno di scrivere sul blob e
# la connection string con la chiave dell'account.
Invoke-Az @('storage', 'account', 'create',
    '--name', $StorageAccountName,
    '--resource-group', $ResourceGroup,
    '--location', $StorageLocation,
    '--sku', 'Standard_LRS',
    '--kind', 'StorageV2',
    '--access-tier', 'Hot',
    '--min-tls-version', 'TLS1_2',
    '--allow-blob-public-access', 'true',
    '--allow-shared-key-access', 'true',
    '--output', 'none') "storage account $StorageAccountName"

Write-Host "`n[4/7] Recupero connection string" -ForegroundColor Cyan
$connectionString = $null
if ($PSCmdlet.ShouldProcess("connection string di $StorageAccountName", 'az')) {
    $connectionString = (& az storage account show-connection-string `
            --name $StorageAccountName --resource-group $ResourceGroup `
            --query connectionString --output tsv)
    if ($LASTEXITCODE -ne 0) { throw 'Impossibile leggere la connection string.' }
}

Write-Host "`n[5/7] Container" -ForegroundColor Cyan
if ($connectionString) {
    Invoke-Az @('storage', 'container', 'create', '--name', $PrivateContainer,
        '--connection-string', $connectionString, '--output', 'none') "container $PrivateContainer (privato)"
    Invoke-Az @('storage', 'container', 'create', '--name', $PublicContainer,
        '--public-access', 'blob',
        '--connection-string', $connectionString, '--output', 'none') "container $PublicContainer (lettura anonima)"
}

Write-Host "`n[6/7] CORS del servizio blob" -ForegroundColor Cyan
# La CORS dei blob e a livello di servizio, non di container. Gli ambienti di
# preview di SWA hanno hostname casuali *.azurestaticapps.net, quindi una
# allowlist di origini si romperebbe a ogni PR. I dati sono pubblici: '*' va bene.
#
# Questo e l'unico step che NON passa da Invoke-Az: su Linux PowerShell espande i
# wildcard degli argomenti che arrivano da una variabile o da un array contro i
# file della directory corrente, e '*' diventerebbe l'elenco del repo (verificato
# su 7.6, ne il backtick ne PSNativeCommandArgumentPassing lo impediscono).
# Scritto inline come letterale, invece, arriva ad az intatto. L'errore e
# silenzioso: az accetta la regola e il preflight risponde 403 a ogni fetch.
if ($connectionString) {
    if ($PSCmdlet.ShouldProcess('regole CORS di lettura', 'az')) {
        Write-Host '  az storage cors clear --services b --connection-string *** --output none' -ForegroundColor DarkGray
        & az storage cors clear --services b --connection-string $connectionString --output none
        if ($LASTEXITCODE -ne 0) { throw 'az ha restituito errore per: pulizia regole CORS' }

        Write-Host '  az storage cors add --services b --methods GET HEAD OPTIONS --origins * --allowed-headers * --exposed-headers ETag Content-Length --max-age 3600 --connection-string *** --output none' -ForegroundColor DarkGray
        & az storage cors add --services b --methods GET HEAD OPTIONS `
            --origins "*" --allowed-headers "*" `
            --exposed-headers ETag Content-Length --max-age 3600 `
            --connection-string $connectionString --output none
        if ($LASTEXITCODE -ne 0) { throw 'az ha restituito errore per: regola CORS di lettura' }
    }
}

Write-Host "`n[7/7] Versioning e soft delete (rete di sicurezza sulle scritture admin)" -ForegroundColor Cyan
Invoke-Az @('storage', 'account', 'blob-service-properties', 'update',
    '--account-name', $StorageAccountName,
    '--resource-group', $ResourceGroup,
    '--enable-versioning', 'true',
    '--enable-delete-retention', 'true',
    '--delete-retention-days', '7',
    '--enable-container-delete-retention', 'true',
    '--container-delete-retention-days', '7',
    '--output', 'none') 'versioning + soft delete 7 giorni'

if ($WhatIfPreference) {
    Write-Host "`nEsecuzione simulata: nessuna risorsa creata." -ForegroundColor Yellow
    return
}

$hostname = (& az staticwebapp show --name $StaticWebAppName --resource-group $ResourceGroup --query defaultHostname --output tsv)

Write-Host "`n=== Fatto ===" -ForegroundColor Green
Write-Host "Static Web App : https://$hostname"
Write-Host "Blob pubblico  : https://$StorageAccountName.blob.core.windows.net/$PublicContainer"
Write-Host ""
Write-Host "Prossimi passi:" -ForegroundColor Cyan
Write-Host "  1. Collega il repo GitHub alla Static Web App dal portale Azure"
Write-Host "     (Deployment > Source). Azure creera il secret"
Write-Host "     AZURE_STATIC_WEB_APPS_API_TOKEN nel repo."
Write-Host "  2. Se Azure aggiunge un suo workflow, cancellalo: usiamo"
Write-Host "     .github/workflows/azure-static-web-apps.yml gia presente."
Write-Host "  3. Aggiorna STORAGE_ACCOUNT in src/assets/js/config.js e l'host"
Write-Host "     del blob dentro img-src/connect-src in src/staticwebapp.config.json."
Write-Host ""
Write-Host "Connection string da mettere nelle app settings della SWA (P3):" -ForegroundColor Cyan
Write-Host "  az staticwebapp appsettings set --name $StaticWebAppName \"
Write-Host "    --setting-names DATA_STORAGE_CONNECTION=`"<connection string>`""
