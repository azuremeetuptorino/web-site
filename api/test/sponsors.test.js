import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleGetSponsors, handlePutSponsors } from '../src/functions/sponsors.js';

/**
 * Il comportamento condiviso (ETag, 409 con la copia del server, ripubblicazione,
 * errori dello storage) sta in lib/document.js ed e gia coperto da team.test.js.
 * Qui si verifica solo che questa risorsa sia cablata sul file giusto e sul
 * validatore giusto — cioe esattamente cio che un copia-incolla sbaglierebbe.
 */

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc123',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

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

const contextSpy = () => ({ error: () => {} });

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

const SPONSOR = {
    id: 'acme-cloud',
    name: 'ACME Cloud',
    tier: 'gold',
    logoUrl: 'https://cdn.example/acme.svg'
};

test('GET legge sponsors.json, non team.json', async () => {
    const store = fakeStore();
    await handleGetSponsors(requestWith({ principal: ADMIN }), contextSpy(), store);

    assert.deepEqual(store.state.reads, ['sponsors.json']);
});

test('il documento vuoto ha la chiave sponsors, non members', async () => {
    const response = await handleGetSponsors(requestWith({ principal: ADMIN }), contextSpy(), fakeStore());

    assert.equal(response.status, 200);
    assert.deepEqual(response.jsonBody.data, { version: 1, sponsors: [] });
});

test('PUT scrive e ripubblica sponsors.json', async () => {
    const store = fakeStore();
    const response = await handlePutSponsors(
        requestWith({ principal: ADMIN, method: 'PUT', body: { data: { version: 1, sponsors: [SPONSOR] } } }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.published, true);
    assert.deepEqual(store.state.writes.map((write) => write.path), ['sponsors.json']);
    assert.deepEqual(store.state.publishes.map((entry) => entry.path), ['sponsors.json']);
    assert.equal(store.state.writes[0].document.sponsors[0].tier, 'gold');
    assert.equal(store.state.writes[0].document.updatedBy, 'alberto.annunziata@alveo.it');
});

test('la validazione applicata e quella degli sponsor', async () => {
    const store = fakeStore();
    const response = await handlePutSponsors(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            // `tier` inventato e `logoUrl` assente: errori che solo il
            // validatore degli sponsor sa riconoscere.
            body: { data: { version: 1, sponsors: [{ id: 'acme', name: 'ACME', tier: 'titanium' }] } }
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 400);
    assert.deepEqual(
        response.jsonBody.issues.map((issue) => issue.path),
        ['sponsors[0].tier', 'sponsors[0].logoUrl']
    );
    assert.equal(store.state.writes.length, 0);
});

test('un documento con la chiave del team viene respinto', async () => {
    const response = await handlePutSponsors(
        requestWith({ principal: ADMIN, method: 'PUT', body: { data: { version: 1, members: [] } } }),
        contextSpy(),
        fakeStore()
    );

    assert.equal(response.status, 400);
    assert.deepEqual(response.jsonBody.issues.map((issue) => issue.path), ['sponsors']);
});

test('senza sessione risponde 401', async () => {
    const response = await handleGetSponsors(requestWith({}), contextSpy(), fakeStore());
    assert.equal(response.status, 401);
});
