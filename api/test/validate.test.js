import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateTeam, validateSponsors, validateEvents, ROLE_KEYS, LINK_TYPES, TIERS } from '../src/lib/validate.js';

/** Un membro minimo ma valido, da cui partire per i casi singoli. */
const member = (overrides = {}) => ({
    id: 'elena-rossi',
    name: 'Elena Rossi',
    roleKey: 'co-founder',
    ...overrides
});

const doc = (...members) => ({ version: 1, members });

/** Comodita: i path degli errori, per asserire che puntino al campo giusto. */
const paths = (result) => result.issues.map((issue) => issue.path);

test('un documento che non e un oggetto viene respinto senza esplodere', () => {
    for (const input of [null, 'team', 42, ['elena']]) {
        const result = validateTeam(input);
        assert.equal(result.ok, false, `${JSON.stringify(input)} non doveva passare`);
    }
});

test('members deve essere una lista', () => {
    const result = validateTeam({ version: 1, members: { uno: 'elena' } });
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['members']);
});

test('un membro completo passa e torna normalizzato', () => {
    const result = validateTeam(doc(member({
        name: '  Elena Rossi  ',
        nick: '@elena_cloud',
        role: 'Co-Founder',
        bio: 'Cloud Solution Architect.',
        avatarUrl: 'https://cdn.example/elena.jpg',
        link: { type: 'linkedin', url: 'https://www.linkedin.com/in/elena' },
        order: 10,
        active: true
    })));

    assert.equal(result.ok, true);
    assert.equal(result.value.version, 1);
    assert.equal(result.value.members[0].name, 'Elena Rossi', 'gli spazi vanno tolti');
    assert.equal(result.value.members[0].link.type, 'linkedin');
});

test('i campi sconosciuti non finiscono sul blob', () => {
    const result = validateTeam(doc(member({ superAdmin: true, salary: 99 })));
    assert.equal(result.ok, true);
    assert.deepEqual(
        Object.keys(result.value.members[0]).sort(),
        ['active', 'id', 'name', 'order', 'roleKey']
    );
});

test('updatedAt e updatedBy dal client vengono ignorati: li mette il server', () => {
    const result = validateTeam({
        ...doc(member()),
        updatedBy: 'qualcun-altro@example.com',
        updatedAt: '1999-01-01T00:00:00Z'
    });
    assert.equal(result.ok, true);
    assert.equal(result.value.updatedBy, undefined);
    assert.equal(result.value.updatedAt, undefined);
});

test('id: obbligatorio e nel formato slug', () => {
    for (const id of ['', 'Elena Rossi', 'elena_rossi', 'e', '-elena', 'ELENA']) {
        const result = validateTeam(doc(member({ id })));
        assert.equal(result.ok, false, `"${id}" non doveva passare`);
        assert.ok(paths(result).includes('members[0].id'));
    }
});

test('due membri con lo stesso id sono un errore, e lo dice quale', () => {
    const result = validateTeam(doc(member(), member({ name: 'Elena Bis' })));
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['members[1].id']);
    assert.match(result.issues[0].message, /elena-rossi/);
});

test('name obbligatorio, anche se fatto di soli spazi', () => {
    const result = validateTeam(doc(member({ name: '   ' })));
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['members[0].name']);
});

test('roleKey deve stare nell enum, role invece e testo libero', () => {
    const rifiutato = validateTeam(doc(member({ roleKey: 'capo-supremo' })));
    assert.equal(rifiutato.ok, false);
    assert.deepEqual(paths(rifiutato), ['members[0].roleKey']);

    for (const roleKey of ROLE_KEYS) {
        assert.equal(validateTeam(doc(member({ roleKey }))).ok, true, roleKey);
    }

    const libero = validateTeam(doc(member({ role: 'Capo supremo di tutto' })));
    assert.equal(libero.ok, true);
});

