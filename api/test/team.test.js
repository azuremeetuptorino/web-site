import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleGetTeam, handlePutTeam, handleTeam } from '../src/functions/team.js';
import { ConflictError } from '../src/lib/blob.js';

/* ==========================================================
   DOPPI DI PROVA
   ========================================================== */

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc123',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

const VISITOR = { ...ADMIN, userRoles: ['anonymous', 'authenticated'] };

function requestWith({ principal, method = 'GET', body, headers = {} } = {}) {
    const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (principal) {
        map.set(
            'x-ms-client-principal',
            Buffer.from(JSON.stringify(principal), 'utf8').toString('base64')
        );
    }
    return {
        method,
        headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
        json: async () => {
            if (body === undefined) throw new SyntaxError('nessun body');
            if (typeof body === 'string') return JSON.parse(body);
            return body;
        }
    };
}

/** Raccoglie i log invece di stamparli: cosi si puo asserire che l'errore e stato tracciato. */
function contextSpy() {
    const errors = [];
    return { errors, error: (error) => errors.push(error) };
}

/**
 * Store finto con lo stesso contratto di lib/blob.js.
 * L'ETag e un contatore: basta a distinguere "la mia copia" da "quella nuova".
 */
function fakeStore({ data = null, etag = null, failPublish = false } = {}) {
    const state = {
        priv: data ? { etag: etag ?? '"v1"', data } : { etag: null, data: null },
        published: null,
        writes: 0,
        publishes: 0
    };

    return {
        state,
        async readPrivate() {
            return { ...state.priv };
        },
        async writePrivate(path, document, options = {}) {
            const exists = state.priv.etag !== null;
            if (options.ifAbsent && exists) throw new ConflictError();
            if (options.ifMatch && options.ifMatch !== state.priv.etag) throw new ConflictError();

            state.writes += 1;
            state.priv = { etag: `"v${state.writes + 1}"`, data: document };
            return { etag: state.priv.etag, lastModified: new Date().toISOString() };
        },
        async publishPublic(path, document) {
            if (failPublish) throw new Error('container pubblico irraggiungibile');
            state.publishes += 1;
            state.published = document;
            return { etag: '"pub"', lastModified: new Date().toISOString() };
        }
    };
}

const TEAM = {
    version: 1,
    updatedAt: '2026-09-01T10:00:00.000Z',
    updatedBy: 'seed',
    members: [
        { id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'co-founder', order: 10, active: true }
    ]
};

/** Body come lo manda l'editor: il documento dentro `data`. */
const payload = (members) => ({ data: { version: 1, members } });

/* ==========================================================
   ACCESSO
   ========================================================== */

test('GET /api/team senza sessione risponde 401', async () => {
    const response = await handleGetTeam(requestWith({}), contextSpy(), fakeStore());
    assert.equal(response.status, 401);
});

test('GET /api/team da autenticato senza ruolo admin risponde 403', async () => {
    const response = await handleGetTeam(requestWith({ principal: VISITOR }), contextSpy(), fakeStore());
    assert.equal(response.status, 403);
});

test('PUT /api/team senza ruolo admin non tocca lo storage', async () => {
    const store = fakeStore({ data: TEAM });
    const response = await handlePutTeam(
        requestWith({ principal: VISITOR, method: 'PUT', body: payload([]) }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 403);
    assert.equal(store.state.writes, 0);
});

/* ==========================================================
   LETTURA
   ========================================================== */

test('GET con il master assente restituisce un documento vuoto, non un 404', async () => {
    const response = await handleGetTeam(requestWith({ principal: ADMIN }), contextSpy(), fakeStore());

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.etag, null);
    assert.deepEqual(response.jsonBody.data, { version: 1, members: [] });
    assert.equal('ETag' in response.headers, false, 'senza blob non c e ETag da mandare');
});

test('GET restituisce i dati e l ETag, nel body e nell header', async () => {
    const response = await handleGetTeam(
        requestWith({ principal: ADMIN }),
        contextSpy(),
        fakeStore({ data: TEAM, etag: '"0x8DC"' })
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.etag, '"0x8DC"');
    assert.equal(response.headers.ETag, '"0x8DC"');
    assert.equal(response.jsonBody.data.members[0].id, 'elena-rossi');
    assert.equal(response.headers['Cache-Control'], 'no-store');
});

test('se lo storage e giu la GET risponde 500 senza far trapelare l errore', async () => {
    const context = contextSpy();
    const store = fakeStore();
    store.readPrivate = async () => { throw new Error('ECONNREFUSED 10.0.0.1:443'); };

    const response = await handleGetTeam(requestWith({ principal: ADMIN }), context, store);

    assert.equal(response.status, 500);
    assert.equal(response.jsonBody.error, 'storage-unavailable');
    assert.equal(context.errors.length, 1, 'l errore vero deve finire nei log');
    assert.match(String(response.jsonBody), /^\[object/, 'nessun dettaglio nel body');
});

/* ==========================================================
   SCRITTURA
   ========================================================== */

test('PUT senza If-Match crea il documento e lo pubblica', async () => {
    const store = fakeStore();
    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            body: payload([{ id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'co-founder' }])
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.published, true);
    assert.equal(store.state.writes, 1);
    assert.deepEqual(store.state.published, store.state.priv.data, 'copia pubblica e master devono coincidere');
});

