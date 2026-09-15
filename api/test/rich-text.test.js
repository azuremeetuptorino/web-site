import { test, before } from 'node:test';
import assert from 'node:assert/strict';

/**
 * Sta fra i test dell'API pur essendo codice del browser, per un motivo
 * pratico: `npm test` e l'unico esecutore del progetto, e questo e il modulo
 * in cui un errore di escaping diventa XSS sulla pagina pubblica. Meglio qui
 * che non testato.
 *
 * `safeUrl` legge `location` per risolvere gli indirizzi relativi: nel browser
 * c'e, qui va messo prima dell'import.
 */
globalThis.location = { hostname: 'localhost', origin: 'http://localhost:4280' };

let renderRichText;
let paragraphsOf;

before(async () => {
    ({ renderRichText, paragraphsOf } = await import('../../src/assets/js/rich-text.js'));
});

/* ==========================================================
   PARAGRAFI
   ========================================================== */

test('una riga vuota separa i paragrafi, due o tre righe pure', () => {
    assert.deepEqual(paragraphsOf('uno\n\ndue\n\n\n   \n\ntre'), ['uno', 'due', 'tre']);
    assert.deepEqual(paragraphsOf(''), []);
    assert.deepEqual(paragraphsOf(undefined), []);
});

test('un a capo singolo non spezza il paragrafo', () => {
    assert.equal(renderRichText('prima riga\nseconda riga'), '<p>prima riga\nseconda riga</p>');
});

test('l apertura in grassetto va solo sul primo paragrafo', () => {
    const html = renderRichText('uno\n\ndue', 'Azure Meetup Torino');
    assert.match(html, /^<p><strong>Azure Meetup Torino<\/strong> uno<\/p>/);
    assert.match(html, /<p>due<\/p>$/);
});

test('senza testo ma con apertura resta l apertura, senza niente resta vuoto', () => {
    assert.equal(renderRichText('', 'Solo apertura'), '<p><strong>Solo apertura</strong> </p>');
    assert.equal(renderRichText('', ''), '');
});

/* ==========================================================
   FORMATTAZIONE
   ========================================================== */

test('il grassetto diventa <strong>', () => {
    assert.equal(renderRichText('prima del **15 ottobre**.'), '<p>prima del <strong>15 ottobre</strong>.</p>');
});

test('un link esterno si apre in una scheda nuova, con rel di sicurezza', () => {
    const html = renderRichText('Iscriviti a [Azure Day](https://www.meetup.com/x).');
    assert.match(html, /<a href="https:\/\/www\.meetup\.com\/x" target="_blank" rel="noopener noreferrer">Azure Day<\/a>/);
});

test('un rimando interno resta nella stessa scheda e non diventa assoluto', () => {
    assert.match(renderRichText('vai agli [eventi](#eventi)'), /<a href="#eventi">eventi<\/a>/);
    assert.match(renderRichText('vedi la [pagina](/403.html)'), /<a href="[^"]*\/403\.html"[^>]*>pagina<\/a>/);
});

test('piu formattazioni nello stesso paragrafo', () => {
    const html = renderRichText('**Attenzione**: [iscriviti](https://x.it) entro **oggi**.');
    assert.equal(
        html,
        '<p><strong>Attenzione</strong>: <a href="https://x.it/" target="_blank" rel="noopener noreferrer">iscriviti</a> entro <strong>oggi</strong>.</p>'
    );
});

test('un link dentro il grassetto funziona: e la frase che si scrive davvero', () => {
    const html = renderRichText('**iscriviti su [Meetup](https://meetup.com/x)** entro domani.');
    assert.match(html, /<strong>iscriviti su <a href="https:\/\/meetup\.com\/x"[^>]*>Meetup<\/a><\/strong>/);
});

test('il testo di un link invece non diventa grassetto: resta com e scritto', () => {
    const html = renderRichText('[**Meetup**](https://meetup.com/x)');
    assert.match(html, />\*\*Meetup\*\*</);
});

/* ==========================================================
   SICUREZZA
   ========================================================== */

test('l HTML scritto a mano viene mostrato, non eseguito', () => {
    const html = renderRichText('<script>alert(1)</script> e <img src=x onerror=alert(2)>');
    assert.equal(html.includes('<script'), false);
    assert.equal(html.includes('<img'), false);
    assert.match(html, /&lt;script&gt;/);
});

test('un link a javascript: non diventa un link: resta il testo scritto', () => {
    const html = renderRichText('[clicca](javascript:alert(1))');
    assert.equal(html.includes('<a '), false);
    assert.equal(html.includes('javascript:alert'), true, 'si deve vedere che c e qualcosa da correggere');
});

test('data: e vbscript: non passano', () => {
    for (const url of ['data:text/html,<script>alert(1)</script>', 'vbscript:msgbox']) {
        const html = renderRichText(`[x](${url})`);
        assert.equal(html.includes('<a '), false, url);
    }
});

test('un indirizzo che eredita lo schema non e un percorso del sito', () => {
    assert.equal(renderRichText('[x](//evil.example)').includes('<a '), false);
});

test('le virgolette nel testo del link non possono chiudere l attributo', () => {
    const html = renderRichText('[et" onmouseover="alert(1)](https://x.it)');
    assert.equal(html.includes('onmouseover="alert'), false);
    assert.match(html, /&quot;/);
});

test('una virgoletta nella URL viene codificata, non chiude l attributo', () => {
    const html = renderRichText('[x](https://x.it/")');
    assert.match(html, /href="https:\/\/x\.it\/%22"/);
});

test('un link esterno ha sempre rel noopener, anche scritto in modi strani', () => {
    // Il caso insidioso e `//host`: comincia per / ma punta fuori.
    for (const url of ['https://evil.example', 'HTTPS://EVIL.EXAMPLE']) {
        assert.match(renderRichText(`[x](${url})`), /rel="noopener noreferrer"/, url);
    }
});

test('la e commerciale in una URL viene scritta come entita', () => {
    const html = renderRichText('[x](https://x.it/a?b=1&c=2)');
    assert.match(html, /href="https:\/\/x\.it\/a\?b=1&amp;c=2"/);
});

test('anche l apertura in grassetto viene scappata', () => {
    assert.match(renderRichText('testo', '<b>nome</b>'), /<strong>&lt;b&gt;nome&lt;\/b&gt;<\/strong>/);
});
