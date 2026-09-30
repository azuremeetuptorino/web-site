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
