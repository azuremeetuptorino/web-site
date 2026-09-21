import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    normalizeSourceUrl,
    fetchPage,
    parseEventPage,
    importEvent,
    excerptFrom,
    suggestId,
    ImportError,
    ALLOWED_HOSTS
} from '../src/lib/event-import.js';
import { validateEvents } from '../src/lib/validate.js';

/**
 * Le fixture sono le pagine vere di Luma e Meetup ridotte ai soli dati
 * strutturati (JSON-LD, meta Open Graph e il pezzo di __NEXT_DATA__ che si
 * usa): 5 KB invece di 130, e un test che fallisce quando cambia qualcosa che
 * conta, non quando cambia un banner.
 */
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const LUMA_URL = 'https://luma.com/2ffi3qjx';
const MEETUP_URL = 'https://www.meetup.com/it-it/meetup-microsoft-azure-torino/events/316647090/?eventOrigin=group_events_list';

const htmlResponse = (html, init = {}) =>
    new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, ...init });

/** Un fetch finto che risponde per URL e registra cosa gli e stato chiesto. */
function fakeFetch(routes) {
    const calls = [];
    const impl = async (url, options) => {
        calls.push({ url, options });
        const route = routes[url];
        if (!route) throw new TypeError(`fetch failed: ${url}`);
        return typeof route === 'function' ? route() : route;
    };
    impl.calls = calls;
    return impl;
}

/* ==========================================================
   URL DI PARTENZA
   ========================================================== */

test('il link di Meetup perde la query string di tracciamento', () => {
    const url = normalizeSourceUrl(MEETUP_URL);
    assert.equal(url.toString(), 'https://www.meetup.com/it-it/meetup-microsoft-azure-torino/events/316647090/');
});

test('si accettano solo https e gli host di Luma e Meetup', () => {
    for (const bad of ['', '   ', 'non-un-url', 'http://luma.com/abc', 'https://example.com/evento', 'https://luma.com.evil.io/x', 'https://169.254.169.254/metadata']) {
        assert.throws(() => normalizeSourceUrl(bad), ImportError, bad);
    }
    for (const good of ['https://luma.com/2ffi3qjx', 'https://lu.ma/2ffi3qjx', 'https://www.meetup.com/g/events/1/', 'https://meetup.com/g/events/1/']) {
        assert.doesNotThrow(() => normalizeSourceUrl(good), good);
    }
});

test('un host non ammesso spiega quali lo sono', () => {
    try {
        normalizeSourceUrl('https://www.eventbrite.it/e/123');
        assert.fail('doveva rifiutare');
    } catch (error) {
        assert.equal(error.status, 400);
        assert.equal(error.code, 'host-not-allowed');
        assert.deepEqual(error.extra.allowed, ALLOWED_HOSTS);
    }
});

/* ==========================================================
   DOWNLOAD
   ========================================================== */

test('i redirect si seguono a mano e restano sugli host ammessi', async () => {
    const fetchImpl = fakeFetch({
        'https://lu.ma/abc': new Response(null, { status: 301, headers: { location: 'https://luma.com/abc' } }),
        'https://luma.com/abc': htmlResponse(fixture('luma-event.html'))
    });

    const { finalUrl } = await fetchPage(new URL('https://lu.ma/abc'), { fetchImpl });

    assert.equal(finalUrl.toString(), 'https://luma.com/abc');
    assert.equal(fetchImpl.calls.length, 2);
    assert.equal(fetchImpl.calls[0].options.redirect, 'manual', 'fetch non deve seguire i redirect da solo');
});

test('un redirect verso un host esterno viene rifiutato', async () => {
    const fetchImpl = fakeFetch({
        'https://luma.com/abc': new Response(null, { status: 302, headers: { location: 'https://evil.example/steal' } })
    });

    await assert.rejects(fetchPage(new URL('https://luma.com/abc'), { fetchImpl }), (error) => {
        assert.equal(error.code, 'host-not-allowed');
        return true;
    });
    assert.equal(fetchImpl.calls.length, 1, 'l host esterno non deve essere contattato');
});

test('404 dalla piattaforma -> upstream-not-found, 5xx -> upstream-failed', async () => {
    const notFound = fakeFetch({ 'https://luma.com/x': new Response('', { status: 404 }) });
    await assert.rejects(fetchPage(new URL('https://luma.com/x'), { fetchImpl: notFound }), (error) => error.code === 'upstream-not-found' && error.status === 404);

    const broken = fakeFetch({ 'https://luma.com/x': new Response('', { status: 503 }) });
    await assert.rejects(fetchPage(new URL('https://luma.com/x'), { fetchImpl: broken }), (error) => error.code === 'upstream-failed' && error.status === 502);
});

