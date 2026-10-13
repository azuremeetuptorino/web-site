import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Codice del browser, qui per lo stesso motivo di events-view.test.js. Si
 * controlla chi va nel banner della home (Global Azure o un evento speciale)
 * e che le card degli eventi speciali portino alla loro pagina.
 *
 * `config.js` legge `location` all'import: va messo prima.
 */
globalThis.location = { hostname: 'localhost', origin: 'http://localhost:4280' };

let featured;
let events;

before(async () => {
    featured = await import('../../src/assets/js/render-featured.js');
    events = await import('../../src/assets/js/render-events.js');
});

/** Adesso e il 13 ottobre 2026. */
const NOW = Date.parse('2026-10-13T10:00:00.000Z');

const event = (id, dateTime, extra = {}) => ({ id, title: `Evento ${id}`, dateTime, timezone: 'Europe/Rome', ...extra });

const GA_PAST = { editions: [{ id: '2026', year: 2026, date: '2026-04-18', current: true }] };
const GA_NEXT = (date) => ({ editions: [{ id: '2027', year: 2027, date, current: true }] });

test('senza eventi speciali in arrivo il banner resta di Global Azure', () => {
    const payload = { events: [event('normale', '2026-11-11T17:30:00.000Z')] };
    assert.deepEqual(featured.pickHomeBanner(payload, GA_PAST, NOW), { kind: 'ga' });
});

test('un evento speciale in arrivo prende il banner', () => {
    const payload = { events: [event('dev-days', '2026-11-11T17:30:00.000Z', { featured: true })] };
    const choice = featured.pickHomeBanner(payload, GA_PAST, NOW);
    assert.equal(choice.kind, 'event');
    assert.equal(choice.event.id, 'dev-days');
});

test('un evento speciale gia passato o spento non conta', () => {
    const payload = {
        events: [
            event('passato', '2026-09-11T17:30:00.000Z', { featured: true }),
            event('spento', '2026-11-11T17:30:00.000Z', { featured: true, active: false })
        ]
    };
    assert.deepEqual(featured.pickHomeBanner(payload, GA_PAST, NOW), { kind: 'ga' });
});

test('tra due eventi in arrivo vince il piu vicino', () => {
    const payload = { events: [event('dicembre', '2026-12-11T17:30:00.000Z', { featured: true })] };
    assert.equal(featured.pickHomeBanner(payload, GA_NEXT('2026-11-28'), NOW).kind, 'ga');
    assert.equal(featured.pickHomeBanner(payload, GA_NEXT('2027-04-17'), NOW).kind, 'event');
});

test('senza Global Azure il banner puo essere solo dell evento', () => {
    const payload = { events: [event('dev-days', '2026-11-11T17:30:00.000Z', { featured: true })] };
    assert.equal(featured.pickHomeBanner(payload, null, NOW).kind, 'event');
});

test('le fasi di un evento: prima, durante, dopo', () => {
    const entry = event('x', '2026-10-13T09:00:00.000Z', { endTime: '2026-10-13T12:00:00.000Z' });
    assert.equal(featured.eventPhase(entry, Date.parse('2026-10-13T08:00:00.000Z')), 'upcoming');
    assert.equal(featured.eventPhase(entry, NOW), 'live');
    assert.equal(featured.eventPhase(entry, Date.parse('2026-10-13T13:00:00.000Z')), 'past');
});

test('la pagina si apre solo per un evento speciale pubblicato', () => {
    const payload = { events: [event('a', '2026-11-11T17:30:00.000Z', { featured: true }), event('b', '2026-11-12T17:30:00.000Z')] };
    assert.equal(featured.findFeatured(payload, 'a')?.id, 'a');
    assert.equal(featured.findFeatured(payload, 'b'), null);
    assert.equal(featured.findFeatured(payload, 'zzz'), null);
});

test('la card di un evento speciale porta alla sua pagina, senza aprire una scheda', () => {
    const card = events.eventCard(event('dev-days', '2026-11-11T17:30:00.000Z', { featured: true, eventUrl: 'https://luma.com/x' }), NOW);
    assert.match(card, /href="\/evento\/\?id=dev-days"/);
    assert.doesNotMatch(card, /target="_blank"/);

    const plain = events.eventCard(event('altro', '2026-11-11T17:30:00.000Z', { eventUrl: 'https://luma.com/x' }), NOW);
    assert.match(plain, /href="https:\/\/luma\.com\/x" target="_blank"/);
});

test('le azioni della hero: iscriversi prima, le foto dopo', () => {
    const content = { sessions: [{}], photos: [{}, {}] };
    const entry = event('x', '2026-11-11T17:30:00.000Z', { eventUrl: 'https://luma.com/x' });
    assert.match(featured.renderEventHeroActions(entry, 'upcoming', content), /Iscriviti[\s\S]*Sessioni[\s\S]*2 foto/);
    const after = featured.renderEventHeroActions(entry, 'past', content);
    assert.doesNotMatch(after, /Iscriviti/);
    assert.match(after, /2 foto[\s\S]*Sessioni/);
});
