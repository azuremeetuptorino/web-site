import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    handleGetGlobalAzure,
    handlePutGlobalAzure,
    handleGetEdition,
    handlePutEdition,
    handleImportSessionize
} from '../src/functions/global-azure.js';
import { validateGlobalAzureEdition, validateGlobalAzureIndex } from '../src/lib/validate.js';

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc123',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

function requestWith({ principal = ADMIN, method = 'GET', body, params = {}, headers = {} } = {}) {
    const map = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
    if (principal) {
        map.set('x-ms-client-principal', Buffer.from(JSON.stringify(principal), 'utf8').toString('base64'));
    }
    return {
        method,
        params,
        headers: { get: (name) => map.get(name.toLowerCase()) ?? null },
        json: async () => {
            if (body === undefined) throw new SyntaxError('nessun body');
            return body;
        }
    };
}

const contextSpy = () => ({ error: () => {}, warn: () => {} });

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

const EDITION = {
    tracks: [{ id: 'security', name: 'Security' }],
    speakers: [{ id: 'ada', name: 'Ada Lovelace' }],
    sessions: [
        {
            id: 's-2',
            title: 'Zero trust',
            start: '2026-04-18T11:00:00+02:00',
            end: '2026-04-18T11:55:00+02:00',
            trackId: 'security',
            speakerIds: ['ada'],
            language: 'it'
        },
        {
            id: 's-1',
            title: 'Check-in',
            start: '2026-04-18T08:30:00+02:00',
            end: '2026-04-18T09:30:00+02:00',
            kind: 'service'
        }
    ],
    photos: [{ id: 'p-1', url: 'https://cdn.example/1.webp', width: 2000, height: 1333 }],
    sponsors: [{ id: 'acme', name: 'ACME', tier: 'diamond', logoUrl: 'https://cdn.example/acme.svg' }]
};

/* ----- indice ----- */

test('l’indice vive in global-azure.json', async () => {
    const store = fakeStore();
    const response = await handleGetGlobalAzure(requestWith(), contextSpy(), store);

    assert.equal(response.status, 200);
    assert.deepEqual(store.state.reads, ['global-azure.json']);
    assert.deepEqual(response.jsonBody.data, { version: 1, editions: [] });
});

test('PUT dell’indice valida e ripubblica', async () => {
    const store = fakeStore();
    const response = await handlePutGlobalAzure(
        requestWith({
            method: 'PUT',
            body: { data: { editions: [{ id: '2026', date: '2026-04-18', current: true, stats: { attendees: '250' } }] } }
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.deepEqual(store.state.publishes.map((entry) => entry.path), ['global-azure.json']);
    const saved = store.state.writes[0].document.editions[0];
    assert.equal(saved.year, 2026);
    assert.deepEqual(saved.stats, { attendees: 250 });
    assert.equal(saved.published, true);
});

test('l’edizione deve essere un anno e la data deve cadere in quell’anno', () => {
    const result = validateGlobalAzureIndex({
        editions: [{ id: 'ventisei' }, { id: '2025', date: '2026-04-18' }]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), ['editions[0].id', 'editions[1].date']);
});

test('una sola edizione corrente', () => {
    const result = validateGlobalAzureIndex({
        editions: [{ id: '2026', current: true }, { id: '2025' }, { id: '2024', current: true }]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), ['editions[2].current']);
});

/* ----- contenuti di un'edizione ----- */

test('GET di un’edizione legge il blob di quell’anno', async () => {
    const store = fakeStore();
    const response = await handleGetEdition(requestWith({ params: { year: '2026' } }), contextSpy(), store);

    assert.equal(response.status, 200);
    assert.deepEqual(store.state.reads, ['global-azure/2026.json']);
    assert.deepEqual(response.jsonBody.data.photos, []);
});

test('un anno non valido e 404 e non tocca lo storage', async () => {
    for (const year of ['../team', '1999', '2026.json', undefined]) {
        const store = fakeStore();
        const response = await handleGetEdition(requestWith({ params: { year } }), contextSpy(), store);
        assert.equal(response.status, 404, `anno ${year}`);
        assert.equal(store.state.reads.length, 0);
    }
});

test('PUT di un’edizione scrive e pubblica su global-azure/<anno>.json', async () => {
    const store = fakeStore();
    const response = await handlePutEdition(
        requestWith({ method: 'PUT', params: { year: '2026' }, body: { data: EDITION } }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.deepEqual(store.state.writes.map((write) => write.path), ['global-azure/2026.json']);
    assert.deepEqual(store.state.publishes.map((entry) => entry.path), ['global-azure/2026.json']);

    const saved = store.state.writes[0].document;
    // Ordinate per orario, in UTC.
    assert.deepEqual(saved.sessions.map((session) => session.id), ['s-1', 's-2']);
    assert.equal(saved.sessions[0].start, '2026-04-18T06:30:00.000Z');
    assert.equal(saved.sessions[1].kind, 'talk');
    assert.equal(saved.photos[0].featured, false);
});

test('una sessione che punta a traccia o speaker inesistenti e respinta sul campo giusto', () => {
    const result = validateGlobalAzureEdition({
        ...EDITION,
        tracks: [],
        sessions: [{ ...EDITION.sessions[0], speakerIds: ['ada', 'grace'] }]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(
        result.issues.map((issue) => issue.path),
        ['sessions[0].trackId', 'sessions[0].speakerIds']
    );
    assert.match(result.issues[1].message, /grace/);
});

test('la fine di una sessione deve venire dopo l’inizio', () => {
    const result = validateGlobalAzureEdition({
        sessions: [{ id: 's-1', title: 'X', start: '2026-04-18T10:00:00Z', end: '2026-04-18T10:00:00Z' }]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), ['sessions[0].end']);
});

test('i tier degli sponsor sono quelli di Global Azure', () => {
    const result = validateGlobalAzureEdition({
        sponsors: [{ id: 'acme', name: 'ACME', tier: 'bronze', logoUrl: 'https://cdn.example/a.svg' }]
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), ['sponsors[0].tier']);
});

test('troppe foto: respinto prima di validarle una per una', () => {
    const photos = Array.from({ length: 401 }, (_, index) => ({ id: `p-${index}`, url: 'https://x.example/a.webp' }));
    const result = validateGlobalAzureEdition({ photos });

    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), ['photos']);
});

/* ----- import ----- */

test('l’import Sessionize rifiuta un id non valido senza andare in rete', async () => {
    let called = false;
    const response = await handleImportSessionize(
        requestWith({ method: 'POST', body: { sessionizeId: 'https://evil.example/' } }),
        contextSpy(),
        { fetchImpl: async () => { called = true; } }
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'invalid-sessionize-id');
    assert.equal(called, false);
});

test('senza ruolo admin niente import', async () => {
    const response = await handleImportSessionize(
        requestWith({ principal: { ...ADMIN, userRoles: ['authenticated'] }, method: 'POST', body: {} }),
        contextSpy()
    );
    assert.equal(response.status, 403);
});
