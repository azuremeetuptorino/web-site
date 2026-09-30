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
export const TIERS = ['diamond', 'platinum', 'gold', 'silver', 'bronze', 'partner'];

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
        // Segue il nome nel titolo della scheda del browser: "Nome | Tagline".
        tagline: text(issues, 'brand.tagline', brand.tagline, { max: 60 }),
        logoUrl: webUrl(issues, 'brand.logoUrl', brand.logoUrl),
        heroImageUrl: webUrl(issues, 'brand.heroImageUrl', brand.heroImageUrl),
        // Descrive la foto a chi non la vede: e testo, non decorazione.
        heroImageAlt: text(issues, 'brand.heroImageAlt', brand.heroImageAlt, { max: 120 })
    };
}

/**
 * I link scritti dentro un testo lungo. Tenuta allineata a INLINE di
 * src/assets/js/rich-text.js.
 */
const RICH_LINK = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;

/**
 * Destinazioni ammesse dentro un testo: le stesse di un campo URL, piu i
 * rimandi a una sezione della pagina, che in un paragrafo hanno senso e in un
 * campo "logo" no.
 */
function isLinkTarget(raw) {
    if (raw.startsWith('#')) return raw.length > 1;
    if (raw.startsWith('//')) return false;
    if (raw.startsWith('/')) return true;

    try {
        return isAllowedOrigin(new URL(raw));
    } catch {
        return false;
    }
}

/**
 * Il rendering pubblico degrada un link non valido a testo semplice: e la rete
 * di sicurezza, non il posto dove accorgersene. Qui si risponde 400 col nome
 * del link, cosi chi scrive lo sistema subito invece di vedere delle parentesi
 * quadre comparire sul sito.
 */
function checkRichLinks(issues, path, value) {
    if (typeof value !== 'string') return;

    for (const match of value.matchAll(RICH_LINK)) {
        if (!isLinkTarget(match[2])) {
            add(issues, path, `il link "${match[1]}" punta a un indirizzo non ammesso: usa https://, un percorso del sito oppure #sezione`);
        }
    }
}

