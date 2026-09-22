import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConflictError } from '../src/lib/blob.js';
import {
    buildOverview,
    getRecord,
    readState,
    upcomingEvents,
    windowsFor,
    withDraft,
    withRecord
} from '../src/lib/reminders.js';
import {
    handleComposeReminder,
    handleDraftReminder,
    handleGetReminders,
    handleMarkReminder,
    handleSendReminder
} from '../src/functions/reminders.js';

/**
 * Due cose vanno verificate qui sopra tutte le altre.
 *
 * Che non si pubblichi due volte lo stesso promemoria: e l'errore che si vede,
 * sul canale, davanti a tutta la community. Per questo ogni strada che porta a
 * Telegram e provata anche nel caso in cui qualcuno sia gia passato di li.
 *
 * E che un post uscito risulti uscito: se la scrittura dello stato fallisce
 * dopo l'invio, la risposta non deve essere un errore, o l'admin rimanderebbe.
 */

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc123',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

const VISITOR = { ...ADMIN, userRoles: ['anonymous', 'authenticated'] };

/** Un martedi qualunque, cosi le distanze dagli eventi sono sempre le stesse. */
const NOW = Date.parse('2026-09-22T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const inDays = (days) => new Date(NOW + days * DAY).toISOString();

const EVENT = {
    id: 'luma-2ffi3qjx',
    title: 'GitHub Dev Days, tappa di Torino',
    dateTime: inDays(10),
    timezone: 'Europe/Rome',
    eventUrl: 'https://luma.com/2ffi3qjx',
    imageUrl: 'https://images.lumacdn.com/cover.png',
    excerpt: 'Una giornata di sessioni pratiche.',
    venue: { name: 'ITS ICT Piemonte', city: 'Torino' },
    active: true
};

const EVENTS_DOC = { version: 1, events: [EVENT] };

const TELEGRAM_ENV = { TELEGRAM_BOT_TOKEN: '123:abc', TELEGRAM_CHAT_ID: '@AzureMeetupTorino' };

function requestWith({ principal, method = 'POST', body, headers = {} } = {}) {
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

const contextSpy = () => ({
    errors: [], warnings: [],
    error(entry) { this.errors.push(entry); },
    warn(entry) { this.warnings.push(entry); }
});

/** Store finto con due blob distinti: gli eventi e lo stato dei promemoria. */
function fakeStore({ events = EVENTS_DOC, reminders = null, remindersEtag = '"r1"', writeFails = null } = {}) {
    const state = {
        blobs: {
            'events.json': { etag: '"e1"', data: events },
            'reminders.json': reminders ? { etag: remindersEtag, data: reminders } : { etag: null, data: null }
        },
        writes: [],
        publishes: 0
    };

    return {
        state,
        async readPrivate(path) {
            return { ...(state.blobs[path] ?? { etag: null, data: null }) };
        },
        async writePrivate(path, document, options = {}) {
            if (writeFails) throw writeFails;

            const current = state.blobs[path] ?? { etag: null, data: null };
            if (options.ifAbsent && current.etag !== null) throw new ConflictError();
            if (options.ifMatch && options.ifMatch !== current.etag) throw new ConflictError();

            state.writes.push({ path, document, options });
            state.blobs[path] = { etag: `"w${state.writes.length}"`, data: document };
            return { etag: state.blobs[path].etag, lastModified: new Date().toISOString() };
        },
        async publishPublic() {
            state.publishes += 1;
            return { etag: '"pub"', lastModified: new Date().toISOString() };
        }
    };
}

/** Telegram che risponde sempre bene, e conta quante volte e stato chiamato. */
function fetchOk() {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, body: JSON.parse(options.body) });
        return { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 42 } }) };
    };
    impl.calls = calls;
    return impl;
}

const never = () => { throw new Error('Telegram non doveva essere chiamato'); };

const sentState = (channel = 'telegram') => ({
    version: 1,
    sent: { [EVENT.id]: { '7d': { [channel]: { at: inDays(-1), by: 'qualcuno', mode: 'manual' } } } },
    drafts: {}
});

