import { escapeHtml, safeUrl } from './dom.js';

/**
 * Un sottoinsieme minimo di formattazione per i testi lunghi dell'admin.
 *
 *   **grassetto**
 *   [testo del link](https://esempio.it)
 *   riga vuota = paragrafo nuovo
 *
 * PERCHE NON HTML. L'alternativa ovvia era lasciar scrivere HTML nel textarea
 * e stamparlo con innerHTML. Vorrebbe dire rinunciare all'escaping esattamente
 * nel punto in cui il testo e modificabile, e quel testo arriva dal blob: un
 * `<script>` finito li dentro — per una svista, per una sessione admin rubata,
 * per una PUT fatta a mano — diventerebbe codice eseguito su ogni visita.
 * Sanificare l'HTML a valle si puo, ma e un lavoro che va sbagliato una volta
 * sola per aprire un buco (lo si e gia visto con gli SVG).
 *
 * Qui invece la regola resta assoluta: si scappa TUTTO, e poi si reintroduce
 * solo il markup che abbiamo generato noi. Non c'e un percorso per cui del
 * markup dell'utente arrivi intatto nella pagina.
 *
 * Limiti accettati: il testo di un link non diventa grassetto (il contrario
 * si: un link dentro il grassetto funziona, ed e il caso che capita davvero —
 * "**iscriviti su [Meetup](...)**") e niente parentesi tonde dentro le URL.
 */

/** Link oppure grassetto. Tenuta allineata a RICH_LINK di api/src/lib/validate.js. */
const INLINE = /\[([^\]\n]+)\]\(([^)\s]+)\)|\*\*([^*\n]+)\*\*/g;

/** Dentro il grassetto si cercano solo i link: il grassetto c'e gia. */
const LINK_ONLY = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Un rimando dentro la pagina non e un link esterno: niente scheda nuova.
 *
 * `//host` va escluso a mano: comincia per `/` ma NON e un percorso, e una URL
 * che eredita lo schema e punta fuori. Trattandolo come interno usciva un link
 * a un sito altrui senza `rel="noopener noreferrer"`.
 */
const isInternal = (url) => url.startsWith('#') || (url.startsWith('/') && !url.startsWith('//'));

function anchor(raw, label) {
    // Stessa regola del validatore lato server (isLinkTarget): cio che non e
    // https, un percorso del sito o una sezione, non diventa un link.
    if (raw.startsWith('//')) return null;

    // `#eventi` non passa da safeUrl: e un rimando alla pagina stessa, e
    // trasformarlo in URL assoluta lo renderebbe solo piu fragile.
    const url = raw.startsWith('#') ? raw : safeUrl(raw, '');
    if (!url) return null;

    const attributi = isInternal(raw) ? '' : ' target="_blank" rel="noopener noreferrer"';
    return `<a href="${escapeHtml(url)}"${attributi}>${escapeHtml(label)}</a>`;
}

/**
 * Converte un paragrafo. Il testo fuori dai pattern viene scappato, quello
 * dentro viene scappato e poi avvolto nel tag.
 */
function inline(raw, pattern = INLINE) {
    let html = '';
    let last = 0;

    for (const match of raw.matchAll(pattern)) {
        html += escapeHtml(raw.slice(last, match.index));

        if (match[1] !== undefined) {
            // Un link con una destinazione che non ci piace non sparisce e non
            // diventa un link rotto: resta il testo che l'admin ha scritto,
            // parentesi comprese, cosi si vede che c'e qualcosa da sistemare.
            html += anchor(match[2], match[1]) ?? escapeHtml(match[0]);
        } else {
            // Un giro solo, cercando i soli link: niente ricorsione infinita.
            html += `<strong>${inline(match[3], LINK_ONLY)}</strong>`;
        }

        last = match.index + match[0].length;
    }

    return html + escapeHtml(raw.slice(last));
}

/** Divide sui paragrafi, saltando le righe vuote di troppo. */
export function paragraphsOf(text) {
    return String(text ?? '')
        .split(/\n\s*\n/)
        .map((piece) => piece.trim())
        .filter(Boolean);
}

/**
 * @param {string} text
 * @param {string} [lead] apertura in grassetto del primo paragrafo
 * @returns {string} HTML gia scappato, pronto per innerHTML
 */
export function renderRichText(text, lead = '') {
    const paragraphs = paragraphsOf(text);
    const opening = lead.trim() ? `<strong>${escapeHtml(lead.trim())}</strong> ` : '';

    if (paragraphs.length === 0) {
        return opening ? `<p>${opening}</p>` : '';
    }

    return paragraphs
        .map((piece, index) => `<p>${index === 0 ? opening : ''}${inline(piece)}</p>`)
        .join('\n');
}
