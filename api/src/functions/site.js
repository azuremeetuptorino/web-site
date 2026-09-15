import { app } from '@azure/functions';

import { createDocumentResource } from '../lib/document.js';
import { validateSite } from '../lib/validate.js';

/**
 * GET/PUT /api/site — i contenuti fissi della home.
 *
 * Foto principale e logo, "Chi siamo", le statistiche e il footer: le cose che
 * finora stavano scritte a mano dentro index.html e richiedevano un commit per
 * cambiare una parola.
 *
 * Il documento vuoto e vuoto davvero, senza sezioni: il rendering pubblico
 * lascia in piedi il testo dell'HTML per tutto quello che non riceve, quindi
 * "nessun dato" significa "la pagina resta com'e", non "la pagina si svuota".
 */
const site = createDocumentResource({
    blobName: 'site.json',
    empty: { version: 1 },
    validate: validateSite
});

export const handleGetSite = site.handleGet;
export const handlePutSite = site.handlePut;

app.http('site', {
    route: 'site',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: site.handle
});
