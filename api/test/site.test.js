import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { validateSite, CHANNEL_TYPES, SOCIAL_TYPES } from '../src/lib/validate.js';
import { handleGetSite, handlePutSite } from '../src/functions/site.js';

const paths = (result) => result.issues.map((issue) => issue.path);

/* ==========================================================
   VALIDAZIONE
   ========================================================== */

test('il documento seed del repo e valido cosi com e', () => {
    const seed = JSON.parse(readFileSync(new URL('../../src/data/site.json', import.meta.url), 'utf8'));
    const result = validateSite(seed);

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.value.stats.length, 2);
    assert.equal(result.value.footer.social.length, 4);
});

test('un documento vuoto e valido: significa "lascia la pagina com e"', () => {
    const result = validateSite({});
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { version: 1 });
});

test('le sezioni vuote non finiscono sul blob come oggetti vuoti', () => {
    const result = validateSite({ brand: {}, about: { title: '  ' }, footer: {} });
    assert.equal(result.ok, true);
    assert.deepEqual(Object.keys(result.value), ['version']);
});

test('si puo impostare una sola sezione senza toccare le altre', () => {
    const result = validateSite({ about: { text: 'Siamo una community.' } });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { version: 1, about: { text: 'Siamo una community.' } });
});

test('le immagini seguono le stesse regole degli altri URL', () => {
    assert.equal(validateSite({ brand: { heroImageUrl: 'https://cdn.example/hero.jpg' } }).ok, true);
    assert.equal(validateSite({ brand: { logoUrl: '/assets/img/logo.svg' } }).ok, true);

    const cattivo = validateSite({ brand: { logoUrl: 'javascript:alert(1)' } });
    assert.equal(cattivo.ok, false);
    assert.deepEqual(paths(cattivo), ['brand.logoUrl']);
});

test('le statistiche restano testo: "1.2k+" non e un numero', () => {
    const result = validateSite({ stats: [{ value: '1.2k+', label: 'Membri Attivi' }] });
    assert.equal(result.ok, true);
    assert.equal(result.value.stats[0].value, '1.2k+');
});

test('una statistica a meta viene segnalata sul campo giusto', () => {
    const result = validateSite({ stats: [{ value: '30+' }, { label: 'Solo etichetta' }] });
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['stats[0].label', 'stats[1].value']);
});

test('troppe statistiche vengono fermate prima di validarle', () => {
    const result = validateSite({ stats: Array.from({ length: 7 }, () => ({ value: '1', label: 'x' })) });
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['stats']);
});

test('i canali vogliono tipo, etichetta e indirizzo', () => {
    const buono = validateSite({
        footer: { channels: [{ type: 'telegram', label: 'Canale Telegram', url: 'https://t.me/x' }] }
    });
    assert.equal(buono.ok, true);

    const rotto = validateSite({ footer: { channels: [{ type: 'piccione', label: '', url: 'nope' }] } });
    assert.equal(rotto.ok, false);
    assert.deepEqual(paths(rotto), [
        'footer.channels[0].type',
        'footer.channels[0].label',
        'footer.channels[0].url'
    ]);
});

test('tutti i tipi di canale e di social previsti sono accettati', () => {
    for (const type of CHANNEL_TYPES) {
        const result = validateSite({ footer: { channels: [{ type, label: 'X', url: 'https://x.example' }] } });
        assert.equal(result.ok, true, type);
    }
    for (const type of SOCIAL_TYPES) {
        const result = validateSite({ footer: { social: [{ type, url: 'https://x.example' }] } });
        assert.equal(result.ok, true, type);
    }
});

test('l email viene controllata quel tanto che basta', () => {
    assert.equal(validateSite({ footer: { email: 'info@azuremeetuptorino.it' } }).ok, true);

    const rotta = validateSite({ footer: { email: 'non-e-una-email' } });
    assert.equal(rotta.ok, false);
    assert.deepEqual(paths(rotta), ['footer.email']);
});

test('un testo smisurato viene respinto col suo limite nel messaggio', () => {
    const result = validateSite({ about: { text: 'a'.repeat(1201) } });
    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /1200/);
});

test('updatedAt e updatedBy dal client vengono ignorati', () => {
    const result = validateSite({ updatedBy: 'tizio@example.com', about: { title: 'Chi siamo' } });
    assert.equal(result.value.updatedBy, undefined);
});

/* ==========================================================
   FUNCTION
   ========================================================== */

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

function requestWith({ principal, method = 'GET', body } = {}) {
    const headers = new Map();
    if (principal) {
        headers.set('x-ms-client-principal', Buffer.from(JSON.stringify(principal), 'utf8').toString('base64'));
    }
    return {
        method,
        headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
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

test('GET legge site.json e senza master restituisce il documento vuoto', async () => {
    const store = fakeStore();
    const response = await handleGetSite(requestWith({ principal: ADMIN }), contextSpy(), store);

    assert.deepEqual(store.state.reads, ['site.json']);
    assert.deepEqual(response.jsonBody.data, { version: 1 });
});

test('PUT scrive e ripubblica site.json', async () => {
    const store = fakeStore();
    const response = await handlePutSite(
        requestWith({
            principal: ADMIN,
            method: 'PUT',
            body: { data: { about: { title: 'Chi Siamo' }, stats: [{ value: '40+', label: 'Meetup' }] } }
        }),
        contextSpy(),
        store
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.published, true);
    assert.deepEqual(store.state.writes.map((write) => write.path), ['site.json']);
    assert.deepEqual(store.state.publishes.map((entry) => entry.path), ['site.json']);
    assert.equal(store.state.writes[0].document.stats[0].value, '40+');
    assert.equal(store.state.writes[0].document.updatedBy, 'alberto.annunziata@alveo.it');
});

test('senza sessione risponde 401', async () => {
    const response = await handleGetSite(requestWith({}), contextSpy(), fakeStore());
    assert.equal(response.status, 401);
});
