import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handlePostAsset } from '../src/functions/assets.js';

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc123',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

const VISITOR = { ...ADMIN, userRoles: ['anonymous', 'authenticated'] };

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32, 7)]);

function requestWith({ principal, body } = {}) {
    const headers = new Map();
    if (principal) {
        headers.set(
            'x-ms-client-principal',
            Buffer.from(JSON.stringify(principal), 'utf8').toString('base64')
        );
    }
    return {
        method: 'POST',
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
        json: async () => {
            if (body === undefined) throw new SyntaxError('nessun body');
            return body;
        }
    };
}

function contextSpy() {
    const errors = [];
    return { errors, error: (error) => errors.push(error) };
}

function fakeStore({ fail = false } = {}) {
    const state = { uploads: [] };
    return {
        state,
        async uploadPublicAsset(path, body, headers) {
            if (fail) throw new Error('storage irraggiungibile');
            state.uploads.push({ path, body, headers });
            return { url: `https://esempio.blob.core.windows.net/public/${path}`, etag: '"v1"' };
        }
    };
}

const payload = (overrides = {}) => ({
    kind: 'avatar',
    filename: 'elena.png',
    contentType: 'image/png',
    dataBase64: PNG.toString('base64'),
    ...overrides
});

test('senza sessione risponde 401 e non carica niente', async () => {
    const store = fakeStore();
    const response = await handlePostAsset(requestWith({ body: payload() }), contextSpy(), store);

    assert.equal(response.status, 401);
    assert.equal(store.state.uploads.length, 0);
});

test('un autenticato senza ruolo admin non puo caricare', async () => {
    const store = fakeStore();
    const response = await handlePostAsset(
        requestWith({ principal: VISITOR, body: payload() }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 403);
    assert.equal(store.state.uploads.length, 0);
});

test('un upload valido risponde 201 con la URL da mettere nel campo foto', async () => {
    const store = fakeStore();
    const response = await handlePostAsset(
        requestWith({ principal: ADMIN, body: payload() }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 201);
    assert.match(response.jsonBody.url, /\/public\/avatars\/elena-[0-9a-f]{8}\.png$/);
    assert.equal(response.jsonBody.bytes, PNG.length);
    assert.equal(store.state.uploads[0].headers.contentType, 'image/png');
    assert.equal(response.headers['Cache-Control'], 'no-store', 'la risposta API non si mette in cache');
});

test('un body che non e JSON risponde 400', async () => {
    const response = await handlePostAsset(requestWith({ principal: ADMIN }), contextSpy(), fakeStore());
    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'invalid-json');
});

test('gli errori di prepareUpload arrivano al client con il loro status', async () => {
    const casi = [
        [payload({ contentType: 'application/pdf' }), 415],
        [payload({ kind: 'documento' }), 400],
        [payload({ dataBase64: Buffer.from('MZ\0\0').toString('base64') }), 415],
        [payload({ dataBase64: Buffer.alloc(600 * 1024).toString('base64') }), 413]
    ];

    for (const [body, atteso] of casi) {
        const store = fakeStore();
        const response = await handlePostAsset(
            requestWith({ principal: ADMIN, body }),
            contextSpy(),
            store
        );
        assert.equal(response.status, atteso, JSON.stringify(body.contentType ?? body.kind));
        assert.equal(store.state.uploads.length, 0, 'niente deve finire sul blob');
    }
});

test('un SVG viene caricato sanificato e come allegato', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
    const store = fakeStore();

    const response = await handlePostAsset(
        requestWith({
            principal: ADMIN,
            body: payload({
                kind: 'sponsor',
                filename: 'acme.svg',
                contentType: 'image/svg+xml',
                dataBase64: Buffer.from(svg).toString('base64')
            })
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 201);

    const caricato = store.state.uploads[0];
    assert.match(caricato.path, /^sponsors\//);
    assert.equal(caricato.body.toString('utf8').includes('<script'), false);
    assert.equal(caricato.headers.contentDisposition, 'attachment');
});

test('se lo storage e giu risponde 500 senza far trapelare l errore', async () => {
    const context = contextSpy();
    const response = await handlePostAsset(
        requestWith({ principal: ADMIN, body: payload() }),
        context,
        fakeStore({ fail: true })
    );

    assert.equal(response.status, 500);
    assert.equal(response.jsonBody.error, 'storage-unavailable');
    assert.equal(context.errors.length, 1);
});