function validateAbout(issues, value) {
    const about = section(value);
    const body = text(issues, 'about.text', about.text, { max: 1200 });

    // Il testo ammette **grassetto** e [link](url): le destinazioni vanno
    // controllate come qualunque altro URL.
    checkRichLinks(issues, 'about.text', body);

    return {
        title: text(issues, 'about.title', about.title, { max: 60 }),
        // L'apertura in grassetto, di solito il nome della community.
        lead: text(issues, 'about.lead', about.lead, { max: 80 }),
        text: body
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

/* ==========================================================
   EVENTI
   ========================================================== */

/**
 * Gli eventi si creano dall'admin, di solito importandoli dal link pubblico di
 * Luma o Meetup, e l'archivio cresce di uno al mese: il tetto e piu alto di
 * quello di team e sponsor.
 */
const MAX_EVENTS = 500;

const EVENT_LIMITS = {
    title: 120,
    excerpt: 300,
    venue: 120,
    timezone: 64
};

/** Fuso di riferimento se non ne arriva uno: la community e a Torino. */
export const DEFAULT_TIMEZONE = 'Europe/Rome';

/**
 * Un istante nel tempo, riscritto in ISO 8601 UTC.
 *
 * Luma e Meetup lo scrivono con l'offset locale (`+02:00`), l'editor lo manda
 * gia in UTC: normalizzare qui fa si che sul blob ci sia sempre la stessa forma
 * e che il confronto inizio/fine non dipenda da come e stato scritto.
 */
function instant(issues, path, value, { required = false } = {}) {
    const raw = text(issues, path, value, { required, max: 40 });
    if (raw === undefined) return undefined;

    const parsed = Date.parse(raw);
    if (Number.isNaN(parsed)) return add(issues, path, 'non e una data valida');

    const year = new Date(parsed).getUTCFullYear();
    if (year < 2000 || year > 2100) return add(issues, path, 'la data deve stare tra il 2000 e il 2100');

    return new Date(parsed).toISOString();
}

/**
 * Un fuso IANA (`Europe/Rome`). Lo si verifica chiedendo a Intl se lo conosce:
 * e lo stesso motore che lo usera poi il browser per scrivere l'orario.
 */
function timezone(issues, path, value) {
    const raw = text(issues, path, value, { max: EVENT_LIMITS.timezone });
    if (raw === undefined) return DEFAULT_TIMEZONE;

    try {
        new Intl.DateTimeFormat('it-IT', { timeZone: raw });
    } catch {
        return add(issues, path, 'fuso orario sconosciuto, per esempio Europe/Rome');
    }
    return raw;
}

function validateVenue(issues, path, value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto con nome, indirizzo e citta');
    }

    const venue = {
        name: text(issues, `${path}.name`, value.name, { max: EVENT_LIMITS.venue }),
        address: text(issues, `${path}.address`, value.address, { max: EVENT_LIMITS.venue }),
        city: text(issues, `${path}.city`, value.city, { max: EVENT_LIMITS.venue })
    };

    for (const [key, entry] of Object.entries(venue)) {
        if (entry === undefined) delete venue[key];
    }
    // Tre campi vuoti nell'editor significano "nessun luogo", non un luogo vuoto.
    return Object.keys(venue).length > 0 ? venue : undefined;
}

function validateEvent(issues, path, value, seenIds) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }

    const id = text(issues, `${path}.id`, value.id, { required: true, max: 49 });
    if (id !== undefined) {
        if (!ID_PATTERN.test(id)) {
            add(issues, `${path}.id`, 'ammessi solo minuscole, cifre e trattini, da 2 a 49 caratteri');
        } else if (seenIds.has(id)) {
            add(issues, `${path}.id`, `gia usato da un altro evento: ${id}`);
        } else {
            seenIds.add(id);
        }
    }

    const dateTime = instant(issues, `${path}.dateTime`, value.dateTime, { required: true });
    const endTime = instant(issues, `${path}.endTime`, value.endTime);
    if (dateTime && endTime && endTime < dateTime) {
        add(issues, `${path}.endTime`, 'deve venire dopo l’inizio');
    }

    const event = {
        id,
        title: text(issues, `${path}.title`, value.title, { required: true, max: EVENT_LIMITS.title }),
        dateTime,
        endTime,
        timezone: timezone(issues, `${path}.timezone`, value.timezone),
        isOnline: flag(issues, `${path}.isOnline`, value.isOnline, false),
        // La pagina dell'evento su Luma o Meetup: e dove ci si iscrive. Senza,
        // la card non e un link, ed e legittimo per un evento passato.
        eventUrl: webUrl(issues, `${path}.eventUrl`, value.eventUrl),
        imageUrl: webUrl(issues, `${path}.imageUrl`, value.imageUrl),
        excerpt: text(issues, `${path}.excerpt`, value.excerpt, { max: EVENT_LIMITS.excerpt }),
        venue: validateVenue(issues, `${path}.venue`, value.venue),
        active: flag(issues, `${path}.active`, value.active)
    };

    for (const [key, entry] of Object.entries(event)) {
        if (entry === undefined) delete event[key];
    }
    return event;
}

/** @returns {{ok: true, value: object} | {ok: false, issues: {path: string, message: string}[]}} */
export function validateEvents(input) {
    return validateCollection(input, {
        key: 'events',
        label: 'eventi',
        max: MAX_EVENTS,
        validateItem: validateEvent
    });
}

/* ==========================================================
   GLOBAL AZURE
   ========================================================== */

/**
 * Due documenti: l'indice delle edizioni (`global-azure.json`) e, per ogni
 * anno, i contenuti di quell'edizione (`global-azure/<anno>.json`). Separati
 * perche le foto di un anno sono centinaia di righe e ogni edizione si modifica
 * per conto suo: con un documento solo, due persone su due anni diversi si
 * darebbero 409 a vicenda.
 */

/** Tenuto allineato a GA_TIERS di src/assets/js/render-global-azure.js. */
export const GA_TIERS = ['organizer', 'diamond', 'platinum', 'gold', 'silver', 'contributor'];

/** `plenary` occupa tutta la riga dell'agenda, `service` e check-in, pranzo, pause. */
export const GA_SESSION_KINDS = ['talk', 'keynote', 'plenary', 'service'];

export const GA_LANGUAGES = ['it', 'en'];

export const GA_SPEAKER_LINKS = ['linkedin', 'website', 'x', 'github', 'bluesky'];

const GA_EDITION_ID = /^20\d{2}$/;
const GA_MAX_EDITIONS = 50;

