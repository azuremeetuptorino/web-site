import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aiConfig, chatDrafts, composeDrafts, ComposeError, parseDrafts, promptFor, tidy } from '../src/lib/ai-compose.js';
import { channelById } from '../src/lib/reminder-channels.js';

/**
 * Il client di Foundry e finto: qui interessa cosa gli viene chiesto e, molto
 * di piu, cosa si fa della sua risposta. Un modello puo dimenticare il link,
 * sforare il limite o incartare il JSON in un blocco di codice: nessuna di
 * queste tre cose deve arrivare fino al canale.
 */

const EVENT = {
    id: 'luma-2ffi3qjx',
    title: 'GitHub Dev Days, tappa di Torino',
    dateTime: '2026-10-16T13:00:00.000Z',
    timezone: 'Europe/Rome',
    eventUrl: 'https://luma.com/2ffi3qjx',
    imageUrl: 'https://images.lumacdn.com/cover.png',
    excerpt: 'Una giornata di sessioni pratiche su Copilot e Actions.',
    venue: { name: 'ITS ICT Piemonte', city: 'Torino' }
};

const DEPLOYMENT = 'gpt-6-astra';

const draftsFor = (text) => JSON.stringify({
    telegram: `${text} telegram ${EVENT.eventUrl}`,
    whatsapp: `${text} whatsapp ${EVENT.eventUrl}`,
    linkedin: `${text} linkedin ${EVENT.eventUrl}`,
    instagram: `${text} instagram ${EVENT.eventUrl}`
});

/** Un client che risponde quello che gli si dice, e registra la richiesta. */
function fakeClient(reply) {
    const calls = [];
    return {
        calls,
        responses: {
            create: async (request) => {
                calls.push(request);
                if (reply instanceof Error) throw reply;
                if (typeof reply === 'object' && reply.status) return reply;
                return {
                    model: DEPLOYMENT,
                    status: 'completed',
                    output: [
                        { type: 'reasoning', summary: [] },
                        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: reply }] }
                    ]
                };
            }
        }
    };
}

const compose = (client) => composeDrafts(EVENT, '7d', { client, deployment: DEPLOYMENT });

/* ==========================================================
   CONFIGURAZIONE
   ========================================================== */

test('servono tutte e tre le impostazioni', () => {
    assert.equal(aiConfig({}), null);
    assert.equal(aiConfig({ FOUNDRY_BASE_URL: 'https://x/openai/v1/', FOUNDRY_API_KEY: 'k' }), null);
    assert.deepEqual(
        aiConfig({ FOUNDRY_BASE_URL: ' https://x/openai/v1/ ', FOUNDRY_API_KEY: ' k ', FOUNDRY_DEPLOYMENT: ' d ' }),
        { baseURL: 'https://x/openai/v1/', apiKey: 'k', deployment: 'd' }
    );
});

/* ==========================================================
   IL PROMPT
   ========================================================== */

test('il prompt porta i dati dell’evento, non li fa indovinare', () => {
    const prompt = promptFor(EVENT, '7d');

    assert.match(prompt, /GitHub Dev Days/);
    assert.match(prompt, /16 ottobre 2026/);
    assert.match(prompt, /ITS ICT Piemonte/);
    assert.ok(prompt.includes(EVENT.eventUrl));
    assert.match(prompt, /Manca una settimana/);
    assert.match(prompt, /in presenza/);
});

test('il promemoria libero non porta un conto alla rovescia', () => {
    const prompt = promptFor(EVENT, 'free');

    assert.match(prompt, /libero/);
    assert.doesNotMatch(prompt, /Anticipo con cui/);
});

