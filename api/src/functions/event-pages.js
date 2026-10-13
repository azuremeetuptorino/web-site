import { app } from '@azure/functions';

import { createDocumentResource } from '../lib/document.js';
import { validateEventPage, isEventId } from '../lib/validate.js';

/**
 * La pagina dedicata di un evento speciale: sessioni, speaker e foto.
 *
 *   GET/PUT  /api/event-pages/{id}  -> event-pages/<id dell'evento>.json
 *
 * Titolo, data e luogo restano nell'evento di events.json: qui c'e solo quello
 * che Luma e Meetup non hanno. L'agenda si importa con lo stesso
 * /api/global-azure/sessionize delle edizioni.
 */

/** L'id arriva dalla route: e l'unica parte del nome del blob che non scriviamo noi. */
export function eventPageBlobName(request) {
    const id = request.params?.id;
    return isEventId(id) ? `event-pages/${id}.json` : null;
}

const page = createDocumentResource({
    blobName: eventPageBlobName,
    empty: { version: 1, tracks: [], speakers: [], sessions: [], photos: [] },
    validate: validateEventPage
});

export const handleGetEventPage = page.handleGet;
export const handlePutEventPage = page.handlePut;

app.http('event-pages', {
    route: 'event-pages/{id}',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: page.handle
});