test('PUT con If-Match corrente salva e ripubblica', async () => {
    const store = fakeStore({ data: TEAM, etag: '"v1"' });
    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            headers: { 'If-Match': '"v1"' },
            body: payload([
                { id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'co-founder' },
                { id: 'marco-bianchi', name: 'Marco Bianchi', roleKey: 'organizer' }
            ])
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.etag, '"v2"');
    assert.equal(store.state.priv.data.members.length, 2);
    assert.equal(store.state.publishes, 1);
});

test('il server firma la scrittura: updatedBy viene dal principal, non dal client', async () => {
    const store = fakeStore({ data: TEAM, etag: '"v1"' });
    await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            headers: { 'If-Match': '"v1"' },
            body: {
                data: {
                    version: 99,
                    updatedBy: 'presidente@example.com',
                    updatedAt: '1999-01-01T00:00:00Z',
                    members: [{ id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'co-founder' }]
                }
            }
        }),
        contextSpy(),
        store
    );

    const saved = store.state.priv.data;
    assert.equal(saved.updatedBy, 'alberto.annunziata@alveo.it');
    assert.equal(saved.version, 1);
    assert.notEqual(saved.updatedAt, '1999-01-01T00:00:00Z');
});

test('PUT accetta anche il documento nudo, senza involucro data', async () => {
    const store = fakeStore();
    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            body: { version: 1, members: [{ id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'staff' }] }
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.equal(store.state.priv.data.members[0].roleKey, 'staff');
});

test('un body che non e JSON risponde 400, non 500', async () => {
    const store = fakeStore();
    const response = await handlePutTeam(
        requestWith({ principal: ADMIN, method: 'PUT' }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'invalid-json');
    assert.equal(store.state.writes, 0);
});

test('un payload invalido risponde 400 con le issues e non scrive niente', async () => {
    const store = fakeStore({ data: TEAM, etag: '"v1"' });
    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            headers: { 'If-Match': '"v1"' },
            body: payload([{ id: 'NON VALIDO', name: '', roleKey: 'co-founder' }])
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'validation');
    assert.deepEqual(
        response.jsonBody.issues.map((issue) => issue.path),
        ['members[0].id', 'members[0].name']
    );
    assert.equal(store.state.writes, 0);
    assert.equal(store.state.publishes, 0);
});

/* ==========================================================
   CONFLITTI
   ========================================================== */

test('PUT con un ETag stantio risponde 409 con la copia del server', async () => {
    const store = fakeStore({ data: TEAM, etag: '"v7"' });
    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            headers: { 'If-Match': '"v1"' },
            body: payload([{ id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'co-founder' }])
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 409);
    assert.equal(response.jsonBody.error, 'conflict');
    assert.equal(response.jsonBody.etag, '"v7"');
    assert.equal(response.jsonBody.data.members[0].id, 'elena-rossi', 'serve la copia, non solo l ETag');
    assert.equal(store.state.writes, 0, 'niente e stato sovrascritto');
});

test('PUT senza If-Match su un documento che esiste gia risponde 409', async () => {
    const store = fakeStore({ data: TEAM, etag: '"v1"' });
    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            body: payload([{ id: 'nuovo', name: 'Nuovo', roleKey: 'staff' }])
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 409);
    assert.equal(store.state.writes, 0);
});

/* ==========================================================
   PUBBLICAZIONE
   ========================================================== */

test('se la ripubblicazione fallisce il master resta salvato e la risposta lo dice', async () => {
    const context = contextSpy();
    const store = fakeStore({ data: TEAM, etag: '"v1"', failPublish: true });

    const response = await handlePutTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            headers: { 'If-Match': '"v1"' },
            body: payload([{ id: 'elena-rossi', name: 'Elena Rossi', roleKey: 'co-founder' }])
        }),
        context,
        store
    );

    assert.equal(response.status, 200, 'i dati sono salvati: non e un errore della richiesta');
    assert.equal(response.jsonBody.published, false);
    assert.equal(response.jsonBody.publishedAt, null);
    assert.equal(store.state.writes, 1);
    assert.equal(context.errors.length, 1);
});

/* ==========================================================
   INSTRADAMENTO
   ========================================================== */

test('la stessa function smista GET e PUT', async () => {
    const store = fakeStore({ data: TEAM, etag: '"v1"' });

    const lettura = await handleTeam(requestWith({ principal: ADMIN }), contextSpy(), store);
    assert.equal(lettura.jsonBody.data.members.length, 1);

    const scrittura = await handleTeam(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            headers: { 'If-Match': '"v1"' },
            body: payload([])
        }),
        contextSpy(),
        store
    );
    assert.equal(scrittura.jsonBody.published, true);
    assert.deepEqual(store.state.priv.data.members, []);
});
