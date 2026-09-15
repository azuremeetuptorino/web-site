#!/usr/bin/env bash
# Eseguito una volta sola, alla creazione del container.
set -euo pipefail

echo "==> Dipendenze del tooling di sviluppo"
npm install --no-audit --no-fund

echo "==> Dipendenze delle managed functions"
npm --prefix api install --no-audit --no-fund

# Non e versionato (contiene la connection string) e senza di lui le function
# non sanno dove sta lo storage: /api/team risponderebbe 500 al primo avvio.
echo "==> local.settings.json"
if [ ! -f api/local.settings.json ]; then
  cp api/local.settings.example.json api/local.settings.json
  echo "    creato da api/local.settings.example.json"
else
  echo "    gia presente, lasciato com'e"
fi

echo "==> Azurite: container, CORS e dati di partenza"
# Azurite deve essere gia in ascolto: lo avvia post-start.sh, ma alla prima
# creazione non e ancora partito, quindi lo tiriamo su il tempo di preparare lo
# storage e poi lo spegniamo.
npx azurite --silent --location .azurite --skipApiVersionCheck &
AZURITE_PID=$!
trap 'kill "$AZURITE_PID" 2>/dev/null || true' EXIT

for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:10000/devstoreaccount1?comp=list"; then break; fi
  sleep 1
done

export AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true"

# Senza `|| true` un container gia esistente farebbe fallire lo script, ma il
# messaggio di az resta a video: se fallisce per un altro motivo si vede.
az storage container create --name site-data --output none || true
az storage container create --name public --public-access blob --output none || true

# Il sito gira su :4280 e legge i dati da :10000, quindi e una richiesta
# cross-origin: senza CORS il browser la blocca e il sito ripiega in silenzio
# sui file del deploy, nascondendo proprio il percorso da testare.
az storage cors clear --services b --output none || true
az storage cors add --services b \
  --methods GET HEAD OPTIONS --origins '*' --allowed-headers '*' \
  --exposed-headers ETag Content-Length --max-age 3600 --output none || true

npm run seed

cat <<'EOF'

===========================================================
 Pronto.

   npm start        emulatore SWA su http://localhost:4280
   npm test         test delle managed functions
   npm run seed     ricarica src/data/*.json sul blob

 Azurite parte da solo a ogni avvio del container.

 Per entrare in /admin: apri /.auth/login/aad, metti uno
 username qualsiasi e nel campo dei ruoli scrivi  admin
 (uno per riga).
===========================================================
EOF