const send = (options, deps) => handleSendReminder(requestWith(options), contextSpy(), { now: () => NOW, ...deps });
const mark = (options, deps) => handleMarkReminder(requestWith(options), contextSpy(), { now: () => NOW, ...deps });
const compose = (options, deps) => handleComposeReminder(requestWith(options), contextSpy(), { now: () => NOW, ...deps });
const draft = (options, deps) => handleDraftReminder(requestWith(options), contextSpy(), { now: () => NOW, ...deps });

const AI_ENV = {
    FOUNDRY_BASE_URL: 'https://esempio.services.ai.azure.com/anthropic',
    FOUNDRY_API_KEY: 'chiave',
    FOUNDRY_DEPLOYMENT: 'claude-opus-5'
};

/** Un modello finto che risponde con quattro testi buoni. */
const fakeAi = (text = 'Promemoria riscritto') => ({
    messages: {
        create: async () => ({
            model: 'claude-opus-5',
            stop_reason: 'end_turn',
            content: [{
                type: 'text',
                text: JSON.stringify({
                    telegram: `${text} telegram ${EVENT.eventUrl}`,
                    whatsapp: `${text} whatsapp ${EVENT.eventUrl}`,
                    linkedin: `${text} linkedin ${EVENT.eventUrl}`,
                    instagram: `${text} instagram ${EVENT.eventUrl}`
                })
            }]
        })
    }
});

/* ==========================================================
   FINESTRE
   ========================================================== */

test('le finestre si aprono a 14, 7 e 2 giorni dall’evento', () => {
    const windows = windowsFor({ dateTime: inDays(20) }, NOW);

    assert.deepEqual(windows.map((window) => window.id), ['14d', '7d', '2d']);
    assert.deepEqual(windows.map((window) => window.due), [false, false, false]);
    assert.equal(windows[0].dueAt, inDays(6), 'la finestra dei 14 giorni si apre 6 giorni da adesso');
});

test('a dieci giorni dall’evento e dovuta solo la prima', () => {
    const windows = windowsFor({ dateTime: inDays(10) }, NOW);
    assert.deepEqual(windows.map((window) => window.due), [true, false, false]);
    assert.deepEqual(windows.map((window) => window.superseded), [false, false, false]);
});

test('a un giorno dall’evento le finestre lontane risultano superate', () => {
    const windows = windowsFor({ dateTime: inDays(1) }, NOW);

    assert.deepEqual(windows.map((window) => window.due), [true, true, true]);
    assert.deepEqual(windows.map((window) => window.superseded), [true, true, false]);
});

test('una data illeggibile non produce finestre', () => {
    assert.deepEqual(windowsFor({ dateTime: 'boh' }, NOW), []);
    assert.deepEqual(windowsFor({}, NOW), []);
});

test('si ricordano solo gli eventi futuri e attivi, dal piu vicino', () => {
    const events = upcomingEvents({
        events: [
            { id: 'lontano', dateTime: inDays(30), active: true },
            { id: 'passato', dateTime: inDays(-2), active: true },
            { id: 'nascosto', dateTime: inDays(5), active: false },
            { id: 'vicino', dateTime: inDays(3), active: true }
        ]
    }, NOW);

    assert.deepEqual(events.map((event) => event.id), ['vicino', 'lontano']);
});

/* ==========================================================
   STATO
   ========================================================== */

test('un blob che non esiste ancora e lo stato vuoto, non un errore', async () => {
    const state = await readState(fakeStore());

    assert.equal(state.etag, null);
    assert.deepEqual(state.data, { version: 1, sent: {}, drafts: {} });
});

test('le chiavi che non si sanno leggere vengono ignorate', async () => {
    const state = await readState(fakeStore({
        reminders: {
            sent: {
                [EVENT.id]: {
                    '7d': { telegram: { at: 'x' }, myspace: { at: 'x' } },
                    '99d': { telegram: { at: 'x' } }
                },
                'ID NON VALIDO': { '7d': { telegram: { at: 'x' } } }
            }
        }
    }));

    assert.deepEqual(Object.keys(state.data.sent), [EVENT.id]);
    assert.deepEqual(Object.keys(state.data.sent[EVENT.id]), ['7d']);
    assert.deepEqual(Object.keys(state.data.sent[EVENT.id]['7d']), ['telegram']);
});

