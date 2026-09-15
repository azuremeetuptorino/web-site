import { app } from '@azure/functions';
import { getClientPrincipal } from '../lib/auth.js';
import { ok, unauthorized } from '../lib/http.js';

/**
 * GET /api/me
 *
 * Dice alla pagina admin chi e loggato e se ha davvero il ruolo admin.
 * Accessibile a chiunque sia autenticato (non solo agli admin), cosi la
 * pagina puo distinguere "non hai il ruolo" da "non sei entrato".
 *
 * L'handler e esportato a parte per poter essere testato e servito dal
 * dev server locale senza il runtime di Azure Functions.
 */
export async function handleMe(request) {
    const principal = getClientPrincipal(request);
    if (!principal) return unauthorized();

    return ok({
        userId: principal.userId,
        userDetails: principal.userDetails,
        identityProvider: principal.identityProvider,
        roles: principal.userRoles,
        isAdmin: principal.userRoles.includes('admin')
    });
}

app.http('me', {
    route: 'me',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: handleMe
});
