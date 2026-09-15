/**
 * Lettura e verifica del principal di Azure Static Web Apps.
 *
 * Il cancello vero sono le `allowedRoles` in staticwebapp.config.json: le
 * managed functions non hanno hostname pubblico, quindi l'header
 * x-ms-client-principal lo inietta solo il runtime di SWA e non e falsificabile
 * dall'esterno.
 *
 * Ricontrolliamo comunque il ruolo dentro ogni function, per due motivi:
 *  - le route rules sono sensibili all'ordine e si fermano alla prima
 *    corrispondenza: una wildcard messa male aprirebbe tutto in silenzio;
 *  - se un domani si passa alle "bring your own functions", l'app diventa
 *    indirizzabile pubblicamente e l'header torna falsificabile.
 *
 * Nota: la copia del principal che arriva all'API non contiene `claims`.
 */

/** @returns {{identityProvider: string, userId: string, userDetails: string, userRoles: string[]} | null} */
export function getClientPrincipal(request) {
    const header = request.headers.get('x-ms-client-principal');
    if (!header) return null;

    try {
        const principal = JSON.parse(Buffer.from(header, 'base64').toString('utf8'));
        return {
            identityProvider: principal.identityProvider ?? null,
            userId: principal.userId ?? null,
            userDetails: principal.userDetails ?? null,
            userRoles: Array.isArray(principal.userRoles) ? principal.userRoles : []
        };
    } catch {
        return null;
    }
}

export function hasRole(principal, role) {
    return Boolean(principal?.userRoles?.includes(role));
}

/**
 * @returns {{ok: true, principal: object} | {ok: false, status: 401 | 403}}
 */
export function requireRole(request, role = 'admin') {
    const principal = getClientPrincipal(request);
    if (!principal) return { ok: false, status: 401 };
    if (!hasRole(principal, role)) return { ok: false, status: 403 };
    return { ok: true, principal };
}