test('aggiungere una voce non modifica lo stato di partenza', () => {
    const before = { version: 1, sent: {}, drafts: {} };
    const after = withRecord(before, EVENT.id, '7d', 'telegram', { at: 'ora' });

    assert.deepEqual(before.sent, {}, 'lo stato letto deve restare quello letto');
    assert.deepEqual(getRecord(after, EVENT.id, '7d', 'telegram'), { at: 'ora' });
});

test('togliere l’ultima voce pota anche i gusci rimasti vuoti', () => {
    const withOne = withRecord({ version: 1, sent: {}, drafts: {} }, EVENT.id, '7d', 'telegram', { at: 'ora' });
    const empty = withRecord(withOne, EVENT.id, '7d', 'telegram', null);

    assert.deepEqual(empty.sent, {});
});

test('canali diversi nella stessa finestra convivono', () => {
    let state = { version: 1, sent: {}, drafts: {} };
    state = withRecord(state, EVENT.id, '7d', 'telegram', { at: 'a' });
    state = withRecord(state, EVENT.id, '7d', 'linkedin', { at: 'b' });
    state = withDraft(state, EVENT.id, '7d', 'linkedin', { text: 'bozza' });

    assert.deepEqual(Object.keys(state.sent[EVENT.id]['7d']), ['telegram', 'linkedin']);
    assert.equal(state.drafts[EVENT.id]['7d'].linkedin.text, 'bozza');
});

/* ==========================================================
   LA RISPOSTA DELLA SCHEDA
   ========================================================== */

test('la scheda riceve i testi gia pronti, uno per canale', () => {
    const overview = buildOverview({ eventsDoc: EVENTS_DOC, state: { sent: {}, drafts: {} }, now: NOW });
    const [event] = overview.events;

    assert.equal(event.id, EVENT.id);
    assert.match(event.when, /ore /);
    assert.equal(event.windows.length, 3);

    const channels = event.windows[0].channels;
    assert.deepEqual(Object.keys(channels), ['telegram', 'whatsapp', 'linkedin', 'instagram']);
    for (const [id, channel] of Object.entries(channels)) {
        assert.ok(channel.text.includes(EVENT.eventUrl), `${id} non porta il link`);
        assert.ok(channel.length <= channel.limit, id);
        assert.equal(channel.sent, null);
        assert.equal(channel.source, 'template');
    }
});

test('un promemoria gia mandato risulta mandato', () => {
    const overview = buildOverview({ eventsDoc: EVENTS_DOC, state: sentState(), now: NOW });
    const windows = overview.events[0].windows;

    assert.equal(windows.find((window) => window.id === '7d').channels.telegram.sent.mode, 'manual');
    assert.equal(windows.find((window) => window.id === '14d').channels.telegram.sent, null);
});

test('la bozza vince sul template, e se sfora lo dice', () => {
    const state = {
        sent: {},
        drafts: { [EVENT.id]: { '7d': { whatsapp: { text: 'x'.repeat(1200), source: 'ai' } } } }
    };
    const channel = buildOverview({ eventsDoc: EVENTS_DOC, state, now: NOW })
        .events[0].windows.find((window) => window.id === '7d').channels.whatsapp;

    assert.equal(channel.source, 'ai');
    assert.equal(channel.length, 1200);
    assert.equal(channel.truncated, true);
    assert.match(channel.notes.join(' '), /supera di 200 caratteri/);
});

test('senza le impostazioni di Telegram la scheda lo sa', () => {
    const overview = buildOverview({ eventsDoc: EVENTS_DOC, state: { sent: {}, drafts: {} }, now: NOW });
    assert.equal(overview.telegram.configured, false);
    assert.equal(overview.ai.configured, false);
});

/* ==========================================================
   GET
   ========================================================== */

