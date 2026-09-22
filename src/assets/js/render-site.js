import { escapeHtml, safeUrl } from './dom.js';
import { renderRichText, paragraphsOf } from './rich-text.js';

/**
 * Contenuti fissi della home: foto principale, logo, "Chi siamo", statistiche,
 * footer.
 *
 * LA REGOLA DI QUESTO FILE: quello che non arriva non si tocca.
 *
 * L'HTML contiene gia i testi attuali, e restano li per tre motivi che valgono
 * piu della purezza: la pagina ha senso anche senza JavaScript, i crawler e le
 * anteprime dei link vedono del contenuto vero, e se il blob non risponde il
 * sito non diventa una pagina di scheletri vuoti. Percio qui non si scrive mai
 * una stringa vuota sopra un testo esistente: o c'e un valore nuovo, o si
 * lascia stare.
 *
 * Il rovescio della medaglia, da sapere: cancellare un testo dall'admin non lo
 * fa sparire dal sito, lo riporta a quello scritto nell'HTML.
 */

/** Tipo di canale -> icona e classe del bottone. */
const CHANNELS = {
    telegram: { icon: 'bi-telegram', className: 'btn-telegram' },
    whatsapp: { icon: 'bi-whatsapp', className: 'btn-whatsapp' },
    discord: { icon: 'bi-discord', className: 'btn-generic' },
    slack: { icon: 'bi-slack', className: 'btn-generic' },
    meetup: { icon: 'bi-people-fill', className: 'btn-generic' },
    website: { icon: 'bi-globe', className: 'btn-generic' }
};

/** Tenuto allineato a SOCIAL_TYPES di api/src/lib/validate.js. */
const SOCIAL = {
    linkedin: { icon: 'bi-linkedin', label: 'LinkedIn' },
    youtube: { icon: 'bi-youtube', label: 'YouTube' },
    instagram: { icon: 'bi-instagram', label: 'Instagram' },
    github: { icon: 'bi-github', label: 'GitHub' },
    x: { icon: 'bi-twitter-x', label: 'X' },
    facebook: { icon: 'bi-facebook', label: 'Facebook' },
    mastodon: { icon: 'bi-mastodon', label: 'Mastodon' },
    bluesky: { icon: 'bi-cloud-fill', label: 'Bluesky' }
};

/** `brand.heroImageUrl` -> il valore, o undefined se manca un pezzo del cammino. */
function at(document_, path) {
    return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), document_);
}

const filled = (value) => typeof value === 'string' && value.trim() !== '';

/* ==========================================================
   CAMPI SEMPLICI
   ========================================================== */

/**
 * Ogni elemento con `data-site="percorso"` riceve il suo valore: le immagini
 * nel `src`, tutto il resto come testo.
 */
function applyFields(root, document_) {
    for (const element of root.querySelectorAll('[data-site]')) {
        const value = at(document_, element.dataset.site);
        if (!filled(value)) continue;

        if (element.tagName === 'IMG') {
            const url = safeUrl(value, '');
            if (url) element.setAttribute('src', url);
        } else {
            element.textContent = value;
        }
    }

    for (const element of root.querySelectorAll('[data-site-alt]')) {
        const value = at(document_, element.dataset.siteAlt);
        if (filled(value)) element.setAttribute('alt', value);
    }
}

/* ==========================================================
   TITOLO E FAVICON
   ========================================================== */

/**
 * Il titolo della scheda e l'icona del sito.
 *
 * Il titolo e `nome | tagline`, o il solo nome se la tagline manca. Sono due
 * campi separati perche il nome compare anche nella barra in alto e nel footer,
 * dove un "| Community" appiccicato dietro sarebbe sbagliato.
 *
 * La favicon si sostituisce rimuovendo e reinserendo il <link>, non cambiando
 * l'href sul posto: alcuni browser ignorano la modifica di un href gia
 * applicato e continuano a mostrare la vecchia icona finche non si svuota la
 * cache.
 */
function applyMeta(root, brand, { title = true } = {}) {
    if (!brand) return;

    if (title && filled(brand.name) && typeof root.title === 'string') {
        root.title = filled(brand.tagline) ? `${brand.name} | ${brand.tagline}` : brand.name;
    }

    const icon = root.querySelector('link[rel="icon"]');
    const url = filled(brand.logoUrl) ? safeUrl(brand.logoUrl, '') : '';
    if (!icon || !url || icon.getAttribute('href') === url) return;

    const replacement = icon.cloneNode(true);
    replacement.setAttribute('href', url);
    icon.replaceWith(replacement);
}

