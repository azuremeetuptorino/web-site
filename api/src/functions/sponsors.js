import { app } from '@azure/functions';

import { createDocumentResource } from '../lib/document.js';
import { validateSponsors } from '../lib/validate.js';

/**
 * GET/PUT /api/sponsors — il master degli sponsor.
 *
 * Identico a /api/team per costruzione: stesso modulo, cambia il file e il
 * validatore. I loghi si caricano a parte, con POST /api/assets.
 */
const sponsors = createDocumentResource({
    blobName: 'sponsors.json',
    empty: { version: 1, sponsors: [] },
    validate: validateSponsors
});

export const handleGetSponsors = sponsors.handleGet;
export const handlePutSponsors = sponsors.handlePut;
export const handleSponsors = sponsors.handle;

app.http('sponsors', {
    route: 'sponsors',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: sponsors.handle
});