test('GET: senza sessione 401, senza ruolo 403', async () => {
    const store = fakeStore();
    assert.equal((await handleGetReminders(requestWith({ method: 'GET' }), contextSpy(), { store })).status, 401);
    assert.equal((await handleGetReminders(requestWith({ method: 'GET', principal: VISITOR }), contextSpy(), { store })).status, 403);
});

test('GET: legge gli eventi e lo stato, e riporta l’ETag per la scrittura', async () => {
    const store = fakeStore({ reminders: sentState() });

    const response = await handleGetReminders(
        requestWith({ method: 'GET', principal: ADMIN }),
        contextSpy(),
        { store, now: () => NOW, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.etag, '"r1"');
    assert.equal(response.jsonBody.telegram.configured, true);
    assert.equal(response.jsonBody.events.length, 1);
    assert.deepEqual(response.jsonBody.windows.map((window) => window.id), ['14d', '7d', '2d']);
});

test('GET: uno storage che non risponde e un 500, non una scheda vuota', async () => {
    const store = { readPrivate: async () => { throw new Error('storage giu'); } };
    const context = contextSpy();

    const response = await handleGetReminders(requestWith({ method: 'GET', principal: ADMIN }), context, { store });

    assert.equal(response.status, 500);
    assert.equal(response.jsonBody.error, 'storage-unavailable');
    assert.equal(context.errors.length, 1);
});

/* ==========================================================
   SEND
   ========================================================== */

test('send: senza sessione 401, senza ruolo 403', async () => {
    const body = { eventId: EVENT.id, window: '7d', channel: 'telegram' };
    assert.equal((await send({ body }, { store: fakeStore(), fetchImpl: never })).status, 401);
    assert.equal((await send({ principal: VISITOR, body }, { store: fakeStore(), fetchImpl: never })).status, 403);
});

test('send: un body che non e JSON e una richiesta sbagliata', async () => {
    const response = await send({ principal: ADMIN }, { store: fakeStore(), fetchImpl: never });
    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'invalid-json');
});

test('send: finestra o canale sconosciuti vengono rifiutati con i valori ammessi', async () => {
    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '30d', channel: 'myspace' } },
        { store: fakeStore(), fetchImpl: never }
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'validation');
    assert.deepEqual(response.jsonBody.issues.map((issue) => issue.path), ['window', 'channel']);
});

test('send: i canali senza API non si spediscono da qui', async () => {
    for (const channel of ['whatsapp', 'linkedin', 'instagram']) {
        const response = await send(
            { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel } },
            { store: fakeStore(), fetchImpl: never, env: TELEGRAM_ENV }
        );
        assert.equal(response.status, 400, channel);
        assert.equal(response.jsonBody.error, 'channel-not-sendable');
    }
});

test('send: un evento che non esiste e un 404, uno gia passato un 422', async () => {
    const store = fakeStore({
        events: { version: 1, events: [EVENT, { id: 'vecchio', dateTime: inDays(-3), active: true }] }
    });

    const missing = await send(
        { principal: ADMIN, body: { eventId: 'mai-esistito', window: '7d', channel: 'telegram' } },
        { store, fetchImpl: never }
    );
    assert.equal(missing.status, 404);
    assert.equal(missing.jsonBody.error, 'event-not-found');

    const past = await send(
        { principal: ADMIN, body: { eventId: 'vecchio', window: '7d', channel: 'telegram' } },
        { store, fetchImpl: never }
    );
    assert.equal(past.status, 422);
    assert.equal(past.jsonBody.error, 'event-not-upcoming');
});

test('send: un ETag vecchio ferma tutto PRIMA di pubblicare', async () => {
    const store = fakeStore({ reminders: sentState(), remindersEtag: '"r9"' });

    const response = await send(
        {
            principal: ADMIN,
            headers: { 'If-Match': '"r1"' },
            body: { eventId: EVENT.id, window: '14d', channel: 'telegram' }
        },
        { store, fetchImpl: never, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 409);
    assert.equal(response.jsonBody.etag, '"r9"');
    assert.ok(response.jsonBody.data, 'il 409 porta con se la copia buona');
});

test('send: un promemoria gia mandato non esce una seconda volta', async () => {
    const store = fakeStore({ reminders: sentState() });

    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'telegram' } },
        { store, fetchImpl: never, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 409);
    assert.equal(response.jsonBody.error, 'already-sent');
    assert.equal(store.state.writes.length, 0);
});

