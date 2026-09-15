/**
 * Risposte JSON uniformi.
 *
 * `Cache-Control: no-store` va impostato QUI: le `headers` delle route rules
 * di staticwebapp.config.json non vengono applicate alle risposte delle API.
 */

const BASE_HEADERS = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff'
};

export function json(status, body, extraHeaders = {}) {
    return {
        status,
        headers: { ...BASE_HEADERS, ...extraHeaders },
        jsonBody: body
    };
}

export const ok = (body, headers) => json(200, body, headers);
export const created = (body, headers) => json(201, body, headers);

export const badRequest = (error, extra = {}) => json(400, { error, ...extra });
export const unauthorized = () => json(401, { error: 'unauthenticated' });
export const forbidden = () => json(403, { error: 'forbidden' });
export const notFound = (error = 'not-found') => json(404, { error });
export const conflict = (body) => json(409, { error: 'conflict', ...body });

/**
 * Un errore imprevisto non deve mai far trapelare lo stack al client:
 * finisce nei log della function, al chiamante va un messaggio neutro.
 */
export function serverError(context, error, message = 'internal-error') {
    context.error(error);
    return json(500, { error: message });
}
