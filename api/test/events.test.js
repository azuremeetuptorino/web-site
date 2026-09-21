import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { handleGetEvents, handlePutEvents, handleImportEvent } from '../src/functions/events.js';

/**
 * Il contratto GET/PUT (ETag, 409, ripubblicazione) e in lib/document.js ed e
 * coperto da team.test.js; qui si verifica il cablaggio sul file e sul
 * validatore giusti. L'importazione invece ha una function propria: si prova
 * che traduca gli errori del modulo in risposte HTTP e che non tocchi mai lo
 * storage.
 */

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
        map.set('x-ms-client-principal', Buffer.from(JSON.stringify(principal), 'utf8').toString('base64'));
    }
    return {
        method,
        headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
        json: async () => {
            if (body === undefined) throw new SyntaxError('nessun body');
            return body;
        }
    };
}

const contextSpy = () => ({ errors: [], warnings: [], error(e) { this.errors.push(e); }, warn(w) { this.warnings.push(w); } });

function fakeStore() {
    const state = { reads: [], writes: [], publishes: [], priv: { etag: null, data: null } };
    return {
        state,
        async readPrivate(path) {
            state.reads.push(path);
            return { ...state.priv };
        },
        async writePrivate(path, document) {
            state.writes.push({ path, document });
            state.priv = { etag: '"v2"', data: document };
            return { etag: '"v2"', lastModified: new Date().toISOString() };
        },
        async publishPublic(path, document) {
            state.publishes.push({ path, document });
            return { etag: '"pub"', lastModified: new Date().toISOString() };
        }
    };
}

const EVENT = {
    id: 'luma-2ffi3qjx',
    title: 'Dev Days | Turin, Italy',
    dateTime: '2026-10-16T13:00:00.000Z',
    eventUrl: 'https://luma.com/2ffi3qjx'
};

/* ==========================================================
   GET / PUT
   ========================================================== */

test('GET legge events.json', async () => {
    const store = fakeStore();
    await handleGetEvents(requestWith({ principal: ADMIN }), contextSpy(), store);
    assert.deepEqual(store.state.reads, ['events.json']);
});

test('il documento vuoto ha la chiave events', async () => {
    const response = await handleGetEvents(requestWith({ principal: ADMIN }), contextSpy(), fakeStore());
    assert.equal(response.status, 200);
    assert.deepEqual(response.jsonBody.data, { version: 1, events: [] });
});

test('PUT scrive e ripubblica events.json, con i default applicati', async () => {
    const store = fakeStore();
    const response = await handlePutEvents(
        requestWith({ principal: ADMIN, method: 'PUT', body: { data: { version: 1, events: [EVENT] } } }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.published, true);
    assert.deepEqual(store.state.writes.map((write) => write.path), ['events.json']);
    assert.deepEqual(store.state.publishes.map((entry) => entry.path), ['events.json']);

    const saved = store.state.writes[0].document.events[0];
    assert.equal(saved.timezone, 'Europe/Rome');
    assert.equal(saved.isOnline, false);
    assert.equal(saved.active, true);
});

test('la validazione applicata e quella degli eventi', async () => {
    const store = fakeStore();
    const response = await handlePutEvents(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            body: { data: { version: 1, events: [{ id: 'x1', title: 'Senza data', endTime: 'ieri' }] } }
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 400);
    assert.deepEqual(response.jsonBody.issues.map((issue) => issue.path), ['events[0].dateTime', 'events[0].endTime']);
    assert.equal(store.state.writes.length, 0);
});

test('senza sessione risponde 401', async () => {
    const response = await handleGetEvents(requestWith({}), contextSpy(), fakeStore());
    assert.equal(response.status, 401);
});

/* ==========================================================
   IMPORT
   ========================================================== */

const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const respondWith = (html) => async () =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html' } });

test('POST /api/events/import richiede il ruolo admin', async () => {
    const anonymous = await handleImportEvent(requestWith({ method: 'POST', body: { url: 'https://luma.com/x' } }), contextSpy());
    assert.equal(anonymous.status, 401);

    const visitor = await handleImportEvent(requestWith({ principal: VISITOR, method: 'POST', body: { url: 'https://luma.com/x' } }), contextSpy());
    assert.equal(visitor.status, 403);
});

test('import: body non JSON -> 400 invalid-json', async () => {
    const response = await handleImportEvent(requestWith({ principal: ADMIN, method: 'POST' }), contextSpy());
    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'invalid-json');
});

test('import: link fuori da Luma e Meetup -> 400 con la lista degli host ammessi', async () => {
    const response = await handleImportEvent(
        requestWith({ principal: ADMIN, method: 'POST', body: { url: 'https://www.eventbrite.it/e/1' } }),
        contextSpy()
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'host-not-allowed');
    assert.ok(response.jsonBody.allowed.includes('luma.com'));
});

test('import: da una pagina Luma torna la scheda pronta per l editor', async () => {
    const response = await handleImportEvent(
        requestWith({ principal: ADMIN, method: 'POST', body: { url: 'https://luma.com/2ffi3qjx' } }),
        contextSpy(),
        { fetchImpl: respondWith(fixture('luma-event.html')) }
    );

    assert.equal(response.status, 200);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.jsonBody.event.id, 'luma-2ffi3qjx');
    assert.equal(response.jsonBody.event.title, 'Dev Days | Turin, Italy');
    assert.equal(response.jsonBody.source.platform, 'luma');
});

test('import: pagina senza evento -> 422 no-event-found', async () => {
    const response = await handleImportEvent(
        requestWith({ principal: ADMIN, method: 'POST', body: { url: 'https://luma.com/vuota' } }),
        contextSpy(),
        { fetchImpl: respondWith('<html><body>niente</body></html>') }
    );

    assert.equal(response.status, 422);
    assert.equal(response.jsonBody.error, 'no-event-found');
});

test('import: piattaforma giu -> 502 e una riga nei log, non uno stack al client', async () => {
    const context = contextSpy();
    const response = await handleImportEvent(
        requestWith({ principal: ADMIN, method: 'POST', body: { url: 'https://luma.com/x' } }),
        context,
        { fetchImpl: async () => new Response('', { status: 500 }) }
    );

    assert.equal(response.status, 502);
    assert.equal(response.jsonBody.error, 'upstream-failed');
    assert.equal(response.jsonBody.status, 500);
    assert.equal(context.warnings.length, 1);
});

test('import: un errore imprevisto diventa 500 import-failed', async () => {
    const context = contextSpy();
    const response = await handleImportEvent(
        requestWith({ principal: ADMIN, method: 'POST', body: { url: 'https://luma.com/x' } }),
        context,
        { fetchImpl: async () => ({ status: 200, ok: true, headers: new Headers(), body: null, text: async () => { throw new RangeError('boom'); } }) }
    );

    assert.equal(response.status, 500);
    assert.equal(response.jsonBody.error, 'import-failed');
    assert.equal(context.errors.length, 1);
});