test('avatarUrl: https si, http pubblico no, http locale si (serve ad Azurite)', () => {
    assert.equal(validateTeam(doc(member({ avatarUrl: 'https://cdn.example/a.jpg' }))).ok, true);
    assert.equal(validateTeam(doc(member({ avatarUrl: 'http://cdn.example/a.jpg' }))).ok, false);
    assert.equal(validateTeam(doc(member({ avatarUrl: 'javascript:alert(1)' }))).ok, false);
    assert.equal(
        validateTeam(doc(member({ avatarUrl: 'http://127.0.0.1:10000/devstoreaccount1/public/a.jpg' }))).ok,
        true
    );
});

test('avatarUrl e opzionale: senza, il sito mette il segnaposto', () => {
    const result = validateTeam(doc(member({ avatarUrl: '' })));
    assert.equal(result.ok, true);
    assert.equal('avatarUrl' in result.value.members[0], false);
});

test('link: vuoto va bene, a meta no', () => {
    assert.equal(validateTeam(doc(member({ link: { type: '', url: '' } }))).ok, true);
    assert.equal(validateTeam(doc(member({ link: null }))).ok, true);

    const senzaUrl = validateTeam(doc(member({ link: { type: 'github' } })));
    assert.equal(senzaUrl.ok, false);
    assert.deepEqual(paths(senzaUrl), ['members[0].link.url']);

    const tipoIgnoto = validateTeam(doc(member({ link: { type: 'friendster', url: 'https://x.example' } })));
    assert.equal(tipoIgnoto.ok, false);
    assert.deepEqual(paths(tipoIgnoto), ['members[0].link.type']);
});

test('tutti i tipi di link renderizzati dal sito sono accettati', () => {
    for (const type of LINK_TYPES) {
        const result = validateTeam(doc(member({ link: { type, url: 'https://example.com' } })));
        assert.equal(result.ok, true, type);
    }
});

test('order accetta anche la stringa che arriva da un input numerico', () => {
    const result = validateTeam(doc(member({ order: '30' })));
    assert.equal(result.ok, true);
    assert.equal(result.value.members[0].order, 30);

    assert.equal(validateTeam(doc(member({ order: 'presto' }))).ok, false);
    assert.equal(validateTeam(doc(member({ order: 1.5 }))).ok, false);
});

test('senza order e senza active valgono i default', () => {
    const result = validateTeam(doc(member()));
    assert.equal(result.value.members[0].order, 0);
    assert.equal(result.value.members[0].active, true);
});

test('active:false passa la validazione: nasconde senza cancellare', () => {
    const result = validateTeam(doc(member({ active: false })));
    assert.equal(result.ok, true);
    assert.equal(result.value.members[0].active, false);
});

test('una bio smisurata viene respinta con il suo limite nel messaggio', () => {
    const result = validateTeam(doc(member({ bio: 'a'.repeat(241) })));
    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /240/);
});

test('gli errori si raccolgono tutti, non solo il primo', () => {
    const result = validateTeam(doc(
        member({ id: 'NON VALIDO', name: '' }),
        member({ id: 'marco-bianchi', roleKey: 'boh' })
    ));

    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['members[0].id', 'members[0].name', 'members[1].roleKey']);
});

test('una lista vuota e legittima: e il documento appena creato', () => {
    const result = validateTeam({ version: 1, members: [] });
    assert.equal(result.ok, true);
    assert.deepEqual(result.value, { version: 1, members: [] });
});

test('una lista assurdamente lunga viene fermata prima di validarla tutta', () => {
    const result = validateTeam({ version: 1, members: Array.from({ length: 201 }, () => member()) });
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['members']);
});

/* ==========================================================
   SPONSOR
   ========================================================== */

const sponsor = (overrides = {}) => ({
    id: 'acme-cloud',
    name: 'ACME Cloud',
    tier: 'gold',
    logoUrl: 'https://cdn.example/acme.svg',
    ...overrides
});

const sponsorDoc = (...sponsors) => ({ version: 1, sponsors });

test('sponsor: il documento seed del repo e valido cosi com e', async () => {
    const { readFileSync } = await import('node:fs');
    const seed = JSON.parse(readFileSync(new URL('../../src/data/sponsors.json', import.meta.url), 'utf8'));

    const result = validateSponsors(seed);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.equal(result.value.sponsors.length, seed.sponsors.length);
});

