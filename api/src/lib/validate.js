/**
 * Validazione dei documenti che l'admin salva.
 *
 * Scritta a mano di proposito: `ajv` sarebbe una dipendenza e un costo di cold
 * start (le managed functions sono su Consumption) per tre tipi di oggetto.
 *
 * Due cose che il validatore fa oltre a dire si o no:
 *  - RACCOGLIE TUTTI GLI ERRORI, non si ferma al primo. L'editor dell'admin li
 *    mostra tutti insieme accanto al campo giusto: correggerne uno per volta,
 *    con un salvataggio di rete in mezzo, sarebbe sfiancante.
 *  - RESTITUISCE UN VALORE RIPULITO. Si scrive sul blob quello che torna di qui,
 *    mai il body del client: campi sconosciuti scartati, stringhe trimmate,
 *    default applicati. Cosi il documento sul blob resta prevedibile per il
 *    rendering del sito pubblico, che non valida niente.
 */

/** Governa raggruppamento e ordinamento sul sito, `role` e solo l'etichetta. */
export const ROLE_KEYS = ['co-founder', 'organizer', 'core-team', 'speaker', 'staff'];

/** Tenuto allineato a LINK_TYPES di src/assets/js/render-team.js: la aggiunge qui e la mappa li. */
export const LINK_TYPES = [
    'linkedin', 'github', 'x', 'blog', 'website',
    'instagram', 'youtube', 'mastodon', 'bluesky'
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const MAX_ITEMS = 200;

const LIMITS = {
    name: 80,
    nick: 40,
    role: 60,
    bio: 240,
    description: 200,
    url: 2048
};

/* ==========================================================
   PRIMITIVE
   ========================================================== */

function add(issues, path, message) {
    issues.push({ path, message });
    return undefined;
}

function text(issues, path, value, { required = false, max = 200 } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? add(issues, path, 'obbligatorio') : undefined;
    }
    if (typeof value !== 'string') return add(issues, path, 'deve essere testo');

    const trimmed = value.trim();
    if (required && trimmed === '') return add(issues, path, 'obbligatorio');
    if (trimmed.length > max) return add(issues, path, `troppo lungo, massimo ${max} caratteri`);

    return trimmed === '' ? undefined : trimmed;
}

function oneOf(issues, path, value, allowed, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? add(issues, path, 'obbligatorio') : undefined;
    }
    if (!allowed.includes(value)) {
        return add(issues, path, `valore non ammesso, usa uno tra: ${allowed.join(', ')}`);
    }
    return value;
}

/**
 * Solo https, con due eccezioni.
 *
 * `/percorso` serve ai file che il sito serve gia da se (i loghi segnaposto
 * stanno in `src/assets/img/sponsors/`). `//host` invece NON e un percorso: e
 * una URL che eredita lo schema, e va rifiutata come qualunque host esterno
 * scritto male.
 *
 * `http://localhost` serve allo sviluppo: con Azurite i file caricati stanno su
 * http://127.0.0.1:10000, e senza questo scarto l'editor rifiuterebbe in locale
 * esattamente i dati che in produzione sono validi.
 */
function isAllowedOrigin(url) {
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function webUrl(issues, path, value, { required = false } = {}) {
    const raw = text(issues, path, value, { required, max: LIMITS.url });
    if (raw === undefined) return undefined;

    if (raw.startsWith('/')) {
        return raw.startsWith('//')
            ? add(issues, path, 'non e un indirizzo valido')
            : raw;
    }

    let url;
    try {
        url = new URL(raw);
    } catch {
        return add(issues, path, 'non e un indirizzo valido');
    }
    if (!isAllowedOrigin(url)) return add(issues, path, 'deve iniziare con https:// oppure con /');

    return url.toString();
}

function integer(issues, path, value, { fallback = 0, min = 0, max = 100000 } = {}) {
    if (value === undefined || value === null || value === '') return fallback;

    const number = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
        return add(issues, path, 'deve essere un numero');
    }
    if (!Number.isInteger(number)) return add(issues, path, 'deve essere un numero intero');
    if (number < min || number > max) return add(issues, path, `deve stare tra ${min} e ${max}`);

    return number;
}

function flag(issues, path, value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') return add(issues, path, 'deve essere vero o falso');
    return value;
}

