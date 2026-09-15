#!/usr/bin/env bash
# Eseguito una volta sola, alla creazione del container.
set -euo pipefail

echo "==> Dipendenze del tooling di sviluppo"
npm install --no-audit --no-fund

echo "==> Dipendenze delle managed functions"
npm --prefix api install --no-audit --no-fund

echo "==> Container Azurite"
# Azurite deve essere gia in ascolto: lo avvia post-start.sh, ma alla prima
# creazione non e ancora partito, quindi lo tiriamo su il tempo di creare i
# container e poi lo spegniamo.
npx azurite --silent --location .azurite --skipApiVersionCheck &
AZURITE_PID=$!
for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:10000/devstoreaccount1?comp=list"; then break; fi
  sleep 1
done

export AZURE_STORAGE_CONNECTION_STRING="UseDevelopmentStorage=true"
az storage container create --name site-data --output none 2>/dev/null || true
az storage container create --name public --public-access blob --output none 2>/dev/null || true

kill "$AZURITE_PID" 2>/dev/null || true
wait "$AZURITE_PID" 2>/dev/null || true

cat <<'EOF'

===========================================================
 Pronto.

   npm start        emulatore SWA su http://localhost:4280
   npm test         test delle managed functions

 Azurite parte da solo a ogni avvio del container.

 Per entrare in /admin: apri /.auth/login/aad, metti uno
 username qualsiasi e nel campo dei ruoli scrivi  admin
 (uno per riga).
===========================================================
EOF