test('sponsor: uno sponsor completo passa e torna ripulito', () => {
    const result = validateSponsors(sponsorDoc(sponsor({
        logoDarkUrl: 'https://cdn.example/acme-dark.svg',
        websiteUrl: 'https://acme.example',
        description: 'Partner infrastrutturale dal 2025.',
        since: '2025',
        order: 10,
        active: true
    })));

    assert.equal(result.ok, true);
    assert.equal(result.value.sponsors[0].since, '2025');
    assert.equal(result.value.sponsors[0].websiteUrl, 'https://acme.example/');
});

test('sponsor: il logo e obbligatorio, senza la card sarebbe vuota', () => {
    const result = validateSponsors(sponsorDoc(sponsor({ logoUrl: '' })));
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['sponsors[0].logoUrl']);
});

test('sponsor: il tier deve stare nell enum', () => {
    const rifiutato = validateSponsors(sponsorDoc(sponsor({ tier: 'titanium' })));
    assert.equal(rifiutato.ok, false);
    assert.deepEqual(paths(rifiutato), ['sponsors[0].tier']);

    for (const tier of TIERS) {
        assert.equal(validateSponsors(sponsorDoc(sponsor({ tier }))).ok, true, tier);
    }
});

test('sponsor: senza websiteUrl va bene, la card non sara un link', () => {
    const result = validateSponsors(sponsorDoc(sponsor({ websiteUrl: null })));
    assert.equal(result.ok, true);
    assert.equal('websiteUrl' in result.value.sponsors[0], false);
});

test('sponsor: since accetta un anno, non una data', () => {
    assert.equal(validateSponsors(sponsorDoc(sponsor({ since: '2025' }))).ok, true);

    for (const since of ['2025-03-01', 'duemila', '25', '1999']) {
        const result = validateSponsors(sponsorDoc(sponsor({ since })));
        assert.equal(result.ok, false, `"${since}" non doveva passare`);
        assert.deepEqual(paths(result), ['sponsors[0].since']);
    }
});

test('sponsor: una descrizione oltre i 200 caratteri viene respinta', () => {
    const result = validateSponsors(sponsorDoc(sponsor({ description: 'a'.repeat(201) })));
    assert.equal(result.ok, false);
    assert.match(result.issues[0].message, /200/);
});

test('sponsor: due id uguali sono un errore e lo dice quale', () => {
    const result = validateSponsors(sponsorDoc(sponsor(), sponsor({ name: 'ACME bis' })));
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['sponsors[1].id']);
    assert.match(result.issues[0].message, /acme-cloud/);
});

test('sponsor: i campi sconosciuti non finiscono sul blob', () => {
    const result = validateSponsors(sponsorDoc(sponsor({ prezzo: 5000, contratto: 'segreto' })));
    assert.deepEqual(
        Object.keys(result.value.sponsors[0]).sort(),
        ['active', 'id', 'logoUrl', 'name', 'order', 'tier']
    );
});

/* ==========================================================
   URL: REGOLE CONDIVISE
   ========================================================== */

test('un percorso del sito e ammesso, uno che eredita lo schema no', () => {
    assert.equal(validateSponsors(sponsorDoc(sponsor({ logoUrl: '/assets/img/sponsors/acme.svg' }))).ok, true);

    // //evil.example non e un percorso: e una URL senza schema.
    const protocolRelative = validateSponsors(sponsorDoc(sponsor({ logoUrl: '//evil.example/x.svg' })));
    assert.equal(protocolRelative.ok, false);
    assert.deepEqual(paths(protocolRelative), ['sponsors[0].logoUrl']);
});

test('gli schemi pericolosi restano fuori da qualunque campo URL', () => {
    for (const logoUrl of ['javascript:alert(1)', 'data:image/svg+xml;base64,PHN2Zz4=', 'vbscript:x']) {
        assert.equal(validateSponsors(sponsorDoc(sponsor({ logoUrl }))).ok, false, logoUrl);
    }
});