/* ==========================================================
   TEAM
   ========================================================== */

function validateLink(issues, path, value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto con tipo e indirizzo');
    }

    // Una riga lasciata completamente vuota nell'editor non e un errore:
    // significa "questo membro non ha un link".
    const empty = !value.type && !value.url;
    if (empty) return undefined;

    const type = oneOf(issues, `${path}.type`, value.type, LINK_TYPES, { required: true });
    const url = webUrl(issues, `${path}.url`, value.url, { required: true });

    return type && url ? { type, url } : undefined;
}

function validateMember(issues, path, value, seenIds) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }

    const id = text(issues, `${path}.id`, value.id, { required: true, max: 49 });
    if (id !== undefined) {
        if (!ID_PATTERN.test(id)) {
            add(issues, `${path}.id`, 'ammessi solo minuscole, cifre e trattini, da 2 a 49 caratteri');
        } else if (seenIds.has(id)) {
            add(issues, `${path}.id`, `gia usato da un altro membro: ${id}`);
        } else {
            seenIds.add(id);
        }
    }

    const member = {
        id,
        name: text(issues, `${path}.name`, value.name, { required: true, max: LIMITS.name }),
        nick: text(issues, `${path}.nick`, value.nick, { max: LIMITS.nick }),
        role: text(issues, `${path}.role`, value.role, { max: LIMITS.role }),
        roleKey: oneOf(issues, `${path}.roleKey`, value.roleKey, ROLE_KEYS, { required: true }),
        bio: text(issues, `${path}.bio`, value.bio, { max: LIMITS.bio }),
        avatarUrl: webUrl(issues, `${path}.avatarUrl`, value.avatarUrl),
        link: validateLink(issues, `${path}.link`, value.link),
        order: integer(issues, `${path}.order`, value.order),
        active: flag(issues, `${path}.active`, value.active)
    };

    // I campi opzionali assenti si omettono invece di scriverli `undefined`:
    // JSON.stringify li toglierebbe comunque, ma cosi il confronto fra la copia
    // locale e quella del server nell'editor non inciampa su chiavi fantasma.
    for (const [key, entry] of Object.entries(member)) {
        if (entry === undefined) delete member[key];
    }
    return member;
}

/* ==========================================================
   SPONSOR
   ========================================================== */

/**
 * Il tier e l'unico dato che governa dimensione del logo, raggruppamento e
 * ordine delle fasce. E una scelta precisa: aggiungere uno sponsor non deve
 * mai voler dire toccare il CSS.
 *
 * Tenuto allineato a TIER_WEIGHT di src/assets/js/render-sponsors.js.
 */
export const TIERS = ['gold', 'silver', 'bronze', 'partner', 'venue', 'media'];

/** `since` e l'anno da cui ci sostengono, non una data: basta l'anno. */
function year(issues, path, value) {
    const raw = text(issues, path, value, { max: 4 });
    if (raw === undefined) return undefined;

    if (!/^\d{4}$/.test(raw) || Number(raw) < 2000 || Number(raw) > 2100) {
        return add(issues, path, 'deve essere un anno, per esempio 2025');
    }
    return raw;
}

function validateSponsor(issues, path, value, seenIds) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }

    const id = text(issues, `${path}.id`, value.id, { required: true, max: 49 });
    if (id !== undefined) {
        if (!ID_PATTERN.test(id)) {
            add(issues, `${path}.id`, 'ammessi solo minuscole, cifre e trattini, da 2 a 49 caratteri');
        } else if (seenIds.has(id)) {
            add(issues, `${path}.id`, `gia usato da un altro sponsor: ${id}`);
        } else {
            seenIds.add(id);
        }
    }

    const sponsor = {
        id,
        name: text(issues, `${path}.name`, value.name, { required: true, max: LIMITS.name }),
        tier: oneOf(issues, `${path}.tier`, value.tier, TIERS, { required: true }),
        // Il logo e obbligatorio: senza, la card sarebbe un rettangolo vuoto.
        logoUrl: webUrl(issues, `${path}.logoUrl`, value.logoUrl, { required: true }),
        // Serve solo ai loghi che spariscono su fondo scuro.
        logoDarkUrl: webUrl(issues, `${path}.logoDarkUrl`, value.logoDarkUrl),
        // Senza sito la card non e un link, ed e un caso legittimo.
        websiteUrl: webUrl(issues, `${path}.websiteUrl`, value.websiteUrl),
        description: text(issues, `${path}.description`, value.description, { max: LIMITS.description }),
        since: year(issues, `${path}.since`, value.since),
        order: integer(issues, `${path}.order`, value.order),
        active: flag(issues, `${path}.active`, value.active)
    };

    for (const [key, entry] of Object.entries(sponsor)) {
        if (entry === undefined) delete sponsor[key];
    }
    return sponsor;
}

