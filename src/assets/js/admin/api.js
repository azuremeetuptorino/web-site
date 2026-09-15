/**
 * Client delle API amministrative.
 *
 * Il trabocchetto da gestire: il responseOverrides 401 di Static Web Apps e
 * globale e non limitabile a una route. A sessione scaduta una fetch verso
 * /api non riceve un 401 JSON ma un 302 verso la pagina di login HTML, che
 * fetch segue in automatico. Quindi il segnale di "sessione scaduta" non e
 * lo status: e il content-type che non e JSON.
 */

export class SessionExpiredError extends Error {
    constructor() {
        super('Sessione scaduta');
        this.name = 'SessionExpiredError';
    }
}

export class ApiError extends Error {
    constructor(status, payload) {
        super(payload?.error ?? `Errore ${status}`);
        this.name = 'ApiError';
        this.status = status;
        this.payload = payload ?? {};
    }
}

async function request(path, options = {}) {
    const response = await fetch(path, {
        ...options,
        headers: { Accept: 'application/json', ...(options.headers ?? {}) }
    });

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('application/json')) {
        // Ci hanno servito la pagina di login al posto del JSON.
        throw new SessionExpiredError();
    }

    const payload = await response.json();
    if (!response.ok) throw new ApiError(response.status, payload);

    return { payload, etag: response.headers.get('etag') };
}

export const apiGet = (path) => request(path, { method: 'GET' });

export const apiPut = (path, body, etag) =>
    request(path, {
        method: 'PUT',
        headers: {
            'Content-Type': 'application/json',
            ...(etag ? { 'If-Match': etag } : {})
        },
        body: JSON.stringify(body)
    });

export const apiPost = (path, body) =>
    request(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body)
    });
