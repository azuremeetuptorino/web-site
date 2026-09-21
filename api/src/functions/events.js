import { app } from '@azure/functions';

import { requireRole } from '../lib/auth.js';
import { createDocumentResource } from '../lib/document.js';
import { validateEvents } from '../lib/validate.js';
import { importEvent, ImportError } from '../lib/event-import.js';
import { ok, badRequest, unauthorized, forbidden, json, serverError } from '../lib/http.js';

/**
 * GET/PUT /api/events — il calendario degli eventi.
 *
 * Il piano originale li tirava giu dall'API GraphQL di Meetup con un cron. La
 * chiave API non c'e, e nel frattempo la community pubblica anche su Luma:
 * gli eventi sono diventati un documento come team e sponsor, che l'admin
 * gestisce a mano — con una scorciatoia, l'importazione dal link qui sotto.
 */
const events = createDocumentResource({
    blobName: 'events.json',
    empty: { version: 1, events: [] },
    validate: validateEvents
});

export const handleGetEvents = events.handleGet;
export const handlePutEvents = events.handlePut;
export const handleEvents = events.handle;

app.http('events', {
    route: 'events',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: events.handle
});

/**
 * POST /api/events/import — { url } -> { event, source }
 *
 * Scarica la pagina pubblica dell'evento su Luma o Meetup e ne ricava una
 * scheda gia compilata. Non scrive niente: la scheda torna all'editor, che la
 * mostra come una riga nuova e la salva solo quando l'admin preme Salva.
 *
 * Gli errori previsti (link non valido, host non ammesso, pagina senza evento,
 * piattaforma irraggiungibile) hanno ognuno il proprio codice, cosi l'editor
 * puo dire cosa e andato storto invece di un generico "non ha funzionato".
 */
export async function handleImportEvent(request, context, deps = {}) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

    let body;
    try {
        body = await request.json();
    } catch {
        return badRequest('invalid-json');
    }

    try {
        return ok(await importEvent(body?.url, deps));
    } catch (error) {
        if (error instanceof ImportError) {
            if (error.status >= 500) context.warn?.(`[events/import] ${error.code}`, error.extra);
            return json(error.status, { error: error.code, ...error.extra });
        }
        return serverError(context, error, 'import-failed');
    }
}

app.http('events-import', {
    route: 'events/import',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handleImportEvent
});