/* ==========================================================
   EVENTI
   ========================================================== */

const event = (overrides = {}) => ({
    id: 'luma-2ffi3qjx',
    title: 'Dev Days | Turin, Italy',
    dateTime: '2026-10-16T15:00:00+02:00',
    ...overrides
});

const eventDoc = (...events) => ({ version: 1, events });

test('eventi: il documento seed del repo e valido cosi com e', async () => {
    const { readFileSync } = await import('node:fs');
    const seed = JSON.parse(readFileSync(new URL('../../src/data/events.json', import.meta.url), 'utf8'));
    const result = validateEvents(seed);
    assert.equal(result.ok, true, JSON.stringify(result.issues));
    assert.ok(result.value.events.length > 0);
});

test('eventi: un evento completo passa e le date tornano in UTC', () => {
    const result = validateEvents(eventDoc(event({
        endTime: '2026-10-16T18:00:00+02:00',
        timezone: 'Europe/Rome',
        isOnline: false,
        eventUrl: 'https://luma.com/2ffi3qjx',
        imageUrl: 'https://images.lumacdn.com/x.png',
        excerpt: '  Una serata su Copilot.  ',
        venue: { name: 'Aula 10', address: 'Via Durandi 10', city: 'Torino' },
        active: true,
        going: 42
    })));

    assert.equal(result.ok, true, JSON.stringify(result.issues));
    const saved = result.value.events[0];
    assert.equal(saved.dateTime, '2026-10-16T13:00:00.000Z');
    assert.equal(saved.endTime, '2026-10-16T16:00:00.000Z');
    assert.equal(saved.excerpt, 'Una serata su Copilot.');
    assert.equal('going' in saved, false, 'i campi sconosciuti non finiscono sul blob');
});

test('eventi: titolo e data di inizio sono obbligatori', () => {
    const result = validateEvents(eventDoc({ id: 'x1' }));
    assert.equal(result.ok, false);
    assert.deepEqual(paths(result), ['events[0].dateTime', 'events[0].title']);
});

test('eventi: una data che non si legge viene segnalata sul campo giusto', () => {
    const result = validateEvents(eventDoc(event({ dateTime: 'giovedi prossimo' })));
    assert.deepEqual(paths(result), ['events[0].dateTime']);
});

test('eventi: la fine non puo precedere l inizio', () => {
    const result = validateEvents(eventDoc(event({ endTime: '2026-10-16T14:00:00+02:00' })));
    assert.deepEqual(paths(result), ['events[0].endTime']);
});

test('eventi: il fuso orario mancante diventa Europe/Rome, uno inventato e rifiutato', () => {
    assert.equal(validateEvents(eventDoc(event())).value.events[0].timezone, 'Europe/Rome');
    assert.deepEqual(paths(validateEvents(eventDoc(event({ timezone: 'Marte/Olympus' })))), ['events[0].timezone']);
    assert.equal(validateEvents(eventDoc(event({ timezone: 'America/New_York' }))).ok, true);
});

test('eventi: un luogo con tutti i campi vuoti sparisce, uno con la sola citta resta', () => {
    assert.equal('venue' in validateEvents(eventDoc(event({ venue: { name: '', address: '', city: '' } }))).value.events[0], false);
    assert.deepEqual(validateEvents(eventDoc(event({ venue: { city: 'Torino' } }))).value.events[0].venue, { city: 'Torino' });
});

test('eventi: due id uguali si scontrano', () => {
    const result = validateEvents(eventDoc(event(), event({ title: 'Doppione' })));
    assert.deepEqual(paths(result), ['events[1].id']);
});

test('eventi: eventUrl e imageUrl seguono le stesse regole delle altre URL', () => {
    const result = validateEvents(eventDoc(event({ eventUrl: 'javascript:alert(1)', imageUrl: '//cdn.evil/x.png' })));
    assert.deepEqual(paths(result), ['events[0].eventUrl', 'events[0].imageUrl']);
});
