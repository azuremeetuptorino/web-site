/**
 * Accesso a Blob Storage per i documenti JSON del sito.
 *
 * Due container in un account dedicato:
 *  - `site-data` (privato) tiene i master, quelli che l'admin modifica;
 *  - `public` (lettura anonima) tiene la copia che legge il sito pubblico.
 *
 * Le managed functions di SWA non supportano Managed Identity ne i riferimenti
 * a Key Vault: la connection string arriva dall'app setting
 * DATA_STORAGE_CONNECTION. Il nome non e casuale, i prefissi AZUREBLOBSTORAGE_,
 * WEBSITE_, FUNCTIONS_ e AzureWeb sono riservati da SWA.
 *
 * CONCORRENZA. Le function scalano su piu istanze, quindi un lock in-process
 * non difende da niente: l'unica difesa e l'optimistic concurrency dello
 * storage. La lettura restituisce l'ETag, la scrittura lo rimanda in If-Match,
 * e il 412 dello storage diventa qui una ConflictError con la copia del server.
 */

import { BlobServiceClient } from '@azure/storage-blob';

const JSON_CONTENT_TYPE = 'application/json; charset=utf-8';

/**
 * 300 s di cache piena piu una giornata di stale-while-revalidate: una modifica
 * dall'admin si vede sul sito entro 5 minuti, e se lo storage ha un singhiozzo
 * il browser continua a servire l'ultima copia buona invece di una pagina vuota.
 */
const PUBLIC_CACHE_CONTROL = 'public, max-age=300, stale-while-revalidate=86400';

/** Sollevata quando If-Match non corrisponde: qualcun altro ha gia salvato. */
export class ConflictError extends Error {
    constructor() {
        super('Il documento e stato modificato da qualcun altro');
        this.name = 'ConflictError';
    }
}

/** Sollevata quando manca la configurazione: e un errore di deploy, non di input. */
export class StorageNotConfiguredError extends Error {
    constructor() {
        super('DATA_STORAGE_CONNECTION non e configurata');
        this.name = 'StorageNotConfiguredError';
    }
}

let cachedService = null;

/**
 * Il client si costruisce alla prima richiesta e non all'import: durante i test
 * unitari il modulo viene importato senza che esista nessuna connection string.
 */
function service() {
    if (cachedService) return cachedService;

    const connectionString = process.env.DATA_STORAGE_CONNECTION;
    if (!connectionString) throw new StorageNotConfiguredError();

    cachedService = BlobServiceClient.fromConnectionString(connectionString);
    return cachedService;
}

export const PRIVATE_CONTAINER = () => process.env.CONTAINER_PRIVATE || 'site-data';
export const PUBLIC_CONTAINER = () => process.env.CONTAINER_PUBLIC || 'public';

function blob(container, path) {
    return service().getContainerClient(container).getBlockBlobClient(path);
}

/**
 * Gli intermediari possono trasformare un ETag forte in uno debole (`W/"..."`).
 * Lo riportiamo alla forma forte prima di usarlo come condizione, altrimenti lo
 * storage risponde 412 anche quando il documento non e cambiato.
 */
function strongEtag(value) {
    if (!value) return undefined;
    const trimmed = String(value).trim();
    return trimmed.startsWith('W/') ? trimmed.slice(2) : trimmed;
}

async function readAll(stream) {
    const chunks = [];
    for await (const chunk of stream) chunks.push(chunk);
    return Buffer.concat(chunks).toString('utf8');
}

/**
 * Legge un documento JSON.
 *
 * Un blob che non esiste non e un errore: e lo stato del primo avvio, prima che
 * i seed siano stati caricati. Il chiamante lo riconosce da `etag: null`.
 *
 * @returns {Promise<{etag: string | null, data: unknown | null}>}
 */
export async function readJson(container, path) {
    try {
        const response = await blob(container, path).download();
        const text = await readAll(response.readableStreamBody);
        return { etag: response.etag ?? null, data: JSON.parse(text) };
    } catch (error) {
        if (error?.statusCode === 404) return { etag: null, data: null };
        throw error;
    }
}

/**
 * Scrive un documento JSON.
 *
 * @param {object} options
 * @param {string} [options.ifMatch]   ETag atteso; se non corrisponde -> ConflictError.
 * @param {boolean} [options.ifAbsent] scrive solo se il blob non esiste ancora.
 * @returns {Promise<{etag: string, lastModified: string}>}
 */
export async function writeJson(container, path, data, options = {}) {
    const body = Buffer.from(`${JSON.stringify(data, null, 2)}\n`, 'utf8');

    const conditions = {};
    if (options.ifMatch) conditions.ifMatch = strongEtag(options.ifMatch);
    if (options.ifAbsent) conditions.ifNoneMatch = '*';

    try {
        const response = await blob(container, path).upload(body, body.length, {
            conditions,
            blobHTTPHeaders: {
                blobContentType: JSON_CONTENT_TYPE,
                blobCacheControl: options.cacheControl
            }
        });
        return {
            etag: response.etag,
            lastModified: (response.lastModified ?? new Date()).toISOString()
        };
    } catch (error) {
        // 412 = If-Match fallito, 409 = il blob esisteva gia con ifAbsent.
        // Per chi chiama sono la stessa cosa: hai perso la gara, rileggi.
        if (error?.statusCode === 412 || error?.statusCode === 409) throw new ConflictError();
        throw error;
    }
}

/** Legge un master dal container privato. */
export const readPrivate = (path) => readJson(PRIVATE_CONTAINER(), path);

/** Scrive un master nel container privato. Niente cache: non lo legge nessun browser. */
export const writePrivate = (path, data, options) =>
    writeJson(PRIVATE_CONTAINER(), path, data, options);

/**
 * Ripubblica il documento sul container pubblico.
 *
 * Nessuna condizione: la copia pubblica e derivata, l'ultima scrittura vince.
 * Il master privato e gia stato protetto dall'If-Match.
 */
export const publishPublic = (path, data) =>
    writeJson(PUBLIC_CONTAINER(), path, data, { cacheControl: PUBLIC_CACHE_CONTROL });

/** Store di default delle function. I test ne iniettano uno finto. */
export const blobStore = { readPrivate, writePrivate, publishPublic };
