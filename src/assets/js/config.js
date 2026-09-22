/**
 * Configurazione runtime risolta a browser, senza build step.
 *
 * La sorgente primaria dei dati e il container blob pubblico, non `/api`: le
 * managed functions sono su Consumption e pagherebbero 1-3 s di cold start su
 * ogni visita, mentre SWA non mette in cache le risposte delle API.
 *
 * LOCAL_DATA_BASE resta l'ultima rete di sicurezza: se il blob non risponde il
 * sito mostra i dati imbarcati nell'ultimo deploy invece di svuotarsi.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const IS_LOCAL = LOCAL_HOSTS.includes(location.hostname);

/**
 * Nome dell'account di storage che serve i dati pubblici.
 *
 * Svuotandolo il sito ripiega sui JSON del deploy: e lo stato corretto finche le
 * risorse Azure non esistono, meglio di una fetch che fallisce a ogni visita.
 * Cambiandolo va aggiornato lo stesso host in img-src e connect-src nella CSP di
 * staticwebapp.config.json, altrimenti il browser blocca la lettura.
 *
 * Da non confondere con `stazuremeetuptorino` (senza 2), nella stessa resource
 * group: quello serve il sito vecchio da `$web` dietro Front Door.
 */
const STORAGE_ACCOUNT = 'stazuremeetuptorino2';

/** In locale il container pubblico e quello di Azurite. */
const AZURITE_PUBLIC = 'http://127.0.0.1:10000/devstoreaccount1/public';

/** Sorgente primaria dei dati pubblici. */
export const PUBLIC_DATA_BASE = IS_LOCAL
    ? AZURITE_PUBLIC
    : (STORAGE_ACCOUNT ? `https://${STORAGE_ACCOUNT}.blob.core.windows.net/public` : '/data');

/** Copia imbarcata nel deploy, usata se la sorgente primaria fallisce. */
export const LOCAL_DATA_BASE = '/data';

/** Link esterni usati negli stati di errore e nelle CTA. */
export const MEETUP_GROUP_URL = 'https://www.meetup.com/it-IT/meetup-microsoft-azure-torino/';
export const SESSIONIZE_URL = 'https://sessionize.com/azure-meetup-torino';

/** Immagini di riserva quando un record non ha la sua. */
export const PLACEHOLDER_AVATAR = '/assets/img/placeholder-avatar.svg';
export const PLACEHOLDER_EVENT = '/assets/img/placeholder-event.svg';
export const PLACEHOLDER_LOGO = '/assets/img/placeholder-logo.svg';