test('la chat rimanda al piu gli ultimi dieci scambi', async () => {
    const client = fakeClient(JSON.stringify({ reply: '', ...JSON.parse(draftsFor('Testo')) }));
    const history = Array.from({ length: 30 }, (_, index) => ({ role: index % 2 ? 'assistant' : 'user', text: `m${index}` }));

    const result = await chatDrafts(EVENT, 'free', { current: {}, history, message: 'ok' }, { client, deployment: DEPLOYMENT });

    assert.equal(client.calls[0].input.length, 21);
    assert.equal(client.calls[0].input[0].content, 'm10');
    assert.equal(result.reply, 'Testi aggiornati.', 'una risposta vuota ha comunque una riga');
    assert.doesNotMatch(client.calls[0].instructions, /\{"telegram": "\.\.\."/, 'il formato e quello con reply');
});

test('un dato che manca viene dichiarato mancante, non omesso in silenzio', () => {
    const prompt = promptFor({ ...EVENT, eventUrl: undefined, excerpt: undefined }, '2d');

    assert.match(prompt, /non inventarlo/);
    assert.match(prompt, /Descrizione: non disponibile/);
});

test('il sistema chiede di non inventare niente', async () => {
    const client = fakeClient(draftsFor('Testo'));
    await compose(client);

    const request = client.calls[0];
    assert.equal(request.model, DEPLOYMENT);
    assert.match(request.instructions, /Non inventare relatori/);
    assert.match(request.instructions, /soltanto con un oggetto JSON/);
    assert.equal(request.text.format.type, 'json_schema');
    assert.deepEqual(request.text.format.schema.required, ['telegram', 'whatsapp', 'linkedin', 'instagram']);
    assert.equal(request.store, false);
});

/* ==========================================================
   LA RISPOSTA
   ========================================================== */

test('il JSON si legge anche dentro un blocco di codice o dopo una riga di cortesia', () => {
    const body = '{"telegram":"a","whatsapp":"b","linkedin":"c","instagram":"d"}';

    assert.equal(parseDrafts(body).telegram, 'a');
    assert.equal(parseDrafts('```json\n' + body + '\n```').telegram, 'a');
    assert.equal(parseDrafts('Ecco i testi:\n' + body).whatsapp, 'b');
});

test('se manca un canale la risposta non si usa', () => {
    assert.throws(
        () => parseDrafts('{"telegram":"a","whatsapp":"b"}'),
        (error) => error instanceof ComposeError && error.code === 'ai-bad-output'
    );
    assert.throws(() => parseDrafts('non e json'), (error) => error.code === 'ai-bad-output');
    assert.throws(() => parseDrafts('{"telegram":"","whatsapp":"b","linkedin":"c","instagram":"d"}'),
        (error) => error.code === 'ai-bad-output');
});

test('un rifiuto del modello non viene scambiato per un testo', async () => {
    const client = fakeClient({
        status: 'completed',
        output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No.' }] }]
    });

    await assert.rejects(() => compose(client), (error) => error.code === 'ai-refused' && error.status === 502);
});

test('una risposta troncata dal tetto di token non passa per buona', async () => {
    const client = fakeClient({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' }, output: [] });

    await assert.rejects(
        () => compose(client),
        (error) => error.code === 'ai-failed' && error.extra.reason === 'max_output_tokens'
    );
});

/* ==========================================================
   LE CORREZIONI
   ========================================================== */

test('se il modello dimentica il link, glielo si rimette', () => {
    const result = tidy('Un testo senza indirizzi.', channelById('whatsapp'), EVENT, '7d');

    assert.ok(result.text.includes(EVENT.eventUrl), 'il link e la sola parte che non si puo perdere');
    assert.equal(result.truncated, false);
});

test('un testo troppo lungo viene riportato nel limite, tenendo il link', () => {
    const channel = channelById('whatsapp');
    const result = tidy(`${'parola '.repeat(300)}\n\n${EVENT.eventUrl}`, channel, EVENT, '7d');

    assert.ok(result.length <= 1000, `${result.length} caratteri`);
    assert.equal(result.truncated, true);
    assert.ok(result.text.includes(EVENT.eventUrl), 'il link resta intero anche dopo il taglio');
});

test('il limite di Telegram dipende dalla copertina, come per i template', () => {
    assert.equal(tidy('x', channelById('telegram'), EVENT, '7d').limit, 1024);
    assert.equal(tidy('x', channelById('telegram'), { ...EVENT, imageUrl: undefined }, '7d').limit, 4096);
});

test('i quattro testi tornano gia dentro i rispettivi limiti', async () => {
    const client = fakeClient(JSON.stringify({
        telegram: 'x'.repeat(3000),
        whatsapp: 'y'.repeat(3000),
        linkedin: 'z'.repeat(5000),
        instagram: 'w'.repeat(5000)
    }));

    const { channels, model } = await compose(client);

    assert.equal(model, DEPLOYMENT);
    for (const [id, draft] of Object.entries(channels)) {
        assert.ok(draft.length <= draft.limit, `${id}: ${draft.length} contro ${draft.limit}`);
        assert.ok(draft.text.includes(EVENT.eventUrl), `${id} ha perso il link`);
    }
});

/* ==========================================================
   ERRORI
   ========================================================== */

test('gli errori del servizio diventano codici che l’admin sa leggere', async () => {
    const cases = [
        [Object.assign(new Error('no'), { status: 401 }), 'ai-unauthorized', 502],
        [Object.assign(new Error('no'), { status: 403 }), 'ai-unauthorized', 502],
        [Object.assign(new Error('troppi'), { status: 429 }), 'ai-rate-limited', 429],
        [Object.assign(new Error('boh'), { status: 404 }), 'ai-failed', 502],
        [Object.assign(new Error('scaduto'), { name: 'TimeoutError' }), 'ai-timeout', 504],
        [new TypeError('fetch failed'), 'ai-failed', 502]
    ];

    for (const [thrown, code, status] of cases) {
        await assert.rejects(
            () => compose(fakeClient(thrown)),
            (error) => error.code === code && error.status === status,
            code
        );
    }
});

test('la chiave non trapela mai nell’errore', async () => {
    const secret = 'CHIAVE-FOUNDRY-SEGRETA';
    const thrown = Object.assign(new Error(`richiesta con api-key ${secret} rifiutata`), { status: 401 });

    const error = await compose(fakeClient(thrown)).catch((caught) => caught);

    assert.ok(error instanceof ComposeError);
    assert.ok(!`${error.message} ${JSON.stringify(error.extra)}`.includes(secret));
});