test('send: senza le impostazioni di Telegram non si tenta la chiamata', async () => {
    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'telegram' } },
        { store: fakeStore(), fetchImpl: never, env: {} }
    );

    assert.equal(response.status, 503);
    assert.equal(response.jsonBody.error, 'telegram-not-configured');
});

test('send: il caso buono pubblica una volta sola e registra chi e stato', async () => {
    const store = fakeStore();
    const fetchImpl = fetchOk();

    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'telegram' } },
        { store, fetchImpl, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.recorded, true);
    assert.deepEqual(response.jsonBody.sent, {
        at: new Date(NOW).toISOString(),
        by: ADMIN.userDetails,
        mode: 'api',
        method: 'sendPhoto',
        messageId: 42
    });

    assert.equal(fetchImpl.calls.length, 1);
    assert.match(fetchImpl.calls[0].body.caption, /Mancano due settimane/);
    assert.equal(fetchImpl.calls[0].body.parse_mode, undefined, 'i testi sono semplici, niente markup');

    assert.equal(store.state.writes.length, 1);
    assert.equal(store.state.writes[0].path, 'reminders.json');
    assert.equal(store.state.writes[0].options.ifAbsent, true, 'il primo salvataggio crea il blob');
    assert.equal(store.state.publishes, 0, 'lo stato dei promemoria non si pubblica');
});

test('send: sullo stato gia esistente si scrive condizionati all’ETag', async () => {
    const store = fakeStore({ reminders: sentState('linkedin'), remindersEtag: '"r5"' });

    await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'telegram' } },
        { store, fetchImpl: fetchOk(), env: TELEGRAM_ENV }
    );

    assert.equal(store.state.writes[0].options.ifMatch, '"r5"');
    // Il segno gia presente su un altro canale non va perso.
    assert.ok(store.state.writes[0].document.sent[EVENT.id]['7d'].linkedin);
    assert.ok(store.state.writes[0].document.sent[EVENT.id]['7d'].telegram);
});

test('send: una bozza sostituisce il testo standard', async () => {
    const store = fakeStore({
        reminders: {
            version: 1,
            sent: {},
            drafts: { [EVENT.id]: { '14d': { telegram: { text: 'Testo riscritto a mano', source: 'ai' } } } }
        }
    });
    const fetchImpl = fetchOk();

    await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'telegram' } },
        { store, fetchImpl, env: TELEGRAM_ENV }
    );

    assert.equal(fetchImpl.calls[0].body.caption, 'Testo riscritto a mano');
    assert.equal(fetchImpl.calls[0].body.parse_mode, undefined);
});

test('send: una bozza oltre il limite viene fermata prima di partire', async () => {
    const store = fakeStore({
        reminders: {
            version: 1,
            sent: {},
            drafts: { [EVENT.id]: { '14d': { telegram: { text: 'x'.repeat(2000), source: 'manual' } } } }
        }
    });

    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'telegram' } },
        { store, fetchImpl: never, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'text-too-long');
    assert.equal(response.jsonBody.limit, 1024);
});

test('send: il limite di frequenza di Telegram arriva all’admin, e non si scrive niente', async () => {
    const store = fakeStore();
    const fetchImpl = async () => ({
        ok: false, status: 429, json: async () => ({ ok: false, parameters: { retry_after: 12 } })
    });

    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'telegram' } },
        { store, fetchImpl, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 429);
    assert.equal(response.jsonBody.error, 'telegram-rate-limited');
    assert.equal(response.jsonBody.retryAfter, 12);
    assert.equal(store.state.writes.length, 0);
});

