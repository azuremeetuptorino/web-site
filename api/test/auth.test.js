import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getClientPrincipal, hasRole, requireRole } from '../src/lib/auth.js';
import { handleMe } from '../src/functions/me.js';

/** Costruisce una richiesta con l'header che inietta il runtime di SWA. */
function requestWith(principal) {
    const headers = new Map();
    if (principal !== undefined) {
        headers.set(
            'x-ms-client-principal',
            Buffer.from(JSON.stringify(principal), 'utf8').toString('base64')
        );
    }
    return { headers: { get: (name) => headers.get(name.toLowerCase()) ?? null } };
}

const ADMIN = {
    identityProvider: 'aad',
    userId: 'abc123',
    userDetails: 'alberto.annunziata@alveo.it',
    userRoles: ['anonymous', 'authenticated', 'admin']
};

const VISITOR = { ...ADMIN, userRoles: ['anonymous', 'authenticated'] };

test('senza header il principal e nullo', () => {
    assert.equal(getClientPrincipal(requestWith(undefined)), null);
});

test('un header non decodificabile non fa esplodere la function', () => {
    const request = { headers: { get: () => 'questo-non-e-base64-di-json' } };
    assert.equal(getClientPrincipal(request), null);
});

test('userRoles mancante diventa array vuoto, non undefined', () => {
    const principal = getClientPrincipal(requestWith({ userId: 'x' }));
    assert.deepEqual(principal.userRoles, []);
    assert.equal(hasRole(principal, 'admin'), false);
});

test('il principal viene letto correttamente', () => {
    const principal = getClientPrincipal(requestWith(ADMIN));
    assert.equal(principal.userDetails, 'alberto.annunziata@alveo.it');
    assert.equal(principal.identityProvider, 'aad');
    assert.ok(principal.userRoles.includes('admin'));
});

test('requireRole: 401 se non autenticato, 403 se senza ruolo, ok se admin', () => {
    assert.deepEqual(requireRole(requestWith(undefined), 'admin'), { ok: false, status: 401 });
    assert.deepEqual(requireRole(requestWith(VISITOR), 'admin'), { ok: false, status: 403 });

    const granted = requireRole(requestWith(ADMIN), 'admin');
    assert.equal(granted.ok, true);
    assert.equal(granted.principal.userId, 'abc123');
});

test('un ruolo simile non passa per quello giusto', () => {
    const almost = { ...ADMIN, userRoles: ['authenticated', 'administrator', 'admin-readonly'] };
    assert.equal(requireRole(requestWith(almost), 'admin').ok, false);
});

test('GET /api/me senza sessione risponde 401 senza cache', async () => {
    const response = await handleMe(requestWith(undefined));
    assert.equal(response.status, 401);
    assert.equal(response.headers['Cache-Control'], 'no-store');
    assert.equal(response.jsonBody.error, 'unauthenticated');
});

test('GET /api/me distingue admin da semplice autenticato', async () => {
    const asAdmin = await handleMe(requestWith(ADMIN));
    assert.equal(asAdmin.status, 200);
    assert.equal(asAdmin.jsonBody.isAdmin, true);

    const asVisitor = await handleMe(requestWith(VISITOR));
    assert.equal(asVisitor.status, 200);
    assert.equal(asVisitor.jsonBody.isAdmin, false);
});

test('la risposta di /api/me non espone campi oltre a quelli previsti', async () => {
    const response = await handleMe(requestWith({ ...ADMIN, claims: [{ typ: 'secret', val: 'x' }] }));
    assert.deepEqual(
        Object.keys(response.jsonBody).sort(),
        ['identityProvider', 'isAdmin', 'roles', 'userDetails', 'userId']
    );
});
