import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendReminder, telegramConfig, TelegramError } from '../src/lib/telegram.js';

/**
 * La fetch e finta: si verifica cosa viene chiesto a Telegram e come vengono
 * tradotte le sue risposte, senza toccare la rete. Il caso che conta davvero e
 * il ripiego quando la copertina non viene accettata: senza, un promemoria
 * sparirebbe per colpa di un'immagine.
 */

const TOKEN = '123456:SEGRETO-DA-NON-FAR-TRAPELARE';
const CHAT = '@AzureMeetupTorino';

/** Una risposta della Bot API. Telegram risponde 200 anche quando rifiuta. */
function reply({ status = 200, body = { ok: true, result: { message_id: 42 } } } = {}) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body
    };
}

/** Restituisce le risposte una per chiamata e registra cosa e stato chiesto. */
function fetchSpy(...replies) {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, options, body: JSON.parse(options.body) });
        return replies[calls.length - 1] ?? replies.at(-1);
    };
    impl.calls = calls;
    return impl;
}

const methodOf = (call) => call.url.split('/').at(-1);

/* ==========================================================
   CONFIGURAZIONE
   ========================================================== */

test('senza le due impostazioni non c’e configurazione', () => {
    assert.equal(telegramConfig({}), null);
    assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: TOKEN }), null);
    assert.equal(telegramConfig({ TELEGRAM_CHAT_ID: CHAT }), null);
    assert.equal(telegramConfig({ TELEGRAM_BOT_TOKEN: '  ', TELEGRAM_CHAT_ID: CHAT }), null);
});

test('con entrambe torna la coppia, ripulita', () => {
    assert.deepEqual(
        telegramConfig({ TELEGRAM_BOT_TOKEN: ` ${TOKEN} `, TELEGRAM_CHAT_ID: ` ${CHAT} ` }),
        { token: TOKEN, chatId: CHAT }
    );
});

test('senza credenziali non si prova nemmeno a chiamare', async () => {
    const fetchImpl = fetchSpy(reply());
    await assert.rejects(
        () => sendReminder({ chatId: CHAT, text: 'ciao' }, { fetchImpl }),
        (error) => error.code === 'telegram-not-configured' && error.status === 503
    );
    assert.equal(fetchImpl.calls.length, 0);
});

/* ==========================================================
   PUBBLICAZIONE
   ========================================================== */

test('con la copertina si usa sendPhoto e il testo diventa didascalia', async () => {
    const fetchImpl = fetchSpy(reply());

    const result = await sendReminder(
        { token: TOKEN, chatId: CHAT, text: 'Promemoria', imageUrl: 'https://cdn/x.png', parseMode: 'HTML' },
        { fetchImpl }
    );

    assert.equal(fetchImpl.calls.length, 1);
    assert.equal(methodOf(fetchImpl.calls[0]), 'sendPhoto');
    assert.deepEqual(fetchImpl.calls[0].body, {
        chat_id: CHAT,
        photo: 'https://cdn/x.png',
        caption: 'Promemoria',
        parse_mode: 'HTML'
    });
    assert.deepEqual(result, { messageId: 42, method: 'sendPhoto', fellBack: false });
});

test('senza copertina si usa sendMessage', async () => {
    const fetchImpl = fetchSpy(reply());

    const result = await sendReminder({ token: TOKEN, chatId: CHAT, text: 'Promemoria', parseMode: 'HTML' }, { fetchImpl });

    assert.equal(methodOf(fetchImpl.calls[0]), 'sendMessage');
    assert.deepEqual(fetchImpl.calls[0].body, { chat_id: CHAT, text: 'Promemoria', parse_mode: 'HTML' });
    assert.equal(result.method, 'sendMessage');
    assert.equal(result.fellBack, false);
});

test('senza parseMode non si chiede nessuna formattazione', async () => {
    // I testi riscritti dall'AI sono piani: un parse_mode acceso li farebbe
    // rifiutare al primo < o & che capita dentro.
    const fetchImpl = fetchSpy(reply());
    await sendReminder({ token: TOKEN, chatId: CHAT, text: 'a < b & c' }, { fetchImpl });

    assert.equal(fetchImpl.calls[0].body.parse_mode, undefined);
});

