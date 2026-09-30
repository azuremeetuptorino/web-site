import { requireRole } from './auth.js';
import { blobStore, ConflictError } from './blob.js';
import { ok, badRequest, unauthorized, forbidden, notFound, conflict, serverError } from './http.js';

/**
 * Il contratto GET/PUT di un documento JSON gestito dall'admin.
 *
 * Team e sponsor si comportano allo stesso identico modo — leggi con l'ETag,
 * valida, scrivi il master condizionato, ripubblica sul container pubblico — e
 * l'unica cosa che cambia e quale file e quale validatore. Tenerne due copie
 * significherebbe correggere ogni bug due volte e, prima o poi, correggerlo in
 * una sola: e li che una delle due perde la difesa dal conflitto.
 *
 * Gli handler accettano uno store iniettabile, cosi i test girano senza runtime
 * di Azure Functions e senza uno storage vero.
 *
 * `blobName` puo essere una funzione della richiesta, per le risorse con un
 * documento per chiave (le edizioni di Global Azure, uno per anno). Se
 * restituisce null la chiave non e valida e la risposta e 404.
 */
export function createDocumentResource({ blobName, empty, validate }) {

    const nameFor = typeof blobName === 'function' ? blobName : () => blobName;

    async function handleGet(request, context, store = blobStore) {
        const auth = requireRole(request, 'admin');
        if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

        const name = nameFor(request);
        if (!name) return notFound();

        try {
            const { etag, data } = await store.readPrivate(name);
            // Un master che non c'e ancora non e un errore: e lo stato prima del
            // primo seed. L'editor parte vuoto invece che in errore.
            return ok({ etag, data: data ?? empty }, etag ? { ETag: etag } : {});
        } catch (error) {
            return serverError(context, error, 'storage-unavailable');
        }
    }

    async function handlePut(request, context, store = blobStore) {
        const auth = requireRole(request, 'admin');
        if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

        const name = nameFor(request);
        if (!name) return notFound();

        let body;
        try {
            body = await request.json();
        } catch {
            return badRequest('invalid-json');
        }

        const result = validate(body?.data ?? body);
        if (!result.ok) return badRequest('validation', { issues: result.issues });

        const document = {
            ...result.value,
            updatedAt: new Date().toISOString(),
            updatedBy: auth.principal.userDetails ?? auth.principal.userId ?? 'sconosciuto'
        };

        // Senza If-Match la richiesta vale come "sto creando il documento": se
        // nel frattempo esiste, la scrittura fallisce invece di sovrascrivere
        // alla cieca il lavoro di qualcun altro.
        const ifMatch = request.headers.get('if-match') ?? undefined;

        let written;
        try {
            written = await store.writePrivate(name, document, { ifMatch, ifAbsent: !ifMatch });
        } catch (error) {
            if (error instanceof ConflictError) return conflictResponse(context, store, name);
            return serverError(context, error, 'storage-unavailable');
        }

        // Il master e salvato. Se la ripubblicazione fallisce NON e un errore
        // della richiesta: i dati ci sono e non vanno persi. Si risponde 200
        // dicendo che la pubblicazione non e riuscita, cosi l'admin sa che il
        // sito pubblico e ancora indietro e puo risalvare.
        try {
            await store.publishPublic(name, document);
        } catch (error) {
            context.error(error);
            return ok({
                etag: written.etag,
                updatedAt: document.updatedAt,
                published: false,
                publishedAt: null
            });
        }

        return ok({
            etag: written.etag,
            updatedAt: document.updatedAt,
            published: true,
            publishedAt: new Date().toISOString()
        });
    }

    /**
     * Il 409 porta con se la copia del server.
     *
     * Senza, l'editor potrebbe solo dire "ricarica" e l'admin perderebbe quello
     * che ha scritto. Con la copia puo mostrare le due versioni e far scegliere.
     */
    async function conflictResponse(context, store, name) {
        try {
            const current = await store.readPrivate(name);
            return conflict({ etag: current.etag, data: current.data ?? empty });
        } catch (error) {
            return serverError(context, error, 'storage-unavailable');
        }
    }

    /**
     * Una sola registrazione per entrambi i metodi: due function sulla stessa
     * route si contenderebbero il match nel runtime.
     */
    async function handle(request, context, store = blobStore) {
        return request.method === 'PUT'
            ? handlePut(request, context, store)
            : handleGet(request, context, store);
    }

    return { handleGet, handlePut, handle };
}