test('send: se il post e uscito ma lo stato non si salva, NON e un errore', async () => {
    // Rispondere 500 qui farebbe rimandare il promemoria all'admin, e sul canale
    // ne uscirebbero due. Si risponde 200 dicendo che non risulta registrato.
    const store = fakeStore({ writeFails: new ConflictError() });
    const context = contextSpy();

    const response = await handleSendReminder(
        requestWith({ principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'telegram' } }),
        context,
        { store, fetchImpl: fetchOk(), env: TELEGRAM_ENV, now: () => NOW }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.recorded, false);
    assert.equal(response.jsonBody.reason, 'conflict');
    assert.equal(response.jsonBody.sent.messageId, 42);
    assert.equal(context.errors.length, 1, 'resta comunque tracciato nei log');
});

test('send: la copertina rifiutata non fa saltare il promemoria', async () => {
    const store = fakeStore();
    let call = 0;
    const fetchImpl = async () => {
        call += 1;
        return call === 1
            ? { ok: false, status: 400, json: async () => ({ ok: false, description: 'failed to get HTTP URL content' }) }
            : { ok: true, status: 200, json: async () => ({ ok: true, result: { message_id: 7 } }) };
    };

    const response = await send(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'telegram' } },
        { store, fetchImpl, env: TELEGRAM_ENV }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.sent.method, 'sendMessage');
    assert.match(response.jsonBody.notes.join(' '), /solo testo/);
});

/* ==========================================================
   MARK
   ========================================================== */

test('mark: senza sessione 401, senza ruolo 403', async () => {
    const body = { eventId: EVENT.id, window: '7d', channel: 'linkedin', sent: true };
    assert.equal((await mark({ body }, { store: fakeStore() })).status, 401);
    assert.equal((await mark({ principal: VISITOR, body }, { store: fakeStore() })).status, 403);
});

test('mark: registra un post pubblicato a mano, con firma e ora', async () => {
    const store = fakeStore();

    const response = await mark(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'linkedin', sent: true } },
        { store }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(response.jsonBody.sent, {
        at: new Date(NOW).toISOString(),
        by: ADMIN.userDetails,
        mode: 'manual'
    });
    assert.ok(store.state.writes[0].document.sent[EVENT.id]['7d'].linkedin);
});

test('mark: si puo togliere un segno messo per sbaglio', async () => {
    const store = fakeStore({ reminders: sentState() });

    const response = await mark(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'telegram', sent: false } },
        { store }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.sent, null);
    assert.deepEqual(store.state.writes[0].document.sent, {});
});

test('mark: vale anche per Telegram, per registrare un invio che non si era salvato', async () => {
    const store = fakeStore();

    const response = await mark(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '2d', channel: 'telegram', sent: true } },
        { store }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.sent.mode, 'manual');
});

test('mark: un conflitto restituisce la copia del server per riallinearsi', async () => {
    const store = fakeStore({ reminders: sentState(), writeFails: new ConflictError() });

    const response = await mark(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '14d', channel: 'linkedin', sent: true } },
        { store }
    );

    assert.equal(response.status, 409);
    assert.equal(response.jsonBody.error, 'conflict');
    assert.ok(response.jsonBody.data.sent[EVENT.id]);
});

/* ==========================================================
   COMPOSE
   ========================================================== */

test('compose: senza sessione 401, senza ruolo 403', async () => {
    const body = { eventId: EVENT.id, window: '7d' };
    assert.equal((await compose({ body }, { store: fakeStore(), env: AI_ENV })).status, 401);
    assert.equal((await compose({ principal: VISITOR, body }, { store: fakeStore(), env: AI_ENV })).status, 403);
});

test('compose: senza le impostazioni del servizio si risponde 503', async () => {
    const response = await compose(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d' } },
        { store: fakeStore(), env: {} }
    );

    assert.equal(response.status, 503);
    assert.equal(response.jsonBody.error, 'ai-not-configured');
});

