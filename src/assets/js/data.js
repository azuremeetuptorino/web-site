import { PUBLIC_DATA_BASE, LOCAL_DATA_BASE } from './config.js';

/**
 * Carica una collezione JSON provando le sorgenti in ordine.
 *
 * Catena: sorgente pubblica (dalla P1 il blob) -> copia imbarcata nel deploy.
 * Se entrambe falliscono l'errore risale al chiamante, che mostra uno stato
 * di errore nella sua sezione senza affossare il resto della pagina.
 */
export async function loadCollection(name) {
    const sources = [...new Set([
        `${PUBLIC_DATA_BASE}/${name}.json`,
        `${LOCAL_DATA_BASE}/${name}.json`
    ])];

    let lastError;
    for (const url of sources) {
        try {
            const response = await fetch(url, { cache: 'no-cache' });
            if (!response.ok) {
                throw new Error(`${url} ha risposto ${response.status}`);
            }
            return await response.json();
        } catch (error) {
            lastError = error;
            console.warn(`[data] sorgente non disponibile: ${url}`, error);
        }
    }

    throw lastError ?? new Error(`nessuna sorgente disponibile per ${name}`);
}
