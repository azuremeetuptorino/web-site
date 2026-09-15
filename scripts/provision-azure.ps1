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

.EXAMPLE
    ./scripts/provision-azure.ps1 -StorageAccountName azmeetuptorino -WhatIf
    ./scripts/provision-azure.ps1 -StorageAccountName azmeetuptorino
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string] $ResourceGroup = 'rg-azure-meetup-torino',
    [string] $Location = 'westeurope',
    [string] $StaticWebAppName = 'swa-azure-meetup-torino',

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[a-z0-9]{3,24}$')]
    [string] $StorageAccountName,

    [string] $PublicContainer = 'public',
    [string] $PrivateContainer = 'site-data'
)

$ErrorActionPreference = 'Stop'

function Invoke-Az {
    param([string[]] $Arguments, [string] $What)
    Write-Host "  az $($Arguments -join ' ')" -ForegroundColor DarkGray
    if (-not $PSCmdlet.ShouldProcess($What, 'az')) { return $null }
    $output = & az @Arguments
    if ($LASTEXITCODE -ne 0) { throw "az ha restituito $LASTEXITCODE per: $What" }
    return $output
}

if ($null -eq (Get-Command az -ErrorAction SilentlyContinue)) {
    throw 'Azure CLI non trovata. Installala da https://aka.ms/installazurecliwindows, poi esegui az login.'
}

Write-Host "`n[1/7] Resource group $ResourceGroup" -ForegroundColor Cyan
Invoke-Az @('group', 'create', '--name', $ResourceGroup, '--location', $Location, '--output', 'none') "resource group $ResourceGroup"

Write-Host "`n[2/7] Static Web App $StaticWebAppName (piano Free)" -ForegroundColor Cyan
Invoke-Az @('staticwebapp', 'create',
    '--name', $StaticWebAppName,
    '--resource-group', $ResourceGroup,
    '--location', $Location,
    '--sku', 'Free',
    '--output', 'none') "static web app $StaticWebAppName"

Write-Host "`n[3/7] Storage account $StorageAccountName" -ForegroundColor Cyan
# allow-blob-public-access serve al container pubblico: se una Azure Policy
# lo vieta, questo comando fallisce ed e il momento di fermarsi e ripianificare.
Invoke-Az @('storage', 'account', 'create',
    '--name', $StorageAccountName,
    '--resource-group', $ResourceGroup,
    '--location', $Location,
    '--sku', 'Standard_LRS',
    '--kind', 'StorageV2',
    '--access-tier', 'Hot',
    '--min-tls-version', 'TLS1_2',
    '--allow-blob-public-access', 'true',
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
if ($connectionString) {
    Invoke-Az @('storage', 'cors', 'clear', '--services', 'b',
        '--connection-string', $connectionString, '--output', 'none') 'pulizia regole CORS'
    Invoke-Az @('storage', 'cors', 'add', '--services', 'b',
        '--methods', 'GET', 'HEAD', 'OPTIONS',
        '--origins', '*',
        '--allowed-headers', '*',
        '--exposed-headers', 'ETag', 'Content-Length',
        '--max-age', '3600',
        '--connection-string', $connectionString, '--output', 'none') 'regola CORS di lettura'
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
Write-Host "  3. Aggiorna PUBLIC_DATA_BASE in src/assets/js/config.js e l'host"
Write-Host "     del blob dentro img-src/connect-src in src/staticwebapp.config.json."
Write-Host ""
Write-Host "Connection string da mettere nelle app settings della SWA (P3):" -ForegroundColor Cyan
Write-Host "  az staticwebapp appsettings set --name $StaticWebAppName \"
Write-Host "    --setting-names DATA_STORAGE_CONNECTION=`"<connection string>`""