test('se la copertina non viene accettata il promemoria parte lo stesso, come testo', async () => {
    const fetchImpl = fetchSpy(
        reply({ status: 400, body: { ok: false, description: 'failed to get HTTP URL content' } }),
        reply()
    );

    const result = await sendReminder(
        { token: TOKEN, chatId: CHAT, text: 'Promemoria', imageUrl: 'https://cdn/x.webp' },
        { fetchImpl }
    );

    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(methodOf(fetchImpl.calls[0]), 'sendPhoto');
    assert.equal(methodOf(fetchImpl.calls[1]), 'sendMessage');
    assert.equal(fetchImpl.calls[1].body.text, 'Promemoria');
    assert.deepEqual(result, { messageId: 42, method: 'sendMessage', fellBack: true });
});

test('un rifiuto che non riguarda l’immagine non viene ritentato', async () => {
    // 403 = il bot non e amministratore del canale. Riprovare senza foto non
    // cambierebbe niente, e all'admin va detto il vero motivo.
    const fetchImpl = fetchSpy(reply({ status: 403, body: { ok: false, description: 'bot is not a member of the channel chat' } }));

    await assert.rejects(
        () => sendReminder({ token: TOKEN, chatId: CHAT, text: 'x', imageUrl: 'https://cdn/x.png' }, { fetchImpl }),
        (error) => error.code === 'telegram-rejected' && error.extra.description.includes('not a member')
    );
    assert.equal(fetchImpl.calls.length, 1);
});

/* ==========================================================
   ERRORI
   ========================================================== */

test('il limite di frequenza riporta quanto aspettare', async () => {
    const fetchImpl = fetchSpy(reply({ status: 429, body: { ok: false, parameters: { retry_after: 7 } } }));

    await assert.rejects(
        () => sendReminder({ token: TOKEN, chatId: CHAT, text: 'x' }, { fetchImpl }),
        (error) => error.status === 429 && error.code === 'telegram-rate-limited' && error.extra.retryAfter === 7
    );
});

test('un token non valido e un problema di configurazione, non della richiesta', async () => {
    const fetchImpl = fetchSpy(reply({ status: 401, body: { ok: false, description: 'Unauthorized' } }));

    await assert.rejects(
        () => sendReminder({ token: TOKEN, chatId: CHAT, text: 'x' }, { fetchImpl }),
        (error) => error.code === 'telegram-unauthorized'
    );
});

test('timeout e rete irraggiungibile hanno codici distinti', async () => {
    const timeout = async () => { throw Object.assign(new Error('scaduto'), { name: 'TimeoutError' }); };
    await assert.rejects(
        () => sendReminder({ token: TOKEN, chatId: CHAT, text: 'x' }, { fetchImpl: timeout }),
        (error) => error.status === 504 && error.code === 'telegram-timeout'
    );

    const broken = async () => { throw new TypeError('fetch failed'); };
    await assert.rejects(
        () => sendReminder({ token: TOKEN, chatId: CHAT, text: 'x' }, { fetchImpl: broken }),
        (error) => error.status === 502 && error.code === 'telegram-unreachable'
    );
});

test('una risposta 200 con ok:false resta un rifiuto', async () => {
    // Telegram risponde 200 anche quando non pubblica: guardare solo lo status
    // farebbe segnare come inviato un promemoria mai uscito.
    const fetchImpl = fetchSpy(reply({ body: { ok: false, description: 'chat not found' } }));

    await assert.rejects(
        () => sendReminder({ token: TOKEN, chatId: CHAT, text: 'x' }, { fetchImpl }),
        (error) => error.code === 'telegram-rejected' && error.extra.description === 'chat not found'
    );
});

test('il token non trapela mai nell’errore', async () => {
    const fetchImpl = fetchSpy(reply({ status: 401, body: { ok: false, description: `token ${TOKEN} rifiutato` } }));

    const error = await sendReminder({ token: TOKEN, chatId: CHAT, text: 'x' }, { fetchImpl }).catch((caught) => caught);

    assert.ok(error instanceof TelegramError);
    const exposed = `${error.message} ${JSON.stringify(error.extra)} ${error.stack}`;
    assert.ok(!exposed.includes(TOKEN), 'il token e finito in un campo che arriva al client');
});
