import { app } from '@azure/functions';

import { requireRole } from '../lib/auth.js';
import { blobStore, ConflictError } from '../lib/blob.js';
import { validateTeam } from '../lib/validate.js';
import { ok, badRequest, unauthorized, forbidden, conflict, serverError } from '../lib/http.js';

/**
 * GET/PUT /api/team — il master del team.
 *
 * Il sito pubblico NON passa di qui: legge direttamente il container blob
 * pubblico. Queste function servono solo all'editor dell'admin, e sono la sola
 * cosa che scrive su `site-data/team.json`.
 *
 * Ogni PUT fa due scritture: il master privato (condizionato dall'ETag) e la
 * ripubblicazione su `public/team.json` con la sua Cache-Control. La seconda non
 * e condizionata: e una copia derivata, l'ultima scrittura vince.
 *
 * Gli handler sono esportati a parte, con lo store iniettabile, per poterli
 * testare senza il runtime di Azure Functions e senza uno storage vero.
 */

const TEAM_BLOB = 'team.json';

/** Prima che i seed siano caricati il master non esiste: l'editor parte vuoto, non in errore. */
const EMPTY_TEAM = { version: 1, members: [] };

export async function handleGetTeam(request, context, store = blobStore) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

    try {
        const { etag, data } = await store.readPrivate(TEAM_BLOB);
        return ok(
            { etag, data: data ?? EMPTY_TEAM },
            etag ? { ETag: etag } : {}
        );
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
}

export async function handlePutTeam(request, context, store = blobStore) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

    let body;
    try {
        body = await request.json();
    } catch {
        return badRequest('invalid-json');
    }

    const result = validateTeam(body?.data ?? body);
    if (!result.ok) return badRequest('validation', { issues: result.issues });

    const document = {
        ...result.value,
        updatedAt: new Date().toISOString(),
        updatedBy: auth.principal.userDetails ?? auth.principal.userId ?? 'sconosciuto'
    };

    // Senza If-Match la richiesta vale come "sto creando il documento": se nel
    // frattempo esiste, la scrittura fallisce invece di sovrascrivere alla cieca
    // il lavoro di qualcun altro.
    const ifMatch = request.headers.get('if-match') ?? undefined;

    let written;
    try {
        written = await store.writePrivate(TEAM_BLOB, document, {
            ifMatch,
            ifAbsent: !ifMatch
        });
    } catch (error) {
        if (error instanceof ConflictError) return conflictResponse(context, store);
        return serverError(context, error, 'storage-unavailable');
    }

    // Il master e salvato. Se la ripubblicazione fallisce NON e un errore della
    // richiesta: i dati ci sono e non vanno persi. Si risponde 200 dicendo che
    // la pubblicazione non e riuscita, cosi l'admin sa che il sito pubblico e
    // ancora indietro e puo risalvare.
    try {
        await store.publishPublic(TEAM_BLOB, document);
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
 * Senza, l'editor potrebbe solo dire "ricarica" e l'admin perderebbe quello che
 * ha scritto. Con la copia puo mostrare le due versioni e far scegliere.
 */
async function conflictResponse(context, store) {
    try {
        const current = await store.readPrivate(TEAM_BLOB);
        return conflict({ etag: current.etag, data: current.data ?? EMPTY_TEAM });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
}

/**
 * Una sola registrazione per entrambi i metodi: due function sulla stessa route
 * si contenderebbero il match nel runtime.
 */
export async function handleTeam(request, context, store = blobStore) {
    return request.method === 'PUT'
        ? handlePutTeam(request, context, store)
        : handleGetTeam(request, context, store);
}

app.http('team', {
    route: 'team',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: handleTeam
});
