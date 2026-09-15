/**
 * Helper di costruzione markup.
 *
 * I dati renderizzati qui sono editabili dalla /admin e, dalla P1,
 * arrivano da una sorgente remota: vanno trattati come non fidati.
 * Ogni valore interpolato passa per escapeHtml, ogni URL per safeUrl.
 */

const HTML_ENTITIES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

/** Rende una stringa sicura sia nel testo sia dentro un attributo con doppi apici. */
export function escapeHtml(value) {
    if (value === null || value === undefined) return '';
    return String(value).replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

/**
 * Consente solo http(s) e percorsi relativi allo stesso sito.
 * Blocca javascript:, data: e vbscript:, che da un JSON editabile
 * sarebbero XSS diretto.
 */
export function safeUrl(value, fallback = '#') {
    if (!value) return fallback;
    const raw = String(value).trim();
    if (raw.startsWith('/') && !raw.startsWith('//')) return raw;
    try {
        const parsed = new URL(raw, location.origin);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return parsed.href;
    } catch {
        /* URL malformata: si usa il fallback */
    }
    return fallback;
}

/** true se il link porta fuori dal sito e va aperto in una nuova scheda. */
export function isExternal(url) {
    try {
        return new URL(url, location.origin).origin !== location.origin;
    } catch {
        return false;
    }
}

/**
 * Mostra un messaggio di errore al posto di una sezione che non ha dati,
 * senza lasciare un buco muto nella pagina.
 */
export function renderDataError(container, message, linkUrl, linkLabel) {
    if (!container) return;
    const link = linkUrl
        ? ` <a href="${escapeHtml(safeUrl(linkUrl))}" target="_blank" rel="noopener noreferrer">${escapeHtml(linkLabel)}</a>`
        : '';
    container.innerHTML = `<p class="data-error">${escapeHtml(message)}${link}</p>`;
}
