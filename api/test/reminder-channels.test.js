import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    CHANNELS,
    channelById,
    channelSummaries,
    countChars,
    fit,
    formatWhen,
    formatWhere
} from '../src/lib/reminder-channels.js';

/**
 * Qui si verifica la parte che non parla con nessuno: come si scrive il
 * promemoria e cosa si sacrifica quando non ci sta. Sono le due cose che
 * rompono il post pubblicato, e sono verificabili senza rete ne storage.
 */

const EVENT = {
    id: 'luma-2ffi3qjx',
    title: 'GitHub Dev Days, tappa di Torino',
    dateTime: '2026-10-16T13:00:00.000Z',
    timezone: 'Europe/Rome',
    isOnline: false,
    eventUrl: 'https://luma.com/2ffi3qjx',
    imageUrl: 'https://images.lumacdn.com/cover.png',
    excerpt: 'Una giornata di sessioni pratiche su Copilot, Actions e sicurezza della supply chain.',
    venue: { name: 'Aula 10 dell’ITS ICT Piemonte', address: 'Via Jacopo Durandi, 10', city: 'Torino' }
};

const longText = (length) => 'parola '.repeat(Math.ceil(length / 7)).slice(0, length);

/* ==========================================================
   DATA E LUOGO
   ========================================================== */

test('la data e in italiano e nell’ora del posto, non in UTC', () => {
    // 13:00 UTC a ottobre sono le 15:00 a Roma: e l'ora a cui presentarsi.
    assert.equal(formatWhen(EVENT), 'Venerdi 16 ottobre 2026, ore 15:00'.replace('Venerdi', 'Venerdì'));
});

test('un fuso diverso sposta l’ora scritta', () => {
    assert.match(formatWhen({ ...EVENT, timezone: 'America/New_York' }), /ore 09:00$/);
});

test('senza data non si inventa niente', () => {
    assert.equal(formatWhen({}), '');
    assert.equal(formatWhen({ dateTime: 'non-una-data' }), '');
});

test('il luogo online vince su tutto', () => {
    assert.equal(formatWhere({ ...EVENT, isOnline: true }), 'Online');
});

test('la citta non si ripete se il nome della sala la contiene gia', () => {
    assert.equal(formatWhere({ venue: { name: 'Talent Garden Torino', city: 'Torino' } }), 'Talent Garden Torino');
    assert.equal(formatWhere({ venue: { name: 'Aula 10', city: 'Torino' } }), 'Aula 10 - Torino');
    assert.equal(formatWhere({ venue: { city: 'Torino' } }), 'Torino');
    assert.equal(formatWhere({}), '');
});

/* ==========================================================
   MISURE E TAGLI
   ========================================================== */

test('un’emoji conta come un carattere, non come due', () => {
    assert.equal(countChars('📣'), 1);
    assert.equal('📣'.length, 2);
});

test('sotto il limite non si tocca niente', () => {
    const result = fit({ head: (t) => t, title: 'Titolo', excerpt: 'Descrizione', tail: 'Coda' }, 100);
    assert.equal(result.truncated, false);
    assert.deepEqual(result.notes, []);
    assert.equal(result.text, 'Titolo\n\nDescrizione\n\nCoda');
});

test('la prima cosa che si accorcia e la descrizione', () => {
    const result = fit({ head: (t) => t, title: 'Titolo', excerpt: longText(500), tail: 'https://luma.com/x' }, 200);

    assert.equal(result.truncated, true);
    assert.ok(result.length <= 200, `lunghezza ${result.length}`);
    assert.ok(result.text.startsWith('Titolo'), 'il titolo intero resta');
    assert.ok(result.text.includes('https://luma.com/x'), 'il link resta');
    assert.ok(result.text.includes('…'), 'la descrizione e tagliata con i puntini');
    assert.match(result.notes.join(' '), /Descrizione accorciata/);
});

test('quando resta troppo poco spazio la descrizione si toglie del tutto', () => {
    // Titolo e descrizione con parole diverse, se no non si distingue chi e stato tagliato.
    const title = 'titolone '.repeat(14).trim();
    const result = fit({ head: (t) => t, title, excerpt: 'descrizione '.repeat(25), tail: 'https://luma.com/x' }, 160);

    assert.ok(!result.text.includes('descrizione'), 'la descrizione non c’e piu');
    assert.ok(result.text.includes('titolone'), 'il titolo invece resta');
    assert.match(result.notes.join(' '), /Descrizione tolta/);
});

test('il titolo si accorcia solo dopo la descrizione, e il link non si tocca mai', () => {
    const url = 'https://luma.com/evento-molto-lungo';
    const result = fit({ head: (t) => `Titolo: ${t}`, title: longText(400), excerpt: longText(200), tail: url }, 120);

    assert.ok(result.length <= 120, `lunghezza ${result.length}`);
    assert.ok(result.text.includes(url), 'il link e intero');
    assert.match(result.notes.join(' '), /Titolo accorciato/);
});

test('se nemmeno cosi ci sta, lo dice invece di fingere', () => {
    const result = fit({ head: (t) => t, title: 'x', tail: longText(300) }, 50);

    assert.equal(result.truncated, true);
    assert.ok(result.length > 50, 'il testo torna comunque, intero');
    assert.match(result.notes.join(' '), /supera i 50 caratteri/);
});

