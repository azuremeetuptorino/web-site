import { app } from '@azure/functions';

import { createDocumentResource } from '../lib/document.js';
import { validateTeam } from '../lib/validate.js';

/**
 * GET/PUT /api/team — il master del team.
 *
 * Il sito pubblico NON passa di qui: legge direttamente il container blob
 * pubblico. Queste function servono solo all'editor dell'admin, e sono la sola
 * cosa che scrive su `site-data/team.json`.
 *
 * Tutto il comportamento (ETag, 409 con la copia del server, ripubblicazione
 * su `public/`) sta in lib/document.js, condiviso con gli sponsor.
 */
const team = createDocumentResource({
    blobName: 'team.json',
    empty: { version: 1, members: [] },
    validate: validateTeam
});

export const handleGetTeam = team.handleGet;
export const handlePutTeam = team.handlePut;
export const handleTeam = team.handle;

app.http('team', {
    route: 'team',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: team.handle
});
