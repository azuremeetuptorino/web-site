import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { importSessionize, fromJson, localToUtc } from '../src/lib/sessionize.js';
import { validateGlobalAzureEdition } from '../src/lib/validate.js';

/**
 * Le fixture sono le tre viste della embed di Global Azure Torino 2026
 * (`dtzcs2li`), salvate cosi come le serve Sessionize.
 */
const fixture = (name) => readFile(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

const FIXTURES = {
    '/view/All': 'sessionize-embed-loader.js',
    '/view/GridSmart?under=True': 'sessionize-grid.html',
    '/view/Sessions?under=True': 'sessionize-sessions.html',
    '/view/Speakers?under=True': 'sessionize-speakers.html'
};

function embedFetch(calls = []) {
    return async (url, options) => {
        calls.push({ url, options });
        const suffix = Object.keys(FIXTURES).find((key) => url.endsWith(key));
        if (!suffix) return new Response('no', { status: 404 });
        return new Response(await fixture(FIXTURES[suffix]), { status: 200 });
    };
}

test('endpoint solo embed: ricompone agenda e speaker dalle tre viste', async () => {
    const calls = [];
    const result = await importSessionize('dtzcs2li', { fetchImpl: embedFetch(calls) });

    assert.equal(result.source.mode, 'embed');
    assert.equal(calls.length, 4);
    assert.equal(calls[1].options.headers['x-requested-with'], 'XMLHttpRequest');

    assert.deepEqual(result.tracks.map((track) => track.id),
        ['data-dev-and-ai', 'security', 'infrastructure', 'modernwork-copilot']);
    assert.equal(result.speakers.length, 31);
    assert.equal(result.sessions.length, 26);

    const checkIn = result.sessions.find((session) => session.title === 'Check - In');
    assert.equal(checkIn.kind, 'service');
    assert.equal(checkIn.trackId, undefined);
    assert.equal(checkIn.start, '2026-04-18T06:30:00.000Z');

    const welcome = result.sessions.find((session) => session.id === 's-1206220');
    assert.equal(welcome.kind, 'plenary');
    assert.equal(welcome.speakerIds.length, 7);
    assert.match(welcome.description, /Introduzione/);

    assert.equal(result.sessions.find((session) => session.id === 's-1183169').kind, 'keynote');

    const talk = result.sessions.find((session) => session.id === 's-1120323');
    assert.equal(talk.trackId, 'security');
    assert.equal(talk.language, 'en');

    const speaker = result.speakers.find((entry) => entry.id === 'alberto-jacomuzzi');
    assert.match(speaker.bio, /\n/);
    assert.match(speaker.photoUrl, /^https:\/\/cdn\.sessionize\.com\//);
});

test('il risultato dell’import passa la validazione dell’edizione', async () => {
    const result = await importSessionize('dtzcs2li', { fetchImpl: embedFetch() });
    const validated = validateGlobalAzureEdition(result);

    assert.equal(validated.ok, true, JSON.stringify(validated.issues));
});

test('due import di fila producono gli stessi id', async () => {
    const one = await importSessionize('dtzcs2li', { fetchImpl: embedFetch() });
    const two = await importSessionize('dtzcs2li', { fetchImpl: embedFetch() });

    assert.deepEqual(one.sessions.map((session) => session.id), two.sessions.map((session) => session.id));
    assert.deepEqual(one.speakers.map((speaker) => speaker.id), two.speakers.map((speaker) => speaker.id));
});

test('endpoint JSON: orari locali di Torino convertiti in UTC', () => {
    const result = fromJson({
        rooms: [{ id: 1, name: 'Sala Blu', sort: 1 }],
        categories: [{ title: 'Language', items: [{ id: 9, name: 'English' }] }],
        speakers: [{
            id: 'u-1',
            fullName: 'Grace Hopper',
            tagLine: 'Microsoft MVP',
            links: [{ url: 'https://www.linkedin.com/in/grace' }, { url: 'https://x.com/grace' }]
        }],
        sessions: [{
            id: '42',
            title: 'Compilers',
            startsAt: '2026-04-18T11:15:00',
            endsAt: '2026-04-18T12:10:00',
            roomId: 1,
            speakers: ['u-1'],
            categoryItems: [9]
        }]
    });

    assert.deepEqual(result.tracks, [{ id: 'sala-blu', name: 'Sala Blu' }]);
    assert.deepEqual(result.speakers[0].badges, ['Microsoft MVP']);
    assert.deepEqual(result.speakers[0].links, { linkedin: 'https://www.linkedin.com/in/grace', x: 'https://x.com/grace' });
    assert.deepEqual(result.sessions[0], {
        id: 's-42',
        title: 'Compilers',
        start: '2026-04-18T09:15:00.000Z',
        end: '2026-04-18T10:10:00.000Z',
        trackId: 'sala-blu',
        speakerIds: ['grace-hopper'],
        language: 'en',
        kind: 'talk'
    });
});

test('localToUtc segue l’ora legale', () => {
    assert.equal(localToUtc('2026-01-15T10:00:00'), '2026-01-15T09:00:00.000Z');
    assert.equal(localToUtc('2026-04-18T10:00:00'), '2026-04-18T08:00:00.000Z');
});

test('Sessionize irraggiungibile e un 502 con codice', async () => {
    await assert.rejects(
        importSessionize('dtzcs2li', { fetchImpl: async () => { throw new TypeError('fetch failed'); } }),
        (error) => error.status === 502 && error.code === 'upstream-unreachable'
    );
});
