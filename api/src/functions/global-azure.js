import { app } from '@azure/functions';

import { requireRole } from '../lib/auth.js';
import { createDocumentResource } from '../lib/document.js';
import { validateGlobalAzureIndex, validateGlobalAzureEdition, isEditionYear } from '../lib/validate.js';
import { importSessionize } from '../lib/sessionize.js';
import { ImportError } from '../lib/event-import.js';
import { ok, badRequest, unauthorized, forbidden, json, serverError } from '../lib/http.js';

/**
 * Global Azure Torino: l'indice delle edizioni e i contenuti di ciascuna.
 *
 *   GET/PUT  /api/global-azure                  -> global-azure.json
 *   GET/PUT  /api/global-azure/editions/{year}  -> global-azure/<anno>.json
 *   POST     /api/global-azure/sessionize       -> { sessionizeId } -> agenda e speaker, senza salvare
 *
 * Due documenti invece di uno perche un'edizione con la sua galleria sono
 * centinaia di righe, e l'indice lo legge ogni visita della pagina pubblica:
 * scaricare le foto del 2019 per sapere quando cade il 2027 sarebbe uno spreco.
 */
const index = createDocumentResource({
    blobName: 'global-azure.json',
    empty: { version: 1, editions: [] },
    validate: validateGlobalAzureIndex
});

export const handleGetGlobalAzure = index.handleGet;
export const handlePutGlobalAzure = index.handlePut;

app.http('global-azure', {
    route: 'global-azure',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: index.handle
});

/** L'anno arriva dalla route: e l'unica parte del nome del blob che non scriviamo noi. */
export function editionBlobName(request) {
    const year = request.params?.year;
    return isEditionYear(year) ? `global-azure/${year}.json` : null;
}

const edition = createDocumentResource({
    blobName: editionBlobName,
    empty: { version: 1, tracks: [], speakers: [], sessions: [], photos: [], sponsors: [] },
    validate: validateGlobalAzureEdition
});

export const handleGetEdition = edition.handleGet;
export const handlePutEdition = edition.handlePut;

app.http('global-azure-edition', {
    route: 'global-azure/editions/{year}',
    methods: ['GET', 'PUT'],
    authLevel: 'anonymous',
    handler: edition.handle
});

/**
 * Come /api/events/import: scarica, normalizza e restituisce. Le righe le
 * fonde l'editor, e finiscono sul blob solo quando l'admin preme Salva.
 */
export async function handleImportSessionize(request, context, deps = {}) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

    let body;
    try {
        body = await request.json();
    } catch {
        return badRequest('invalid-json');
    }

    try {
        return ok(await importSessionize(body?.sessionizeId, deps));
    } catch (error) {
        if (error instanceof ImportError) {
            if (error.status >= 500) context.warn?.(`[global-azure/sessionize] ${error.code}`, error.extra);
            return json(error.status, { error: error.code, ...error.extra });
        }
        return serverError(context, error, 'import-failed');
    }
}

app.http('global-azure-sessionize', {
    route: 'global-azure/sessionize',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handleImportSessionize
});
