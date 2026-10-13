import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleGetEventPage, handlePutEventPage } from '../src/functions/event-pages.js';
import { validateEventPage, validateEvents } from '../src/lib/validate.js';

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

const PAGE = {
    sessionizeId: 'AbCd1234',
    tracks: [{ id: 'main', name: 'Sala grande' }],
    speakers: [{ id: 'ada', name: 'Ada Lovelace' }],
    sessions: [
        {
            id: 's-2',
            title: 'Agenti in produzione',
            start: '2026-11-11T19:00:00+01:00',
            end: '2026-11-11T19:45:00+01:00',
            trackId: 'main',
            speakerIds: ['ada']
        },
        {
            id: 's-1',
            title: 'Benvenuto',
            start: '2026-11-11T18:30:00+01:00',
            end: '2026-11-11T18:45:00+01:00',
            kind: 'service'
        }
    ],
    photos: [{ id: 'p-1', url: 'https://cdn.example/1.webp' }]
};

test('la pagina di un evento vive in event-pages/<id>.json', async () => {
    const store = fakeStore();
    const response = await handleGetEventPage(requestWith({ params: { id: 'luma-2ffi3qjx' } }), contextSpy(), store);

    assert.equal(response.status, 200);
    assert.deepEqual(store.state.reads, ['event-pages/luma-2ffi3qjx.json']);
    assert.deepEqual(response.jsonBody.data.sessions, []);
});

test('un id non valido e 404 e non tocca lo storage', async () => {
    for (const id of ['../team', 'Luma-X', 'a', 'x.json', undefined]) {
        const store = fakeStore();
        const response = await handleGetEventPage(requestWith({ params: { id } }), contextSpy(), store);
        assert.equal(response.status, 404, `id ${id}`);
        assert.equal(store.state.reads.length, 0);
    }
});

test('PUT scrive e pubblica, con le sessioni in ordine di orario', async () => {
    const store = fakeStore();
    const response = await handlePutEventPage(
        requestWith({ method: 'PUT', params: { id: 'meetup-313385524' }, body: { data: PAGE } }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.deepEqual(store.state.writes.map((write) => write.path), ['event-pages/meetup-313385524.json']);
    assert.deepEqual(store.state.publishes.map((entry) => entry.path), ['event-pages/meetup-313385524.json']);

    const saved = store.state.writes[0].document;
    assert.deepEqual(saved.sessions.map((session) => session.id), ['s-1', 's-2']);
    assert.equal(saved.sessionizeId, 'abcd1234');
});

test('senza ruolo admin niente pagina', async () => {
    const store = fakeStore();
    const response = await handlePutEventPage(
        requestWith({ principal: { ...ADMIN, userRoles: ['authenticated'] }, method: 'PUT', params: { id: 'luma-x1' }, body: { data: PAGE } }),
        contextSpy(),
        store
    );
    assert.equal(response.status, 403);
    assert.equal(store.state.writes.length, 0);
});

test('la pagina di un evento non ha sponsor', () => {
    const result = validateEventPage({ ...PAGE, sponsors: [{ id: 'acme', name: 'ACME' }] });
    assert.equal(result.ok, true);
    assert.equal('sponsors' in result.value, false);
});

test('una sessione che punta a uno speaker inesistente e respinta sul campo giusto', () => {
    const result = validateEventPage({ ...PAGE, sessions: [{ ...PAGE.sessions[0], speakerIds: ['grace'] }] });
    assert.equal(result.ok, false);
    assert.deepEqual(result.issues.map((issue) => issue.path), ['sessions[0].speakerIds']);
});

test('un id Sessionize strano e respinto', () => {
    const result = validateEventPage({ ...PAGE, sessionizeId: 'non va bene' });
    assert.equal(result.ok, false);
    assert.equal(result.issues[0].path, 'sessionizeId');
});

test('featured c\'e solo sugli eventi che hanno la pagina', () => {
    const base = { id: 'luma-x1', title: 'Evento', dateTime: '2026-11-11T17:30:00.000Z' };
    const result = validateEvents({ events: [{ ...base, featured: true }, { ...base, id: 'luma-x2', featured: false }, { ...base, id: 'luma-x3' }] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value.events.map((entry) => entry.featured), [true, undefined, undefined]);

    const wrong = validateEvents({ events: [{ ...base, featured: 'si' }] });
    assert.equal(wrong.ok, false);
    assert.equal(wrong.issues[0].path, 'events[0].featured');
});