const GA_MAX = { tracks: 12, speakers: 150, sessions: 150, photos: 400, sponsors: 60 };

const GA_LABELS = {
    tracks: 'tracce',
    speakers: 'speaker',
    sessions: 'sessioni',
    photos: 'foto',
    sponsors: 'sponsor'
};

/** Un anno di edizione e un id valido anche per il pattern generico, ma serve piu stretto. */
export function isEditionYear(value) {
    return typeof value === 'string' && GA_EDITION_ID.test(value);
}

function object(issues, path, value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        add(issues, path, 'deve essere un oggetto');
        return false;
    }
    return true;
}

function itemId(issues, path, value, seenIds, label) {
    const id = text(issues, path, value, { required: true, max: 49 });
    if (id === undefined) return undefined;

    if (!ID_PATTERN.test(id)) {
        return add(issues, path, 'ammessi solo minuscole, cifre e trattini, da 2 a 49 caratteri');
    }
    if (seenIds.has(id)) return add(issues, path, `gia usato da un altro ${label}: ${id}`);

    seenIds.add(id);
    return id;
}

function compact(item) {
    for (const [key, entry] of Object.entries(item)) {
        if (entry === undefined) delete item[key];
    }
    return item;
}

/** Una data di calendario, senza ora: `2026-04-18`. */
function calendarDate(issues, path, value, { required = false } = {}) {
    const raw = text(issues, path, value, { required, max: 10 });
    if (raw === undefined) return undefined;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(raw) || Number.isNaN(Date.parse(`${raw}T00:00:00Z`))) {
        return add(issues, path, 'deve essere una data, per esempio 2026-04-18');
    }
    return raw;
}

