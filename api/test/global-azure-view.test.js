import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Codice del browser, qui per lo stesso motivo di events-view.test.js: e
 * l'unico esecutore del progetto. Si controlla che la pagina /global-azure/
 * metta le foto prima di agenda e speaker quando l'edizione e gia passata.
 *
 * `config.js` legge `location` all'import: va messo prima.
 */
globalThis.location = { hostname: 'localhost', origin: 'http://localhost:4280' };

let view;

before(async () => {
    view = await import('../../src/assets/js/render-global-azure.js');
});

/** Adesso e il 30 settembre 2026. */
const NOW = Date.parse('2026-09-30T12:00:00.000Z');

test('un\'edizione passata mette le foto prima di agenda e speaker', () => {
    const edition = { id: '2026', year: 2026, date: '2026-04-18' };
    assert.equal(view.editionPhase(edition, NOW), 'past');
    assert.deepEqual(view.sectionOrder(edition, 'past', NOW), ['foto', 'agenda', 'speaker']);
});

test('un\'edizione in arrivo o in corso tiene il programma in cima', () => {
    const upcoming = { id: '2027', year: 2027, date: '2027-04-17' };
    assert.deepEqual(view.sectionOrder(upcoming, view.editionPhase(upcoming, NOW), NOW), ['agenda', 'speaker', 'foto']);

    const live = { id: '2026', year: 2026, date: '2026-09-30' };
    assert.equal(view.editionPhase(live, NOW), 'live');
    assert.deepEqual(view.sectionOrder(live, 'live', NOW), ['agenda', 'speaker', 'foto']);
});

test('senza data decide l\'anno: alle spalle vale come passata', () => {
    const old = { id: '2024', year: 2024 };
    assert.equal(view.editionPhase(old, NOW), 'unknown');
    assert.equal(view.isEditionOver(old, 'unknown', NOW), true);
    assert.deepEqual(view.sectionOrder(old, 'unknown', NOW), ['foto', 'agenda', 'speaker']);

    const thisYear = { id: '2026', year: 2026 };
    assert.equal(view.isEditionOver(thisYear, 'unknown', NOW), false);
});

test('il conto alla rovescia parte alle 9 di Torino del giorno dell\'edizione', () => {
    assert.equal(view.editionStart({ date: '2027-04-17' }), Date.parse('2027-04-17T07:00:00.000Z'));
    assert.ok(Number.isNaN(view.editionStart({ date: 'aprile' })));
    assert.ok(Number.isNaN(view.editionStart({})));
});

test('a edizione passata il primo bottone della hero porta alle foto', () => {
    const edition = { id: '2026', year: 2026, date: '2026-04-18' };
    const content = { sessions: [{ id: 's' }], photos: [{ url: 'https://x/1.jpg' }] };
    const html = view.renderHeroActions(edition, 'past', content);
    assert.ok(html.indexOf('#foto') < html.indexOf('#agenda'));
    assert.match(html, /ga-btn-primary" href="#foto"/);
});

test('sull\'hostname dedicato i link del sito puntano al dominio principale', () => {
    assert.equal(view.isDedicatedHost('torino.globalazure.it'), true);
    assert.equal(view.isDedicatedHost('torinomeetup-ffc6avhbfjg7frhb.z03.azurefd.net'), true);
    assert.equal(view.isDedicatedHost('torino.azuremeetup.it'), false);
    assert.equal(view.isDedicatedHost('nice-sea-123.azurestaticapps.net'), false);
    assert.equal(view.isDedicatedHost('localhost'), false);

    assert.equal(view.dedicatedHostHref('/'), 'https://torino.azuremeetup.it/');
    assert.equal(view.dedicatedHostHref('/#staff'), 'https://torino.azuremeetup.it/#staff');
    assert.equal(view.dedicatedHostHref('/eventi/'), 'https://torino.azuremeetup.it/eventi/');
    assert.equal(view.dedicatedHostHref('#agenda'), '#agenda');
    assert.equal(view.dedicatedHostHref('https://example.com/'), 'https://example.com/');
});

test('le sessioni sovrapposte nella stessa traccia non invadono la riga successiva', () => {
    const content = {
        tracks: [{ id: 'main', name: 'Sala principale' }],
        speakers: [],
        sessions: [
            { id: 'prima', title: 'Prima', start: '2026-12-11T14:25:00.000Z', end: '2026-12-11T14:55:00.000Z', trackId: 'main' },
            { id: 'seconda', title: 'Seconda', start: '2026-12-11T14:50:00.000Z', end: '2026-12-11T15:25:00.000Z', trackId: 'main' }
        ]
    };

    const first = view.renderAgenda(content).match(/<button[^>]+data-session="prima"[\s\S]*?<\/button>/)?.[0];
    assert.match(first, /grid-row:1 \/ span 1/);
});

test('una sessione puo occupare piu righe se la traccia non ha una collisione', () => {
    const content = {
        tracks: [
            { id: 'a', name: 'Sala A' },
            { id: 'b', name: 'Sala B' }
        ],
        speakers: [],
        sessions: [
            { id: 'lunga', title: 'Lunga', start: '2026-12-11T09:00:00.000Z', end: '2026-12-11T10:00:00.000Z', trackId: 'a' },
            { id: 'breve', title: 'Breve', start: '2026-12-11T09:30:00.000Z', end: '2026-12-11T10:00:00.000Z', trackId: 'b' }
        ]
    };

    const long = view.renderAgenda(content).match(/<button[^>]+data-session="lunga"[\s\S]*?<\/button>/)?.[0];
    assert.match(long, /grid-row:1 \/ span 2/);
});
