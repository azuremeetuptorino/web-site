import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Sta fra i test dell'API pur essendo codice del browser, per lo stesso motivo
 * di rich-text.test.js: `npm test` e l'unico esecutore del progetto, e qui
 * dentro ci sono due cose che vale la pena non rompere — quali eventi finiscono
 * in home e quali nell'archivio, e l'escaping delle card.
 *
 * `config.js` legge `location` all'import: va messo prima.
 */
globalThis.location = { hostname: 'localhost', origin: 'http://localhost:4280' };

let view;
let filter;

before(async () => {
    view = await import('../../src/assets/js/render-events.js');
    filter = await import('../../src/assets/js/events-filter.js');
});

/** Adesso e il 21 settembre 2026, come nel resto degli esempi. */
const NOW = Date.parse('2026-09-21T12:00:00.000Z');

const event = (id, dateTime, extra = {}) => ({
    id,
    title: `Evento ${id}`,
    dateTime,
    timezone: 'Europe/Rome',
    ...extra
});

/** Tre futuri e quattro passati, mescolati: l'ordine lo deve fare il codice. */
const CALENDAR = [
    event('p-2024', '2024-05-10T16:30:00.000Z'),
    event('f-nov', '2026-11-11T17:30:00.000Z'),
    event('p-mar', '2026-03-11T17:30:00.000Z'),
    event('f-ott', '2026-10-16T13:00:00.000Z'),
    event('p-mag', '2026-05-13T16:30:00.000Z'),
    event('f-dic', '2026-12-09T17:30:00.000Z'),
    event('p-2023', '2023-11-08T18:00:00.000Z')
];

const ids = (events) => events.map((entry) => entry.id);

/** La griglia appende: serve un contenitore che sappia farlo. */
function fakeContainer() {
    return {
        innerHTML: '',
        insertAdjacentHTML(_position, html) { this.innerHTML += html; },
        get children() {
            return { length: (this.innerHTML.match(/<a /g) ?? []).length };
        }
    };
}

/* ==========================================================
   ORDINE E VISIBILITA
   ========================================================== */

test('i prossimi vengono prima in ordine di data, i passati dal piu recente', () => {
    assert.deepEqual(
        ids(view.visibleEvents({ events: CALENDAR }, NOW)),
        ['f-ott', 'f-nov', 'f-dic', 'p-mag', 'p-mar', 'p-2024', 'p-2023']
    );
});

test('un evento con active: false non arriva al pubblico', () => {
    const events = [...CALENDAR, event('nascosto', '2026-10-20T17:00:00.000Z', { active: false })];
    assert.equal(ids(view.visibleEvents({ events }, NOW)).includes('nascosto'), false);
});

test('un evento e passato quando e finita la sua fine, non il suo inizio', () => {
    const inCorso = event('oggi', '2026-09-21T10:00:00.000Z', { endTime: '2026-09-21T20:00:00.000Z' });
    assert.equal(view.isPast(inCorso, NOW), false, 'un evento in corso non e ancora un ricordo');
    assert.equal(view.isPast(event('ieri', '2026-09-20T17:00:00.000Z'), NOW), true);
});

/* ==========================================================
   HOME: I PRIMI CINQUE
   ========================================================== */

test('in home ne entrano cinque: i tre futuri e i due passati piu recenti', () => {
    const container = fakeContainer();
    const count = view.renderEvents(container, { events: CALENDAR }, NOW, { limit: 5 });

    assert.equal(count, 5);
    assert.equal((container.innerHTML.match(/swiper-slide/g) ?? []).length, 5);

    for (const id of ['f-ott', 'f-nov', 'f-dic', 'p-mag', 'p-mar']) {
        assert.ok(container.innerHTML.includes(`Evento ${id}`), `manca ${id}`);
    }
    for (const id of ['p-2024', 'p-2023']) {
        assert.equal(container.innerHTML.includes(`Evento ${id}`), false, `${id} non doveva entrare`);
    }
});

test('senza limite si renderizza tutto: e la stessa funzione, non una copia', () => {
    const container = fakeContainer();
    assert.equal(view.renderEvents(container, { events: CALENDAR }, NOW), CALENDAR.length);
});

test('con meno di cinque eventi il limite non inventa niente', () => {
    const container = fakeContainer();
    assert.equal(view.renderEvents(container, { events: CALENDAR.slice(0, 2) }, NOW, { limit: 5 }), 2);
});

/* ==========================================================
   LA CARD
   ========================================================== */

