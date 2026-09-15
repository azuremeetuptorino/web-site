#!/usr/bin/env bash
# Eseguito a ogni avvio del container: tiene Azurite sempre in ascolto, cosi
# non serve un secondo terminale dedicato.
set -euo pipefail

if curl -s -o /dev/null "http://127.0.0.1:10000/devstoreaccount1?comp=list"; then
  echo "Azurite gia in ascolto."
  exit 0
fi

mkdir -p .azurite
nohup npx azurite --silent --location .azurite --skipApiVersionCheck \
  > .azurite/azurite.log 2>&1 &

for _ in $(seq 1 30); do
  if curl -s -o /dev/null "http://127.0.0.1:10000/devstoreaccount1?comp=list"; then
    echo "Azurite avviato su 10000/10001/10002."
    exit 0
  fi
  sleep 1
done

echo "Azurite non ha risposto entro 30s: vedi .azurite/azurite.log" >&2
