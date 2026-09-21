import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prepareUpload, sanitizeSvg, sniffType, assetName, MAX_BYTES, ALLOWED_TYPES } from '../src/lib/image.js';

/* ==========================================================
   CAMPIONI
   ========================================================== */

/** I magic number veri, seguiti da riempimento: il riconoscimento guarda la testa. */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 7)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 1), Buffer.from('WEBP'), Buffer.alloc(64, 7)]);
const SVG = Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>');

/** Un eseguibile Windows: inizia con "MZ". */
const EXE = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(128, 0)]);

const upload = (overrides = {}) => prepareUpload({
    kind: 'avatar',
    filename: 'Elena Rossi.png',
    contentType: 'image/png',
    dataBase64: PNG.toString('base64'),
    ...overrides
});

/* ==========================================================
   RICONOSCIMENTO
   ========================================================== */

test('sniffType riconosce i formati ammessi dai byte', () => {
    assert.equal(sniffType(PNG), 'image/png');
    assert.equal(sniffType(JPEG), 'image/jpeg');
    assert.equal(sniffType(WEBP), 'image/webp');
    assert.equal(sniffType(SVG), 'image/svg+xml');
});

test('sniffType non si fa ingannare da un RIFF che non e WebP', () => {
    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4, 1), Buffer.from('WAVE'), Buffer.alloc(32)]);
    assert.equal(sniffType(wav), null);
});

test('sniffType riconosce un SVG preceduto da commenti e spazi', () => {
    const svg = Buffer.from('\n<!-- fatto a mano -->\n  <svg viewBox="0 0 2 2"></svg>');
    assert.equal(sniffType(svg), 'image/svg+xml');
});

test('sniffType non dice immagine a un eseguibile', () => {
    assert.equal(sniffType(EXE), null);
});

/* ==========================================================
   CONTROLLI IN INGRESSO
   ========================================================== */

test('un kind sconosciuto viene respinto e dice quali sono validi', () => {
    const result = upload({ kind: 'documento' });
    assert.equal(result.ok, false);
    assert.equal(result.status, 400);
    assert.deepEqual(result.body.allowed, ['avatar', 'sponsor', 'site', 'event']);
});

test('un content-type fuori allowlist risponde 415 elencando quelli buoni', () => {
    const result = upload({ contentType: 'image/gif' });
    assert.equal(result.status, 415);
    assert.equal(result.body.error, 'unsupported-type');
    assert.deepEqual(result.body.allowed, ALLOWED_TYPES);
});

test('un base64 malformato non passa per un file vuoto', () => {
    for (const dataBase64 of ['', '!!!!', 'non-e-base64!!']) {
        const result = upload({ dataBase64 });
        assert.equal(result.ok, false, `"${dataBase64}" non doveva passare`);
        assert.equal(result.status, 400);
    }
});

test('il base64 con gli a capo dentro viene accettato', () => {
    const spezzato = PNG.toString('base64').replace(/(.{10})/g, '$1\n');
    assert.equal(upload({ dataBase64: spezzato }).ok, true);
});

test('oltre il mezzo mega risponde 413 dicendo il limite', () => {
    const grosso = Buffer.concat([PNG, Buffer.alloc(MAX_BYTES, 9)]);
    const result = upload({ dataBase64: grosso.toString('base64') });

    assert.equal(result.status, 413);
    assert.equal(result.body.error, 'too-large');
    assert.equal(result.body.maxBytes, 512 * 1024);
});

test('un .exe rinominato .png viene fermato dai byte, non dal nome', () => {
    const result = upload({ filename: 'innocuo.png', dataBase64: EXE.toString('base64') });

    assert.equal(result.status, 415);
    assert.equal(result.body.detected, null);
    assert.equal(result.body.declared, 'image/png');
});

test('un content-type dichiarato diverso dal contenuto viene respinto', () => {
    const result = upload({ contentType: 'image/svg+xml', dataBase64: PNG.toString('base64') });

    assert.equal(result.status, 415);
    assert.equal(result.body.detected, 'image/png');
});

/* ==========================================================
   ESITO
   ========================================================== */

test('un PNG valido finisce in avatars/ con cache lunga e senza Content-Disposition', () => {
    const result = upload();

    assert.equal(result.ok, true);
    assert.match(result.asset.path, /^avatars\/elena-rossi-[0-9a-f]{8}\.png$/);
    assert.equal(result.asset.headers.contentType, 'image/png');
    assert.equal(result.asset.headers.cacheControl, 'public, max-age=31536000, immutable');
    assert.equal(result.asset.headers.contentDisposition, undefined);
});

