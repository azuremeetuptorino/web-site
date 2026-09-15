import { apiPost, ApiError, SessionExpiredError } from './api.js';

/**
 * Caricamento di un'immagine su /api/assets.
 *
 * Perche base64 dentro un JSON e non multipart: l'API e fatta di poche
 * function e un solo formato di richiesta: JSON. Parsare multipart a mano e un
 * errore, e aggiungere una libreria per due form costa un cold start a ogni
 * risveglio delle function. Il prezzo e il 33% di byte in piu sulla rete, che
 * su un file da mezzo mega e trascurabile.
 *
 * I controlli client sono una cortesia, non una difesa: dicono subito "questo
 * file e troppo grosso" senza spedire 4 MB per sentirselo dire dopo. Quelli
 * veri stanno nella function, che guarda anche i byte e non si fida del tipo
 * dichiarato dal browser.
 */

export const MAX_BYTES = 512 * 1024;

export const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];

/** Valore pronto per l'attributo accept di <input type="file">. */
export const ACCEPT_ATTRIBUTE = ACCEPTED_TYPES.join(',');

/** Errore gia scritto in italiano: chi chiama puo mostrare `message` com'e. */
export class UploadError extends Error {
    constructor(message) {
        super(message);
        this.name = 'UploadError';
    }
}

const kb = (bytes) => `${Math.round(bytes / 1024)} KB`;

/** Il file arriva in base64 senza il prefisso `data:tipo;base64,`. */
function toBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(new UploadError('Non riesco a leggere il file dal disco.'));
        reader.onload = () => {
            const result = String(reader.result);
            const comma = result.indexOf(',');
            if (comma < 0) {
                reject(new UploadError('Il file non e leggibile come immagine.'));
                return;
            }
            resolve(result.slice(comma + 1));
        };
        reader.readAsDataURL(file);
    });
}

function messageFor(error) {
    const payload = error.payload ?? {};

    if (payload.error === 'too-large') {
        return `Il file pesa ${kb(payload.bytes ?? 0)}, il limite e ${kb(payload.maxBytes ?? MAX_BYTES)}.`;
    }
    if (payload.error === 'unsupported-type') {
        return payload.detected === null
            ? 'Il contenuto del file non e un’immagine, qualunque cosa dica il nome.'
            : 'Formato non ammesso. Servono PNG, JPEG, WebP o SVG.';
    }
    if (error.status === 403) return 'Il tuo account non ha il ruolo admin: il caricamento e stato rifiutato.';
    if (payload.message) return payload.message;

    return `Il server ha rifiutato il file (${error.status}).`;
}

/**
 * @param {File} file
 * @param {'avatar' | 'sponsor'} kind
 * @returns {Promise<string>} la URL pubblica da scrivere nel campo
 * @throws {UploadError | SessionExpiredError}
 */
export async function uploadImage(file, kind) {
    if (!ACCEPTED_TYPES.includes(file.type)) {
        throw new UploadError('Formato non ammesso. Servono PNG, JPEG, WebP o SVG.');
    }
    if (file.size > MAX_BYTES) {
        throw new UploadError(`Il file pesa ${kb(file.size)}, il limite e ${kb(MAX_BYTES)}.`);
    }

    const dataBase64 = await toBase64(file);

    try {
        const { payload } = await apiPost('/api/assets', {
            kind,
            filename: file.name,
            contentType: file.type,
            dataBase64
        });
        return payload.url;
    } catch (error) {
        // La sessione scaduta risale intatta: non e un problema del file, e chi
        // chiama deve poterla distinguere per non buttare via le modifiche.
        if (error instanceof SessionExpiredError) throw error;
        if (error instanceof ApiError) throw new UploadError(messageFor(error));

        console.error('[admin] upload fallito', error);
        throw new UploadError('Caricamento non riuscito. Controlla la connessione e riprova.');
    }
}
