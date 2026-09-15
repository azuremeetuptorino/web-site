import { test } from 'node:test';
import assert from 'node:assert/strict';

import { validateTeam, ROLE_KEYS, LINK_TYPES } from '../src/lib/validate.js';

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