test('la card porta data nel fuso dell evento, luogo e badge', () => {
    const html = view.eventCard(event('x', '2026-10-16T13:00:00.000Z', {
        eventUrl: 'https://luma.com/2ffi3qjx',
        venue: { name: 'Aula 10', city: 'Torino' }
    }), NOW);

    assert.match(html, /<time datetime="2026-10-16T13:00:00\.000Z">ven 16 ott 2026, 15:00<\/time>/, 'le 13:00 UTC sono le 15:00 a Roma');
    assert.match(html, /Aula 10 · Torino/);
    assert.match(html, /badge upcoming">In arrivo/);
    assert.match(html, /target="_blank" rel="noopener noreferrer"/);
});

test('la descrizione sta nella griglia e non nel carosello', () => {
    const withExcerpt = event('x', '2026-10-16T13:00:00.000Z', { excerpt: 'Un pomeriggio su Copilot.' });

    assert.equal(view.eventCard(withExcerpt, NOW).includes('card-excerpt'), false);
    assert.match(view.eventCard(withExcerpt, NOW, { excerpt: true }), /card-excerpt">Un pomeriggio su Copilot\./);
});

test('un evento passato e senza link non diventa un link a caso', () => {
    const html = view.eventCard(event('vecchio', '2023-11-08T18:00:00.000Z'), NOW);

    assert.match(html, /class="card event-past"/);
    assert.match(html, /href="#"/);
    assert.equal(html.includes('target="_blank"'), false);
});

test('titolo e indirizzo ostili non escono dalla card', () => {
    const html = view.eventCard(event('x', '2026-10-16T13:00:00.000Z', {
        title: '<img src=x onerror=alert(1)>',
        eventUrl: 'javascript:alert(1)',
        imageUrl: 'javascript:alert(2)',
        venue: { city: '"><script>alert(3)</script>' }
    }), NOW, { excerpt: true });

    assert.equal(html.includes('<img src=x'), false);
    assert.equal(html.includes('<script>'), false);
    assert.equal(html.includes('javascript:'), false);
    assert.match(html, /&lt;img src=x/);
});

/* ==========================================================
   GRIGLIA
   ========================================================== */

test('la griglia riscrive tutto, oppure appende per "Mostra altri"', () => {
    const container = fakeContainer();
    view.renderEventGrid(container, CALENDAR.slice(0, 2), NOW);
    assert.equal(container.children.length, 2);

    view.renderEventGrid(container, CALENDAR.slice(2, 4), NOW, { append: true });
    assert.equal(container.children.length, 4, 'le card gia in pagina non si ricostruiscono');

    view.renderEventGrid(container, CALENDAR.slice(0, 1), NOW);
    assert.equal(container.children.length, 1, 'senza append si riparte da capo');
});

/* ==========================================================
   ANNI
   ========================================================== */

test('l anno e quello del fuso dell evento, non quello UTC', () => {
    // Mezzanotte e mezza del primo gennaio a Roma: in UTC e ancora il 31/12.
    assert.equal(filter.yearOf(event('capodanno', '2025-12-31T23:30:00.000Z')), '2026');
    // E lo stesso al contrario, per un fuso indietro rispetto a UTC.
    assert.equal(
        filter.yearOf({ dateTime: '2026-01-01T03:00:00.000Z', timezone: 'America/Los_Angeles' }),
        '2025'
    );
    assert.equal(filter.yearOf({ dateTime: 'non una data' }), '');
});

test('le chip sono gli anni degli eventi passati, dal piu recente', () => {
    assert.deepEqual(filter.yearsOf(CALENDAR, NOW), ['2026', '2024', '2023']);
});

/* ==========================================================
   FILTRO
   ========================================================== */

test('il segmentato divide futuro e passato', () => {
    const { upcoming, past } = filter.splitEvents(view.visibleEvents({ events: CALENDAR }, NOW), NOW);
    assert.deepEqual(ids(upcoming), ['f-ott', 'f-nov', 'f-dic']);
    assert.deepEqual(ids(past), ['p-mag', 'p-mar', 'p-2024', 'p-2023']);
});

test('una chip mostra solo il suo anno', () => {
    const events = view.visibleEvents({ events: CALENDAR }, NOW);

    assert.deepEqual(
        ids(filter.selectEvents(events, { status: filter.PAST, year: '2026' }, NOW)),
        ['p-mag', 'p-mar']
    );
    assert.deepEqual(
        ids(filter.selectEvents(events, { status: filter.PAST, year: filter.ALL_YEARS }, NOW)),
        ['p-mag', 'p-mar', 'p-2024', 'p-2023']
    );
});

test('senza query string si apre sui prossimi', () => {
    assert.deepEqual(filter.readFilter('', CALENDAR, NOW), { status: filter.UPCOMING, year: filter.ALL_YEARS });
});

test('senza eventi futuri si apre sui passati, non su una sezione vuota', () => {
    const soloPassati = CALENDAR.filter((entry) => entry.id.startsWith('p-'));
    assert.equal(filter.readFilter('', soloPassati, NOW).status, filter.PAST);
});

test('il link con stato e anno viene rispettato', () => {
    assert.deepEqual(
        filter.readFilter('?stato=passati&anno=2024', CALENDAR, NOW),
        { status: filter.PAST, year: '2024' }
    );
});

test('uno stato inventato e un anno senza eventi si ignorano invece di dare zero risultati', () => {
    assert.deepEqual(
        filter.readFilter('?stato=forse&anno=1999', CALENDAR, NOW),
        { status: filter.UPCOMING, year: filter.ALL_YEARS }
    );
});

test('lo stato torna nella query string, e l anno solo dove ha senso', () => {
    assert.equal(filter.filterToSearch({ status: filter.PAST, year: '2024' }), '?stato=passati&anno=2024');
    assert.equal(filter.filterToSearch({ status: filter.PAST, year: filter.ALL_YEARS }), '?stato=passati');
    assert.equal(
        filter.filterToSearch({ status: filter.UPCOMING, year: '2024' }),
        '?stato=prossimi',
        'l anno non si porta dietro il futuro'
    );
});

test('quello che si legge dalla query string e quello che ci si era scritto', () => {
    for (const state of [
        { status: filter.UPCOMING, year: filter.ALL_YEARS },
        { status: filter.PAST, year: filter.ALL_YEARS },
        { status: filter.PAST, year: '2024' }
    ]) {
        assert.deepEqual(filter.readFilter(filter.filterToSearch(state), CALENDAR, NOW), state);
    }
});