test('rete irraggiungibile e timeout hanno codici distinti', async () => {
    const down = fakeFetch({});
    await assert.rejects(fetchPage(new URL('https://luma.com/x'), { fetchImpl: down }), (error) => error.code === 'upstream-unreachable');

    const slow = async () => {
        const error = new Error('timeout');
        error.name = 'TimeoutError';
        throw error;
    };
    await assert.rejects(fetchPage(new URL('https://luma.com/x'), { fetchImpl: slow }), (error) => error.code === 'upstream-timeout' && error.status === 504);
});

test('una pagina oltre il limite di byte si interrompe invece di essere letta tutta', async () => {
    const fetchImpl = fakeFetch({ 'https://luma.com/x': htmlResponse('a'.repeat(2048)) });

    await assert.rejects(fetchPage(new URL('https://luma.com/x'), { fetchImpl, maxBytes: 1024 }), (error) => error.code === 'upstream-too-large');
});

/* ==========================================================
   LUMA
   ========================================================== */

test('Luma: la pagina diventa una scheda completa', () => {
    const { event, platform } = parseEventPage(fixture('luma-event.html'), normalizeSourceUrl(LUMA_URL));

    assert.equal(platform, 'luma');
    assert.equal(event.id, 'luma-2ffi3qjx');
    assert.equal(event.title, 'Dev Days | Turin, Italy');
    assert.equal(event.dateTime, '2026-10-16T13:00:00.000Z', 'le 15:00 di Roma in UTC');
    assert.equal(event.endTime, '2026-10-16T16:00:00.000Z');
    assert.equal(event.timezone, 'Europe/Rome');
    assert.equal(event.isOnline, false);
    assert.equal(event.eventUrl, 'https://luma.com/2ffi3qjx');
    assert.match(event.imageUrl, /^https:\/\/images\.lumacdn\.com\//);
    assert.match(event.excerpt, /^✨ Dev Days is a global/);
    assert.ok(event.excerpt.length <= 300);
    assert.deepEqual(event.venue, {
        name: "Aula 10 dell'ITS ICT Piemonte",
        address: 'Via Jacopo Durandi, 10',
        city: 'Torino'
    });
    assert.equal(event.active, true);
});

test('Luma: senza __NEXT_DATA__ resta il JSON-LD, e il nome della sala manca', () => {
    const html = fixture('luma-event.html').replace(/<script id="__NEXT_DATA__"[\s\S]*?<\/script>/, '');
    const { event } = parseEventPage(html, normalizeSourceUrl(LUMA_URL));

    assert.equal(event.title, 'Dev Days | Turin, Italy');
    assert.deepEqual(event.venue, { address: 'Via Jacopo Durandi, 10', city: 'Torino' });
});

/* ==========================================================
   MEETUP
   ========================================================== */

test('Meetup: la pagina diventa una scheda completa', () => {
    const { event, platform } = parseEventPage(fixture('meetup-event.html'), normalizeSourceUrl(MEETUP_URL));

    assert.equal(platform, 'meetup');
    assert.equal(event.id, 'meetup-316647090');
    assert.equal(event.title, 'GitHub Dev Days');
    assert.equal(event.dateTime, '2026-10-16T13:00:00.000Z');
    assert.equal(event.endTime, '2026-10-16T16:00:00.000Z');
    assert.equal(event.isOnline, false);
    assert.equal(event.eventUrl, 'https://www.meetup.com/meetup-microsoft-azure-torino/events/316647090/', 'la URL canonica, senza locale ne query');
    assert.match(event.imageUrl, /^https:\/\/secure\.meetupstatic\.com\//);
    assert.deepEqual(event.venue, { address: 'Via Jacopo Durandi, 10, 10144 Torino TO, Italy', city: 'Torino' });
});

test('Meetup: l estratto viene dalla descrizione completa, non da quella troncata del JSON-LD', () => {
    const { event } = parseEventPage(fixture('meetup-event.html'), normalizeSourceUrl(MEETUP_URL));

    assert.match(event.excerpt, /^Dopo il successo del Microsoft Build/, 'via il \\| iniziale e i grassetti');
    assert.ok(event.excerpt.length > 150, 'il JSON-LD si ferma a 150 caratteri');
    assert.ok(event.excerpt.length <= 300);
    assert.ok(event.excerpt.endsWith('…'));
});

/* ==========================================================
   CASI LIMITE
   ========================================================== */

test('una pagina senza JSON-LD Event -> no-event-found (422)', () => {
    assert.throws(
        () => parseEventPage('<html><head><title>x</title></head><body>niente</body></html>', normalizeSourceUrl(LUMA_URL)),
        (error) => error instanceof ImportError && error.status === 422 && error.code === 'no-event-found'
    );
});

test('un blocco JSON-LD rotto non impedisce di leggere gli altri', () => {
    const html = `<script type="application/ld+json">{ rotto</script>
<script type="application/ld+json">{"@context":"https://schema.org","@type":"SocialEvent","name":"Aperitech","startDate":"2026-11-05T18:30:00+01:00","eventAttendanceMode":"https://schema.org/OnlineEventAttendanceMode","location":{"@type":"VirtualLocation","url":"https://teams.microsoft.com/x"}}</script>`;

    const { event } = parseEventPage(html, normalizeSourceUrl('https://luma.com/aperitech'));

    assert.equal(event.title, 'Aperitech');
    assert.equal(event.isOnline, true, 'i sottotipi di Event e la modalita online vanno riconosciuti');
    assert.equal(event.venue, undefined);
    assert.equal(event.dateTime, '2026-11-05T17:30:00.000Z');
});

test('un @graph con dentro l Event viene trovato', () => {
    const html = `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"WebPage","name":"pagina"},{"@type":"Event","name":"Nel grafo","startDate":"2026-12-01T18:00:00+01:00"}]}</script>`;
    const { event } = parseEventPage(html, normalizeSourceUrl('https://luma.com/grafo'));
    assert.equal(event.title, 'Nel grafo');
});

test('excerptFrom: taglia all ultima parola intera e pulisce il markdown', () => {
    assert.equal(excerptFrom('**Ciao** a [tutti](https://x.y) \\| bene'), 'Ciao a tutti | bene');
    const long = excerptFrom(`${'parola '.repeat(80)}fine`, 50);
    assert.ok(long.length <= 50);
    assert.ok(long.endsWith('…'));
    assert.ok(!long.includes('parol…'), 'non deve spezzare una parola');
    assert.equal(excerptFrom(''), undefined);
    assert.equal(excerptFrom(undefined), undefined);
});

test('suggestId: stabile per piattaforma, con un ripiego da titolo e data', () => {
    assert.equal(suggestId('meetup', new URL('https://www.meetup.com/it-IT/gruppo/events/316647090/'), 'x', undefined), 'meetup-316647090');
    assert.equal(suggestId('luma', new URL('https://luma.com/2ffi3qjx'), 'x', undefined), 'luma-2ffi3qjx');
    assert.equal(suggestId(null, new URL('https://luma.com/'), 'Serverless & Functions', '2026-12-09T17:30:00.000Z'), '2026-12-09-serverless-functions');
});

/* ==========================================================
   IL GIRO COMPLETO
   ========================================================== */

test('importEvent: quello che torna passa il validatore degli eventi cosi com e', async () => {
    const fetchImpl = fakeFetch({ 'https://luma.com/2ffi3qjx': htmlResponse(fixture('luma-event.html')) });

    const result = await importEvent(`${LUMA_URL}?utm_source=x#dettagli`, { fetchImpl });

    assert.equal(result.source.platform, 'luma');
    assert.equal(result.source.url, 'https://luma.com/2ffi3qjx');
    assert.ok(Date.parse(result.source.fetchedAt) > 0);

    const validation = validateEvents({ version: 1, events: [result.event] });
    assert.equal(validation.ok, true, JSON.stringify(validation.issues));
    assert.deepEqual(validation.value.events[0], result.event, 'nessun campo da ripulire: l importazione produce gia lo schema finale');
});

test('importEvent: la richiesta si presenta come un browser in italiano', async () => {
    const fetchImpl = fakeFetch({ 'https://luma.com/2ffi3qjx': htmlResponse(fixture('luma-event.html')) });
    await importEvent(LUMA_URL, { fetchImpl });

    const { headers, signal } = fetchImpl.calls[0].options;
    assert.match(headers['user-agent'], /Mozilla/);
    assert.match(headers['accept-language'], /^it-IT/);
    assert.ok(signal instanceof AbortSignal, 'senza timeout una pagina lenta blocca la function');
});
