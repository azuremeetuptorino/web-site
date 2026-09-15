import { app } from '@azure/functions';

import { requireRole } from '../lib/auth.js';
import { blobStore } from '../lib/blob.js';
import { prepareUpload } from '../lib/image.js';
import { created, badRequest, unauthorized, forbidden, json, serverError } from '../lib/http.js';

/**
 * POST /api/assets — carica un avatar o il logo di uno sponsor.
 *
 * Il file va nel container pubblico e la risposta ne restituisce la URL, che
 * l'editor scrive nel campo del membro o dello sponsor. Da quel momento in poi
 * l'immagine e un dato come gli altri: il sito la legge dallo stesso host dei
 * JSON, senza dipendere da un CDN altrui che puo cambiarla o farla sparire.
 *
 * Non si cancella mai niente. Sostituendo una foto, la vecchia resta sul blob
 * orfana: costa frazioni di centesimo, e in cambio una URL gia finita in cache
 * o in un'anteprima social non diventa un 404. Se un giorno desse fastidio, la
 * pulizia si fa con un passaggio che confronta i blob con le URL citate nei
 * JSON — non cancellando al volo, che e il modo per perdere il file sbagliato.
 */
export async function handlePostAsset(request, context, store = blobStore) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

    let body;
    try {
        body = await request.json();
    } catch {
        return badRequest('invalid-json');
    }

    const prepared = prepareUpload(body);
    if (!prepared.ok) return json(prepared.status, prepared.body);

    try {
        const { url } = await store.uploadPublicAsset(
            prepared.asset.path,
            prepared.asset.body,
            prepared.asset.headers
        );
        return created({ url, path: prepared.asset.path, bytes: prepared.asset.body.length });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
}

app.http('assets', {
    route: 'assets',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handlePostAsset
});