test('il logo di uno sponsor finisce in sponsors/', () => {
    const result = upload({ kind: 'sponsor', filename: 'ACME Cloud.jpeg', contentType: 'image/jpeg', dataBase64: JPEG.toString('base64') });

    assert.equal(result.ok, true);
    assert.match(result.asset.path, /^sponsors\/acme-cloud-[0-9a-f]{8}\.jpg$/);
});

test('le immagini della home finiscono in site/', () => {
    const result = upload({ kind: 'site', filename: 'skyline.png' });
    assert.equal(result.ok, true);
    assert.match(result.asset.path, /^site\/skyline-[0-9a-f]{8}\.png$/);
});

test('l estensione viene dal tipo riconosciuto, non da quella scritta nel nome', () => {
    const result = upload({ filename: 'foto.jpeg.txt', dataBase64: PNG.toString('base64') });
    assert.match(result.asset.path, /\.png$/);
});

test('un nome fatto di soli simboli non produce un file senza nome', () => {
    const result = upload({ filename: '???.png' });
    assert.match(result.asset.path, /^avatars\/immagine-[0-9a-f]{8}\.png$/);
});

test('stessi byte stesso nome, byte diversi nome diverso', () => {
    const primo = assetName('foto.png', PNG, 'png');
    const uguale = assetName('foto.png', PNG, 'png');
    const altro = assetName('foto.png', Buffer.concat([PNG, Buffer.from([1])]), 'png');

    assert.equal(primo, uguale, 'ricaricare lo stesso file non deve moltiplicare i blob');
    assert.notEqual(primo, altro, 'un file diverso deve cambiare URL, altrimenti resta in cache il vecchio');
});

/* ==========================================================
   SANIFICAZIONE SVG
   ========================================================== */

test('sanitizeSvg toglie script, foreignObject e gestori di evento', () => {
    const ostile = `<svg xmlns="http://www.w3.org/2000/svg" onload="fetch('//evil.example')">
        <script>alert(1)</script>
        <foreignObject><body xmlns="http://www.w3.org/1999/xhtml">ciao</body></foreignObject>
        <rect width="10" height="10" onclick='rubaTutto()' onmouseover=x()/>
    </svg>`;

    const pulito = sanitizeSvg(ostile);

    assert.equal(/<script/i.test(pulito), false);
    assert.equal(/foreignObject/i.test(pulito), false);
    assert.equal(/onload/i.test(pulito), false);
    assert.equal(/onclick/i.test(pulito), false);
    assert.equal(/onmouseover/i.test(pulito), false);
    assert.ok(pulito.includes('<rect'), 'il disegno vero deve restare');
});

test('sanitizeSvg toglie i riferimenti esterni ma tiene quelli interni', () => {
    const svg = `<svg><use xlink:href="https://evil.example/x.svg#a"/><use href="#logo"/><a href="http://evil.example">x</a></svg>`;
    const pulito = sanitizeSvg(svg);

    assert.equal(pulito.includes('evil.example'), false);
    assert.ok(pulito.includes('href="#logo"'), 'i rimandi interni servono al disegno');
});

test('sanitizeSvg toglie un href javascript: senza virgolette', () => {
    const pulito = sanitizeSvg('<svg><a href=javascript:alert(1)>x</a><use href=#ok /></svg>');

    assert.equal(pulito.includes('javascript:'), false);
    assert.ok(pulito.includes('href=#ok'), 'il rimando interno senza virgolette resta');
});

test('un SVG caricato viene salvato sanificato e come allegato', () => {
    const ostile = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script><rect width="1" height="1"/></svg>';
    const result = upload({
        kind: 'sponsor',
        filename: 'acme.svg',
        contentType: 'image/svg+xml',
        dataBase64: Buffer.from(ostile).toString('base64')
    });

    assert.equal(result.ok, true);
    assert.equal(result.asset.body.includes('<script'), false, 'lo script non deve arrivare sul blob');

    // La difesa vera: aprendo la URL del blob il file si scarica invece di
    // essere renderizzato, quindi anche cio che sfugge alla regex non esegue.
    assert.equal(result.asset.headers.contentDisposition, 'attachment');
});

test('il nome dell SVG dipende dai byte sanificati, non da quelli caricati', () => {
    const conScript = '<svg><script>alert(1)</script><rect width="1" height="1"/></svg>';
    const senzaScript = '<svg><rect width="1" height="1"/></svg>';

    const sporco = upload({ kind: 'sponsor', filename: 'a.svg', contentType: 'image/svg+xml', dataBase64: Buffer.from(conScript).toString('base64') });
    const pulito = upload({ kind: 'sponsor', filename: 'a.svg', contentType: 'image/svg+xml', dataBase64: Buffer.from(senzaScript).toString('base64') });

    assert.equal(sporco.asset.path, pulito.asset.path, 'due file che diventano identici devono avere la stessa URL');
});