/* ==========================================================
   CHI SIAMO
   ========================================================== */

/**
 * Il testo ammette grassetto e link (vedi rich-text.js), utile per esempio a
 * mettere in evidenza l'iscrizione al prossimo evento senza toccare il repo.
 *
 * L'apertura in grassetto resta un campo a parte: e una scelta grafica fissa,
 * il nome della community che apre il paragrafo, non una decorazione che si
 * decide ogni volta.
 */
function applyAbout(root, about) {
    const slot = root.querySelector('[data-site-about]');
    if (!slot || !about) return;

    if (paragraphsOf(about.text).length === 0 && !filled(about.lead)) return;

    slot.innerHTML = renderRichText(about.text ?? '', about.lead ?? '');
}

/* ==========================================================
   LISTE
   ========================================================== */

/**
 * Scrive nel contenitore solo se c'e almeno una voce utilizzabile.
 *
 * Il caso limite conta: una lista con dentro solo voci scartate (URL ostili,
 * tipi sconosciuti) non e "una lista vuota da rispettare", e una lista che non
 * siamo riusciti a usare. Svuotare la sezione sarebbe la reazione peggiore:
 * meglio lasciare in piedi quello che c'era nell'HTML.
 */
function fill(slot, pieces) {
    if (!slot || pieces.length === 0) return;
    slot.innerHTML = pieces.join('\n');
}

function applyStats(root, stats) {
    if (!Array.isArray(stats)) return;

    fill(
        root.querySelector('[data-site-list="stats"]'),
        stats
            .filter((stat) => filled(stat?.value) && filled(stat?.label))
            .map((stat) => `<div class="stat-item">
    <h4>${escapeHtml(stat.value)}</h4>
    <p>${escapeHtml(stat.label)}</p>
</div>`)
    );
}

/**
 * I canali di contatto. Il bottone dell'email non viene dalla lista: e sempre
 * il primo e lo costruisce `footer.email`, cosi l'indirizzo sta scritto in un
 * posto solo invece che in due (bottone e barra da copiare).
 */
function applyChannels(root, footer) {
    const channels = Array.isArray(footer?.channels) ? footer.channels : [];
    if (!filled(footer?.email) && channels.length === 0) return;

    const buttons = [];

    if (filled(footer.email)) {
        const subject = encodeURIComponent('[Azure Meetup Torino] Richiesta Info');
        buttons.push(`<a href="mailto:${escapeHtml(footer.email)}?subject=${subject}" class="channel-btn btn-email">
    <i class="bi bi-envelope-fill"></i> Scrivici una Mail
</a>`);
    }

    for (const channel of channels) {
        const meta = CHANNELS[channel?.type];
        const url = safeUrl(channel?.url, '');
        if (!meta || !url || !filled(channel.label)) continue;

        buttons.push(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="channel-btn ${meta.className}">
    <i class="bi ${meta.icon}"></i> ${escapeHtml(channel.label)}
</a>`);
    }

    fill(root.querySelector('[data-site-list="channels"]'), buttons);
}

function applySocial(root, social) {
    if (!Array.isArray(social)) return;

    fill(
        root.querySelector('[data-site-list="social"]'),
        social
            .map((entry) => {
                const meta = SOCIAL[entry?.type];
                const url = safeUrl(entry?.url, '');
                if (!meta || !url) return '';
                return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(meta.label)}"><i class="bi ${meta.icon}"></i></a>`;
            })
            .filter(Boolean)
    );
}

/* ==========================================================
   INGRESSO
   ========================================================== */

/**
 * `title: false` lascia stare il titolo della scheda: serve alle pagine che ne
 * hanno uno proprio, come /eventi/, dove "Azure Meetup Torino | Community"
 * sarebbe una bugia. La favicon invece si aggiorna ovunque, perche e del sito
 * e non della pagina.
 *
 * @returns {number} 1 se il documento e stato applicato, 0 se non c'era niente
 *   da applicare — la firma che si aspetta `hydrate()` in main.js.
 */
export function renderSite(root, payload, { title = true } = {}) {
    if (!payload || typeof payload !== 'object') return 0;

    applyMeta(root, payload.brand, { title });
    applyFields(root, payload);
    applyAbout(root, payload.about);
    applyStats(root, payload.stats);
    applyChannels(root, payload.footer);
    applySocial(root, payload.footer?.social);

    return 1;
}