/* ==========================================================
   CONTENUTI DI PAGINA
   ========================================================== */

/** Canali di contatto in evidenza. L'email non sta qui: viene da footer.email. */
export const CHANNEL_TYPES = ['telegram', 'whatsapp', 'discord', 'slack', 'meetup', 'website'];

/** Profili social nella riga di icone del footer. */
export const SOCIAL_TYPES = [
    'linkedin', 'youtube', 'instagram', 'github',
    'x', 'facebook', 'mastodon', 'bluesky'
];

const MAX_STATS = 6;
const MAX_LINKS = 8;

/**
 * Un oggetto annidato mancante non e un errore: vuol dire "lascia il testo che
 * c'e gia nell'HTML". Il rendering pubblico tratta ogni campo come facoltativo
 * e non tocca quello che non riceve.
 */
function section(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {};
}

function validateBrand(issues, value) {
    const brand = section(value);
    return {
        name: text(issues, 'brand.name', brand.name, { max: LIMITS.name }),
        logoUrl: webUrl(issues, 'brand.logoUrl', brand.logoUrl),
        heroImageUrl: webUrl(issues, 'brand.heroImageUrl', brand.heroImageUrl),
        // Descrive la foto a chi non la vede: e testo, non decorazione.
        heroImageAlt: text(issues, 'brand.heroImageAlt', brand.heroImageAlt, { max: 120 })
    };
}

function validateAbout(issues, value) {
    const about = section(value);
    return {
        title: text(issues, 'about.title', about.title, { max: 60 }),
        // L'apertura in grassetto, di solito il nome della community.
        lead: text(issues, 'about.lead', about.lead, { max: 80 }),
        text: text(issues, 'about.text', about.text, { max: 1200 })
    };
}

function validateStat(issues, path, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }
    return {
        // Il numero resta testo: "1.2k+" e "30+" non sono numeri, sono etichette.
        value: text(issues, `${path}.value`, value.value, { required: true, max: 12 }),
        label: text(issues, `${path}.label`, value.label, { required: true, max: 40 })
    };
}

function validateChannel(issues, path, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }
    return {
        type: oneOf(issues, `${path}.type`, value.type, CHANNEL_TYPES, { required: true }),
        label: text(issues, `${path}.label`, value.label, { required: true, max: 40 }),
        url: webUrl(issues, `${path}.url`, value.url, { required: true })
    };
}

function validateSocial(issues, path, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }
    return {
        type: oneOf(issues, `${path}.type`, value.type, SOCIAL_TYPES, { required: true }),
        url: webUrl(issues, `${path}.url`, value.url, { required: true })
    };
}

/** Un indirizzo email: senza, il footer non mostra il bottone ne la barra da copiare. */
function email(issues, path, value) {
    const raw = text(issues, path, value, { max: 120 });
    if (raw === undefined) return undefined;
    // Volutamente permissiva: la vera verifica di un'email e mandarci un
    // messaggio, e una regex severa qui rifiuterebbe indirizzi legittimi.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) {
        return add(issues, path, 'non sembra un indirizzo email');
    }
    return raw;
}

function validateFooter(issues, value) {
    const footer = section(value);

    const list = (key, max, validateItem) => {
        const input = footer[key];
        if (input === undefined || input === null) return undefined;
        if (!Array.isArray(input)) return add(issues, `footer.${key}`, 'deve essere una lista');
        if (input.length > max) return add(issues, `footer.${key}`, `troppi elementi, massimo ${max}`);
        return input.map((item, index) => validateItem(issues, `footer.${key}[${index}]`, item));
    };

    return {
        intro: text(issues, 'footer.intro', footer.intro, { max: 200 }),
        email: email(issues, 'footer.email', footer.email),
        legal: text(issues, 'footer.legal', footer.legal, { max: 300 }),
        channels: list('channels', MAX_LINKS, validateChannel),
        social: list('social', MAX_LINKS, validateSocial)
    };
}

