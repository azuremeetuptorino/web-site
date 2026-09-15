/**
 * Configurazione runtime risolta a browser, senza build step.
 *
 * In P0 i dati arrivano dai file statici serviti insieme al sito.
 * In P1 PUBLIC_DATA_BASE punterà al container blob pubblico e
 * LOCAL_DATA_BASE resterà come ultima rete di sicurezza: se il blob
 * non risponde il sito continua a mostrare i dati imbarcati nel deploy.
 */

const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

export const IS_LOCAL = LOCAL_HOSTS.includes(location.hostname);

/** Sorgente primaria dei dati pubblici. */
export const PUBLIC_DATA_BASE = '/data';

/** Copia imbarcata nel deploy, usata se la sorgente primaria fallisce. */
export const LOCAL_DATA_BASE = '/data';

/** Link esterni usati negli stati di errore e nelle CTA. */
export const MEETUP_GROUP_URL = 'https://www.meetup.com/it-IT/azure-meetup-torino/';
export const SESSIONIZE_URL = 'https://sessionize.com/azure-meetup-torino';

/** Immagini di riserva quando un record non ha la sua. */
export const PLACEHOLDER_AVATAR = '/assets/img/placeholder-avatar.svg';
export const PLACEHOLDER_EVENT = '/assets/img/placeholder-event.svg';
export const PLACEHOLDER_LOGO = '/assets/img/placeholder-logo.svg';