test('compose: non serve indicare un canale, li riscrive tutti e quattro', async () => {
    const store = fakeStore();

    const response = await compose(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d' } },
        { store, env: AI_ENV, client: fakeAi() }
    );

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(response.jsonBody.drafts), ['telegram', 'whatsapp', 'linkedin', 'instagram']);

    const saved = store.state.writes[0].document.drafts[EVENT.id]['7d'];
    assert.deepEqual(Object.keys(saved), ['telegram', 'whatsapp', 'linkedin', 'instagram']);
    assert.equal(saved.telegram.source, 'ai');
    assert.equal(saved.telegram.by, ADMIN.userDetails);
    assert.equal(saved.telegram.model, 'claude-opus-5');
    assert.equal(store.state.publishes, 0, 'le bozze non finiscono sul sito pubblico');
});

test('compose: le bozze non toccano quello che risulta gia mandato', async () => {
    const store = fakeStore({ reminders: sentState() });

    await compose({ principal: ADMIN, body: { eventId: EVENT.id, window: '7d' } }, { store, env: AI_ENV, client: fakeAi() });

    assert.ok(store.state.writes[0].document.sent[EVENT.id]['7d'].telegram, 'il segno di invio resta');
});

test('compose: un ETag vecchio ferma la riscrittura prima di spendere la chiamata', async () => {
    const store = fakeStore({ reminders: sentState(), remindersEtag: '"r9"' });
    const client = { messages: { create: async () => { throw new Error('non doveva essere chiamato'); } } };

    const response = await compose(
        { principal: ADMIN, headers: { 'If-Match': '"vecchio"' }, body: { eventId: EVENT.id, window: '7d' } },
        { store, env: AI_ENV, client }
    );

    assert.equal(response.status, 409);
});

test('compose: un errore del servizio non lascia bozze a meta', async () => {
    const store = fakeStore();
    const client = { messages: { create: async () => { throw Object.assign(new Error('no'), { status: 429 }); } } };

    const response = await compose(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d' } },
        { store, env: AI_ENV, client }
    );

    assert.equal(response.status, 429);
    assert.equal(response.jsonBody.error, 'ai-rate-limited');
    assert.equal(store.state.writes.length, 0);
});

/* ==========================================================
   DRAFT
   ========================================================== */

test('draft: salva un testo modificato a mano', async () => {
    const store = fakeStore();

    const response = await draft(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'linkedin', text: 'Scritto da me' } },
        { store }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.draft.text, 'Scritto da me');
    assert.equal(response.jsonBody.draft.source, 'manual');
    assert.equal(store.state.writes[0].document.drafts[EVENT.id]['7d'].linkedin.by, ADMIN.userDetails);
});

test('draft: con text null si torna al testo standard', async () => {
    const store = fakeStore({
        reminders: {
            version: 1,
            sent: {},
            drafts: { [EVENT.id]: { '7d': { linkedin: { text: 'vecchia bozza', source: 'ai' } } } }
        }
    });

    const response = await draft(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'linkedin', text: null } },
        { store }
    );

    assert.equal(response.status, 200);
    assert.equal(response.jsonBody.draft, null);
    assert.deepEqual(store.state.writes[0].document.drafts, {}, 'il guscio vuoto viene potato');
});

test('draft: una bozza oltre il limite del canale viene rifiutata al salvataggio', async () => {
    // Meglio dirlo qui che al clic su Pubblica, quando l'admin crede di aver finito.
    const response = await draft(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'whatsapp', text: 'x'.repeat(1500) } },
        { store: fakeStore() }
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'text-too-long');
    assert.equal(response.jsonBody.limit, 1000);
});

test('draft: un testo vuoto non e una bozza', async () => {
    const response = await draft(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', channel: 'whatsapp', text: '   ' } },
        { store: fakeStore() }
    );

    assert.equal(response.status, 400);
    assert.equal(response.jsonBody.error, 'validation');
});

test('draft: il canale resta obbligatorio', async () => {
    const response = await draft(
        { principal: ADMIN, body: { eventId: EVENT.id, window: '7d', text: 'x' } },
        { store: fakeStore() }
    );

    assert.equal(response.status, 400);
    assert.deepEqual(response.jsonBody.issues.map((issue) => issue.path), ['channel']);
});