function hexColor(issues, path, value) {
    const raw = text(issues, path, value, { max: 7 });
    if (raw === undefined) return undefined;
    if (!/^#[0-9a-fA-F]{6}$/.test(raw)) return add(issues, path, 'deve essere un colore come #0078D4');
    return raw.toUpperCase();
}

/* ----- indice delle edizioni ----- */

function validateEditionStats(issues, path, value) {
    if (value === undefined || value === null) return undefined;
    if (!object(issues, path, value)) return undefined;

    const count = (key) => (value[key] === undefined || value[key] === null || value[key] === ''
        ? undefined
        : integer(issues, `${path}.${key}`, value[key], { max: 100000 }));

    const stats = compact({
        attendees: count('attendees'),
        sessions: count('sessions'),
        speakers: count('speakers'),
        tracks: count('tracks')
    });
    return Object.keys(stats).length > 0 ? stats : undefined;
}

function validateEditionEntry(issues, path, value, seenIds) {
    if (!object(issues, path, value)) return undefined;

    let id = text(issues, `${path}.id`, value.id, { required: true, max: 4 });
    if (id !== undefined) {
        if (!GA_EDITION_ID.test(id)) {
            id = add(issues, `${path}.id`, 'deve essere l’anno dell’edizione, per esempio 2026');
        } else if (seenIds.has(id)) {
            id = add(issues, `${path}.id`, `edizione ${id} gia presente`);
        } else {
            seenIds.add(id);
        }
    }

    const date = calendarDate(issues, `${path}.date`, value.date);
    if (id && date && !date.startsWith(id)) {
        add(issues, `${path}.date`, `la data deve cadere nel ${id}`);
    }

    return compact({
        id,
        year: id ? Number(id) : undefined,
        title: text(issues, `${path}.title`, value.title, { max: 80 }),
        date,
        venue: validateVenue(issues, `${path}.venue`, value.venue),
        tagline: text(issues, `${path}.tagline`, value.tagline, { max: 160 }),
        highlight: text(issues, `${path}.highlight`, value.highlight, { max: 600 }),
        coverUrl: webUrl(issues, `${path}.coverUrl`, value.coverUrl),
        sessionizeId: sessionizeId(issues, `${path}.sessionizeId`, value.sessionizeId),
        registrationUrl: webUrl(issues, `${path}.registrationUrl`, value.registrationUrl),
        stats: validateEditionStats(issues, `${path}.stats`, value.stats),
        current: flag(issues, `${path}.current`, value.current, false),
        published: flag(issues, `${path}.published`, value.published, true)
    });
}

/** L'id di un endpoint Sessionize: 8 caratteri alfanumerici, come `dtzcs2li`. */
function sessionizeId(issues, path, value) {
    const raw = text(issues, path, value, { max: 20 });
    if (raw === undefined) return undefined;
    if (!/^[a-z0-9]{4,20}$/i.test(raw)) return add(issues, path, 'non sembra un id Sessionize, per esempio dtzcs2li');
    return raw.toLowerCase();
}

/** @returns {{ok: true, value: object} | {ok: false, issues: {path: string, message: string}[]}} */
export function validateGlobalAzureIndex(input) {
    const result = validateCollection(input, {
        key: 'editions',
        label: 'edizioni',
        max: GA_MAX_EDITIONS,
        validateItem: validateEditionEntry
    });
    if (!result.ok) return result;

    // Il sito apre sull'edizione "corrente": con due, quale?
    const current = result.value.editions
        .map((edition, index) => (edition.current ? index : -1))
        .filter((index) => index >= 0);
    if (current.length > 1) {
        const index = current[1];
        return {
            ok: false,
            issues: [{ path: `editions[${index}].current`, message: 'solo un’edizione alla volta puo essere quella corrente' }]
        };
    }
    return result;
}

/* ----- contenuti di un'edizione ----- */

function validateTrack(issues, path, value, seenIds) {
    if (!object(issues, path, value)) return undefined;
    return compact({
        id: itemId(issues, `${path}.id`, value.id, seenIds, 'traccia'),
        name: text(issues, `${path}.name`, value.name, { required: true, max: 60 }),
        color: hexColor(issues, `${path}.color`, value.color)
    });
}

function validateSpeakerLinks(issues, path, value) {
    if (value === undefined || value === null) return undefined;
    if (!object(issues, path, value)) return undefined;

    const links = {};
    for (const type of GA_SPEAKER_LINKS) {
        links[type] = webUrl(issues, `${path}.${type}`, value[type]);
    }
    compact(links);
    return Object.keys(links).length > 0 ? links : undefined;
}

function validateBadges(issues, path, value) {
    if (value === undefined || value === null) return undefined;
    if (!Array.isArray(value)) return add(issues, path, 'deve essere una lista');
    if (value.length > 5) return add(issues, path, 'al massimo 5 badge');

    const badges = value
        .map((badge, index) => text(issues, `${path}[${index}]`, badge, { max: 30 }))
        .filter(Boolean);
    return badges.length > 0 ? badges : undefined;
}

function validateGaSpeaker(issues, path, value, seenIds) {
    if (!object(issues, path, value)) return undefined;
    return compact({
        id: itemId(issues, `${path}.id`, value.id, seenIds, 'speaker'),
        name: text(issues, `${path}.name`, value.name, { required: true, max: LIMITS.name }),
        tagline: text(issues, `${path}.tagline`, value.tagline, { max: 200 }),
        company: text(issues, `${path}.company`, value.company, { max: 80 }),
        bio: text(issues, `${path}.bio`, value.bio, { max: 2000 }),
        photoUrl: webUrl(issues, `${path}.photoUrl`, value.photoUrl),
        badges: validateBadges(issues, `${path}.badges`, value.badges),
        links: validateSpeakerLinks(issues, `${path}.links`, value.links)
    });
}

function validateGaSession(issues, path, value, seenIds, refs) {
    if (!object(issues, path, value)) return undefined;

    const start = instant(issues, `${path}.start`, value.start, { required: true });
    const end = instant(issues, `${path}.end`, value.end, { required: true });
    if (start && end && end <= start) add(issues, `${path}.end`, 'deve venire dopo l’inizio');

    const trackId = text(issues, `${path}.trackId`, value.trackId, { max: 49 });
    if (trackId && !refs.tracks.has(trackId)) {
        add(issues, `${path}.trackId`, `traccia inesistente: ${trackId}`);
    }

    let speakerIds;
    if (value.speakerIds !== undefined && value.speakerIds !== null) {
        if (!Array.isArray(value.speakerIds)) {
            add(issues, `${path}.speakerIds`, 'deve essere una lista');
        } else if (value.speakerIds.length > 12) {
            add(issues, `${path}.speakerIds`, 'al massimo 12 speaker per sessione');
        } else {
            speakerIds = [...new Set(value.speakerIds.filter((id) => typeof id === 'string' && id !== ''))];
            const missing = speakerIds.filter((id) => !refs.speakers.has(id));
            if (missing.length > 0) {
                add(issues, `${path}.speakerIds`, `speaker inesistenti: ${missing.join(', ')}`);
            }
            if (speakerIds.length === 0) speakerIds = undefined;
        }
    }

    return compact({
        id: itemId(issues, `${path}.id`, value.id, seenIds, 'sessione'),
        title: text(issues, `${path}.title`, value.title, { required: true, max: 200 }),
        description: text(issues, `${path}.description`, value.description, { max: 4000 }),
        start,
        end,
        trackId,
        speakerIds,
        language: oneOf(issues, `${path}.language`, value.language, GA_LANGUAGES),
        kind: oneOf(issues, `${path}.kind`, value.kind, GA_SESSION_KINDS) ?? 'talk'
    });
}

function validatePhoto(issues, path, value, seenIds) {
    if (!object(issues, path, value)) return undefined;

    const dimension = (key) => (value[key] === undefined || value[key] === null || value[key] === ''
        ? undefined
        : integer(issues, `${path}.${key}`, value[key], { min: 1, max: 20000 }));

    return compact({
        id: itemId(issues, `${path}.id`, value.id, seenIds, 'foto'),
        url: webUrl(issues, `${path}.url`, value.url, { required: true }),
        thumbUrl: webUrl(issues, `${path}.thumbUrl`, value.thumbUrl),
        width: dimension('width'),
        height: dimension('height'),
        caption: text(issues, `${path}.caption`, value.caption, { max: 200 }),
        featured: flag(issues, `${path}.featured`, value.featured, false)
    });
}

function validateGaSponsor(issues, path, value, seenIds) {
    if (!object(issues, path, value)) return undefined;
    return compact({
        id: itemId(issues, `${path}.id`, value.id, seenIds, 'sponsor'),
        name: text(issues, `${path}.name`, value.name, { required: true, max: LIMITS.name }),
        tier: oneOf(issues, `${path}.tier`, value.tier, GA_TIERS, { required: true }),
        logoUrl: webUrl(issues, `${path}.logoUrl`, value.logoUrl, { required: true }),
        websiteUrl: webUrl(issues, `${path}.websiteUrl`, value.websiteUrl)
    });
}

/**
 * I contenuti di un'edizione: cinque liste, tutte facoltative.
 *
 * Le sessioni si validano per ultime perche puntano a tracce e speaker: un
 * riferimento rotto (una traccia cancellata ma ancora usata) e un 400 sul campo
 * della sessione, non un buco silenzioso nell'agenda pubblica.
 */
export function validateGlobalAzureEdition(input) {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, issues: [{ path: '', message: 'il documento deve essere un oggetto' }] };
    }

    for (const key of Object.keys(GA_MAX)) {
        const list = input[key];
        if (list === undefined || list === null) continue;
        if (!Array.isArray(list)) {
            return { ok: false, issues: [{ path: key, message: `deve essere una lista di ${GA_LABELS[key]}` }] };
        }
        if (list.length > GA_MAX[key]) {
            return { ok: false, issues: [{ path: key, message: `troppe righe in ${GA_LABELS[key]}, massimo ${GA_MAX[key]}` }] };
        }
    }

    const issues = [];
    const each = (key, validateItem, extra) => {
        const seenIds = new Set();
        const items = (input[key] ?? []).map((item, index) =>
            validateItem(issues, `${key}[${index}]`, item, seenIds, extra));
        return { items, ids: seenIds };
    };

    const tracks = each('tracks', validateTrack);
    const speakers = each('speakers', validateGaSpeaker);
    const sessions = each('sessions', validateGaSession, { tracks: tracks.ids, speakers: speakers.ids });
    const photos = each('photos', validatePhoto);
    const sponsors = each('sponsors', validateGaSponsor);

    if (issues.length > 0) return { ok: false, issues };

    return {
        ok: true,
        value: {
            version: 1,
            tracks: tracks.items,
            speakers: speakers.items,
            // L'agenda si legge in ordine di orario: ordinarla qui vuol dire che
            // il sito pubblico non deve farlo e l'admin rivede lo stesso ordine.
            sessions: [...sessions.items].sort((a, b) => a.start.localeCompare(b.start)),
            photos: photos.items,
            sponsors: sponsors.items
        }
    };
}