/**
 * Valida i contenuti fissi della home: foto, "Chi siamo", statistiche, footer.
 *
 * A differenza di team e sponsor qui non c'e una lista sola ma una manciata di
 * sezioni, e sono TUTTE facoltative. Il motivo sta nel rendering: l'HTML tiene
 * i testi attuali come fallback e il JavaScript sovrascrive solo quello che
 * riceve. Un campo vuoto non svuota la pagina, la lascia com'e.
 */
export function validateSite(input) {
    const issues = [];

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, issues: [{ path: '', message: 'il documento deve essere un oggetto' }] };
    }
    if (input.stats !== undefined && input.stats !== null && !Array.isArray(input.stats)) {
        return { ok: false, issues: [{ path: 'stats', message: 'deve essere una lista' }] };
    }
    if (Array.isArray(input.stats) && input.stats.length > MAX_STATS) {
        return { ok: false, issues: [{ path: 'stats', message: `troppe statistiche, massimo ${MAX_STATS}` }] };
    }

    const value = {
        version: 1,
        brand: validateBrand(issues, input.brand),
        about: validateAbout(issues, input.about),
        stats: Array.isArray(input.stats)
            ? input.stats.map((stat, index) => validateStat(issues, `stats[${index}]`, stat))
            : undefined,
        footer: validateFooter(issues, input.footer)
    };

    if (issues.length > 0) return { ok: false, issues };

    return { ok: true, value: prune(value) };
}

/**
 * Toglie i campi vuoti, ricorsivamente.
 *
 * Senza, sul blob finirebbe un documento pieno di `undefined` scomparsi e di
 * oggetti vuoti, e il rendering non saprebbe distinguere "non impostato" da
 * "impostato a niente".
 */
function prune(value) {
    if (Array.isArray(value)) return value;
    if (typeof value !== 'object' || value === null) return value;

    const output = {};
    for (const [key, entry] of Object.entries(value)) {
        if (entry === undefined) continue;
        const cleaned = prune(entry);
        if (cleaned && typeof cleaned === 'object' && !Array.isArray(cleaned) && Object.keys(cleaned).length === 0) {
            continue;
        }
        output[key] = cleaned;
    }
    return output;
}

/* ==========================================================
   DOCUMENTI
   ========================================================== */

/**
 * Scheletro comune ai due documenti: un oggetto con una lista dentro.
 *
 * `updatedAt` e `updatedBy` non si leggono dall'input: li mette il server, sono
 * traccia di chi ha salvato e non un campo modificabile dal client. Anche
 * `version` viene riscritta: e il formato del documento, non un dato.
 */
function validateCollection(input, { key, label, max, validateItem }) {
    const issues = [];

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, issues: [{ path: '', message: 'il documento deve essere un oggetto' }] };
    }
    if (!Array.isArray(input[key])) {
        return { ok: false, issues: [{ path: key, message: `deve essere una lista di ${label}` }] };
    }
    // Il limite scatta prima di validare: una lista assurda non deve costare
    // tempo di CPU proporzionale a quanto e assurda.
    if (input[key].length > max) {
        return { ok: false, issues: [{ path: key, message: `troppi ${label}, massimo ${max}` }] };
    }

    const seenIds = new Set();
    const items = input[key].map((item, index) =>
        validateItem(issues, `${key}[${index}]`, item, seenIds)
    );

    if (issues.length > 0) return { ok: false, issues };

    return { ok: true, value: { version: 1, [key]: items } };
}

/**
 * @returns {{ok: true, value: object} | {ok: false, issues: {path: string, message: string}[]}}
 */
export function validateTeam(input) {
    return validateCollection(input, {
        key: 'members',
        label: 'membri',
        max: MAX_ITEMS,
        validateItem: validateMember
    });
}

/** @returns {{ok: true, value: object} | {ok: false, issues: {path: string, message: string}[]}} */
export function validateSponsors(input) {
    return validateCollection(input, {
        key: 'sponsors',
        label: 'sponsor',
        max: MAX_ITEMS,
        validateItem: validateSponsor
    });
}