/* ==========================================================
   I QUATTRO CANALI
   ========================================================== */

test('ogni canale sta nel proprio limite anche con un evento pieno', () => {
    const fat = { ...EVENT, title: longText(120), excerpt: longText(300) };

    for (const channel of CHANNELS) {
        const result = channel.buildText(fat, '7d');
        assert.ok(
            result.length <= result.limit,
            `${channel.id}: ${result.length} caratteri contro un limite di ${result.limit}`
        );
    }
});

test('ogni canale nomina l’evento, la data e il link', () => {
    for (const channel of CHANNELS) {
        const { text } = channel.buildText(EVENT, '14d');
        assert.match(text, /GitHub Dev Days/, channel.id);
        assert.match(text, /16 ottobre 2026/, channel.id);
        assert.ok(text.includes(EVENT.eventUrl), `${channel.id} non porta il link`);
        assert.match(text, /Mancano due settimane/, channel.id);
    }
});

test('ogni finestra ha il suo conto alla rovescia', () => {
    const telegram = channelById('telegram');
    assert.match(telegram.buildText(EVENT, '14d').text, /Mancano due settimane/);
    assert.match(telegram.buildText(EVENT, '7d').text, /Manca una settimana/);
    assert.match(telegram.buildText(EVENT, '2d').text, /mancano due giorni/);
});

test('Telegram: con la foto il limite scende a 1024, senza risale a 4096', () => {
    const telegram = channelById('telegram');
    assert.equal(telegram.buildText(EVENT, '7d').limit, 1024);
    assert.equal(telegram.buildText({ ...EVENT, imageUrl: undefined }, '7d').limit, 4096);
});

test('nessun canale produce markup: il testo si copia e si incolla com\u2019e', () => {
    // Su Telegram la Bot API saprebbe leggere l'HTML, ma lo stesso testo si
    // copia anche a mano, e l'app di Telegram i tag li scriverebbe e basta.
    for (const id of ['telegram', 'whatsapp', 'linkedin', 'instagram']) {
        const { text } = channelById(id).buildText({ ...EVENT, title: 'Dev & Ops <script>' }, '7d');

        assert.ok(text.includes('Dev & Ops <script>'), `${id} ha alterato il titolo: ${text}`);
        assert.ok(!text.includes('&amp;'), `${id} ha escapato un testo che e gia piano`);
        assert.ok(!text.includes('<b>'), `${id} non deve avere tag`);
    }
});

test('nessun canale dichiara un parse_mode', () => {
    // Se un canale tornasse a chiederlo, il testo andrebbe anche riescapato.
    for (const channel of CHANNELS) {
        assert.equal(channel.parseMode, undefined, channel.id);
    }
});

test('Instagram: al massimo 30 hashtag, link non cliccabile e immagine obbligatoria', () => {
    const result = channelById('instagram').buildText(EVENT, '7d');

    const hashtags = result.text.match(/#\w+/g) ?? [];
    assert.ok(hashtags.length <= 30, `${hashtags.length} hashtag`);
    assert.ok(hashtags.length > 0, 'gli hashtag ci sono');
    assert.match(result.text, /link in bio/);
    assert.ok(result.text.includes(EVENT.eventUrl), 'la URL e scritta comunque, anche se non cliccabile');
    assert.equal(result.requiresImage, true);
    assert.equal(result.imageUrl, EVENT.imageUrl);
    assert.match(result.notes.join(' '), /scaricala qui accanto/);
});

test('Instagram senza immagine avverte che il post non si puo fare', () => {
    const result = channelById('instagram').buildText({ ...EVENT, imageUrl: undefined }, '7d');
    assert.equal(result.imageUrl, null);
    assert.match(result.notes.join(' '), /non accetta post senza/);
});

test('senza link di iscrizione la riga sparisce e la nota lo spiega', () => {
    for (const channel of CHANNELS) {
        const result = channel.buildText({ ...EVENT, eventUrl: undefined }, '7d');
        assert.ok(!result.text.includes('Iscriviti gratis'), channel.id);
        assert.ok(!result.text.includes('iscrizione qui'), channel.id);
        assert.match(result.notes.join(' '), /Manca il link di iscrizione/, channel.id);
    }
});

test('un evento online scrive Online al posto della sala', () => {
    const { text } = channelById('whatsapp').buildText({ ...EVENT, isOnline: true }, '7d');
    assert.match(text, /📍 Online/);
    assert.ok(!text.includes('Aula 10'));
});

test('senza descrizione non resta una riga vuota di troppo', () => {
    const { text } = channelById('linkedin').buildText({ ...EVENT, excerpt: undefined }, '7d');
    assert.ok(!text.includes('\n\n\n'), text);
});

test('il riassunto dei canali e quello che serve al browser per le schede', () => {
    assert.deepEqual(channelSummaries().map((channel) => channel.id), ['telegram', 'whatsapp', 'linkedin', 'instagram']);
    assert.deepEqual(
        channelSummaries().find((channel) => channel.id === 'telegram'),
        { id: 'telegram', label: 'Telegram', icon: 'bi-telegram', mode: 'api' }
    );
    // Telegram e l'unico che sa spedire da solo.
    assert.deepEqual(
        channelSummaries().filter((channel) => channel.mode === 'api').map((channel) => channel.id),
        ['telegram']
    );
    assert.equal(channelById('mastodon'), null);
});
