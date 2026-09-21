/**
 * Importazione di un evento dal link della sua pagina pubblica.
 *
 * Gli eventi della community si pubblicano su Luma e su Meetup, e non abbiamo
 * una chiave API per nessuno dei due. Non serve: entrambe le pagine incorporano
 * un blocco JSON-LD `schema.org/Event` con titolo, date, luogo e immagine, che
 * e quello che Google legge per i risultati arricchiti. Lo si legge da li,
 * senza dipendere da un'API privata ne dal markup della pagina.
 *
 * Dove il JSON-LD e tirchio (Meetup tronca la descrizione a 150 caratteri, Luma
 * non scrive il nome della sala), si integra con i dati che il framework della
 * pagina lascia nel `__NEXT_DATA__`. E un'aggiunta opportunistica: se un giorno
 * quel formato cambia, si perde il dettaglio e resta il JSON-LD.
 *
 * DUE DIFESE, perche una function che scarica una URL scelta dall'utente e un
 * classico punto d'ingresso:
 *  - si contattano SOLO gli host di Luma e Meetup, redirect compresi. Senza
 *    questo la function sarebbe un proxy verso qualunque indirizzo, inclusi
 *    quelli interni alla rete di Azure;
 *  - risposta letta al massimo fino a MAX_BYTES e con un timeout: una pagina
 *    lenta o infinita non deve tenere occupata la function.
 *
 * Il risultato NON viene salvato: e la proposta che precompila la scheda
 * nell'editor, e l'admin la corregge e la salva come qualunque altro evento.
 */

import { DEFAULT_TIMEZONE } from './validate.js';

/** Host da cui si accetta di scaricare. Sottodomini compresi. */
export const ALLOWED_HOSTS = ['luma.com', 'lu.ma', 'meetup.com'];

const MAX_BYTES = 3 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;

/** Piattaforme note, riconosciute dall'host. Servono per l'id e per l'etichetta. */
const PLATFORMS = [
    { key: 'luma', hosts: ['luma.com', 'lu.ma'] },
    { key: 'meetup', hosts: ['meetup.com'] }
];

const EXCERPT_MAX = 300;
const TITLE_MAX = 120;
const VENUE_MAX = 120;

/** Errore previsto dell'importazione: ha uno status HTTP e un codice per l'editor. */
export class ImportError extends Error {
    constructor(status, code, extra = {}) {
        super(code);
        this.name = 'ImportError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

/* ==========================================================
   URL DI PARTENZA
   ========================================================== */

function isAllowedHost(hostname) {
    const host = hostname.toLowerCase();
    return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function platformOf(hostname) {
    const host = hostname.toLowerCase();
    return PLATFORMS.find((platform) =>
        platform.hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
    )?.key ?? null;
}

/**
 * Normalizza il link incollato dall'admin.
 *
 * Via query string e frammento: `?eventOrigin=group_events_list` e tracciamento
 * di Meetup, non identifica l'evento, e non deve finire ne nella richiesta ne
 * nella URL salvata.
 */
export function normalizeSourceUrl(raw) {
    if (typeof raw !== 'string' || raw.trim() === '') {
        throw new ImportError(400, 'invalid-url');
    }

    let url;
    try {
        url = new URL(raw.trim());
    } catch {
        throw new ImportError(400, 'invalid-url');
    }

    if (url.protocol !== 'https:') throw new ImportError(400, 'invalid-url');
    if (!isAllowedHost(url.hostname)) {
        throw new ImportError(400, 'host-not-allowed', { allowed: ALLOWED_HOSTS });
    }

    url.search = '';
    url.hash = '';
    url.username = '';
    url.password = '';
    return url;
}

/* ==========================================================
   DOWNLOAD
   ========================================================== */

const REQUEST_HEADERS = {
    // Meetup risponde con una pagina ridotta a chi non sembra un browser.
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    accept: 'text/html,application/xhtml+xml',
    'accept-language': 'it-IT,it;q=0.9,en;q=0.8'
};

async function readCapped(response, maxBytes) {
    if (!response.body) return await response.text();

    const chunks = [];
    let total = 0;
    const reader = response.body.getReader();
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new ImportError(502, 'upstream-too-large', { maxBytes });
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8');
}

/**
 * Scarica la pagina seguendo a mano i redirect, per poter controllare che ogni
 * salto resti sugli host ammessi. `redirect: 'follow'` lo farebbe alla cieca.
 *
 * @returns {Promise<{html: string, finalUrl: URL}>}
 */
export async function fetchPage(url, { fetchImpl = fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
    let current = url;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        let response;
        try {
            response = await fetchImpl(current.toString(), {
                method: 'GET',
                headers: REQUEST_HEADERS,
                redirect: 'manual',
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
                throw new ImportError(504, 'upstream-timeout');
            }
            throw new ImportError(502, 'upstream-unreachable');
        }

        if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location');
            if (!location) throw new ImportError(502, 'upstream-failed', { status: response.status });

            let next;
            try {
                next = new URL(location, current);
            } catch {
                throw new ImportError(502, 'upstream-failed', { status: response.status });
            }
            if (next.protocol !== 'https:' || !isAllowedHost(next.hostname)) {
                throw new ImportError(400, 'host-not-allowed', { allowed: ALLOWED_HOSTS });
            }
            current = next;
            continue;
        }

        if (response.status === 404) throw new ImportError(404, 'upstream-not-found');
        if (!response.ok) throw new ImportError(502, 'upstream-failed', { status: response.status });

        return { html: await readCapped(response, maxBytes), finalUrl: current };
    }

    throw new ImportError(502, 'too-many-redirects');
}

/* ==========================================================
   ESTRAZIONE
   ========================================================== */

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", '#39': "'", nbsp: ' ' };

function decodeEntities(value) {
    return String(value).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+\d*);/gi, (match, entity) => {
        const lower = entity.toLowerCase();
        if (lower.startsWith('#x')) return String.fromCodePoint(parseInt(lower.slice(2), 16));
        if (lower.startsWith('#')) return String.fromCodePoint(parseInt(lower.slice(1), 10));
        return ENTITIES[lower] ?? match;
    });
}

/** Tutti i blocchi JSON-LD della pagina, gia parsati. Quelli rotti si saltano. */
export function extractJsonLd(html) {
    const blocks = [];
    const pattern = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;

    for (const match of html.matchAll(pattern)) {
        try {
            blocks.push(JSON.parse(match[1].trim()));
        } catch {
            /* un blocco malformato non deve far fallire gli altri */
        }
    }
    return blocks;
}

/** Appiattisce liste e `@graph` in una sola sequenza di nodi. */
function* nodes(value) {
    if (Array.isArray(value)) {
        for (const item of value) yield* nodes(item);
    } else if (value && typeof value === 'object') {
        yield value;
        if (value['@graph']) yield* nodes(value['@graph']);
    }
}

function isEventType(type) {
    const types = Array.isArray(type) ? type : [type];
    // Event e i suoi sottotipi: SocialEvent, EducationEvent, BusinessEvent...
    return types.some((entry) => typeof entry === 'string' && /(^|\/)[A-Za-z]*Event$/.test(entry));
}

/** Il primo nodo `Event` fra i blocchi JSON-LD, o null. */
export function findEventNode(blocks) {
    for (const block of blocks) {
        for (const node of nodes(block)) {
            if (isEventType(node['@type'])) return node;
        }
    }
    return null;
}

/** I `<meta>` della pagina come mappa property/name -> content. */
export function extractMeta(html) {
    const meta = new Map();
    for (const tag of html.matchAll(/<meta\b[^>]*>/gi)) {
        const attributes = {};
        for (const attribute of tag[0].matchAll(/([a-zA-Z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) {
            attributes[attribute[1].toLowerCase()] = attribute[2] ?? attribute[3] ?? '';
        }
        const key = attributes.property ?? attributes.name;
        if (key && attributes.content !== undefined && !meta.has(key)) {
            meta.set(key, decodeEntities(attributes.content));
        }
    }
    return meta;
}

/** Il JSON che Next.js lascia nella pagina, o null se non c'e o non si legge. */
export function extractNextData(html) {
    const match = /<script\b[^>]*id\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
    if (!match) return null;
    try {
        return JSON.parse(match[1]);
    } catch {
        return null;
    }
}

/* ==========================================================
   TRADUZIONE NEL NOSTRO SCHEMA
   ========================================================== */

const clip = (value, max) => (value.length > max ? value.slice(0, max).trimEnd() : value);

function cleanText(value) {
    if (typeof value !== 'string') return undefined;
    const cleaned = decodeEntities(value).replace(/\s+/g, ' ').trim();
    return cleaned === '' ? undefined : cleaned;
}

/**
 * Da una descrizione lunga, spesso in markdown, a un estratto di un paio di
 * righe: via grassetti, link e sequenze di escape, taglio all'ultima parola
 * intera prima del limite.
 */
export function excerptFrom(description, max = EXCERPT_MAX) {
    if (typeof description !== 'string') return undefined;

    const plain = decodeEntities(description)
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')   // [testo](url) -> testo
        .replace(/[*_`#>]+/g, '')                  // grassetti, titoli, citazioni
        .replace(/\\([\\|*_[\]()#>~-])/g, '$1')    // escape di markdown
        .replace(/\s+/g, ' ')
        .replace(/^[|\s]+/, '')                   // Meetup apre con un `\|` spurio
        .trim();

    if (plain === '') return undefined;
    if (plain.length <= max) return plain;

    const cut = plain.slice(0, max - 1);
    const lastSpace = cut.lastIndexOf(' ');
    return `${(lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:]+$/, '')}…`;
}

function isoOrUndefined(value) {
    if (typeof value !== 'string') return undefined;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function firstImage(image) {
    if (!image) return undefined;
    if (Array.isArray(image)) return firstImage(image[0]);
    if (typeof image === 'string') return image;
    if (typeof image === 'object') return firstImage(image.url ?? image.contentUrl);
    return undefined;
}

function httpsOrUndefined(value) {
    if (typeof value !== 'string') return undefined;
    try {
        const url = new URL(value.trim());
        return url.protocol === 'https:' ? url.toString() : undefined;
    } catch {
        return undefined;
    }
}

function placeOf(location) {
    const list = Array.isArray(location) ? location : [location];
    return list.find((entry) => entry && typeof entry === 'object' && !isVirtual(entry)) ?? null;
}

const isVirtual = (location) => location?.['@type'] === 'VirtualLocation';

function venueOf(location) {
    const place = placeOf(location);
    if (!place) return undefined;

    const address = typeof place.address === 'string'
        ? { streetAddress: place.address }
        : (place.address ?? {});

    const venue = {
        name: cleanText(place.name),
        address: cleanText(address.streetAddress),
        city: cleanText(address.addressLocality)
    };

    // Meetup e Luma scrivono l'indirizzo anche come nome del luogo: sarebbe due
    // volte la stessa riga sul sito.
    if (venue.name && venue.address && venue.address.startsWith(venue.name)) delete venue.name;

    for (const [key, entry] of Object.entries(venue)) {
        if (entry === undefined || entry === '') delete venue[key];
    }
    return Object.keys(venue).length > 0 ? venue : undefined;
}

function isOnlineOf(node) {
    const mode = String(node.eventAttendanceMode ?? '');
    if (/OnlineEventAttendanceMode$/.test(mode)) return true;
    if (/(Offline|Mixed)EventAttendanceMode$/.test(mode)) return false;

    const locations = Array.isArray(node.location) ? node.location : [node.location];
    return locations.length > 0 && locations.every((entry) => isVirtual(entry));
}

function slugify(value) {
    return String(value)
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

/**
 * Un identificativo stabile ricavato dalla piattaforma: `luma-2ffi3qjx`,
 * `meetup-316647090`. Importare due volte lo stesso link produce lo stesso id,
 * ed e cosi che l'editor riconosce un evento gia presente.
 */
export function suggestId(platform, url, title, dateTime) {
    const segments = url.pathname.split('/').filter(Boolean);

    if (platform === 'meetup') {
        const index = segments.indexOf('events');
        const eventId = index >= 0 ? segments[index + 1] : undefined;
        if (eventId && /^[a-z0-9-]+$/i.test(eventId)) return `meetup-${eventId.toLowerCase()}`.slice(0, 49);
    }
    if (platform === 'luma') {
        const last = segments.at(-1);
        if (last && /^[a-z0-9-]+$/i.test(last)) return `luma-${last.toLowerCase()}`.slice(0, 49);
    }

    const day = dateTime ? dateTime.slice(0, 10) : '';
    return `${day}-${slugify(title ?? 'evento')}`.replace(/^-+/, '').slice(0, 49) || 'evento';
}

/* ---------- integrazioni per piattaforma ---------- */

/** Luma: fuso orario, nome della sala e copertina originale. */
function enrichFromLuma(event, nextData) {
    const data = nextData?.props?.pageProps?.initialData?.data?.event;
    if (!data || typeof data !== 'object') return;

    if (typeof data.timezone === 'string' && data.timezone) event.timezone = data.timezone;

    const description = cleanText(data.geo_address_info?.description);
    if (description) {
        event.venue = { name: clip(description, VENUE_MAX), ...(event.venue ?? {}) };
        if (event.venue.address === description) delete event.venue.address;
    }
    if (typeof data.location_type === 'string') {
        event.isOnline = data.location_type === 'online' || data.location_type === 'zoom';
    }
}

/** Meetup: la descrizione completa e il luogo, che nel JSON-LD sono troncati o sporchi. */
function enrichFromMeetup(event, nextData) {
    const apollo = nextData?.props?.pageProps?.__APOLLO_STATE__;
    if (!apollo || typeof apollo !== 'object') return;

    const node = Object.entries(apollo).find(([key]) => key.startsWith('Event:'))?.[1];
    if (!node || typeof node !== 'object') return;

    const excerpt = excerptFrom(node.description);
    if (excerpt) event.excerpt = excerpt;

    const venueRef = node.venue?.__ref;
    const venue = venueRef ? apollo[venueRef] : null;
    if (venue && typeof venue === 'object') {
        const name = cleanText(venue.name);
        const address = cleanText(venue.address);
        const city = cleanText(venue.city);
        const mapped = {};
        if (name && !(address ?? '').startsWith(name)) mapped.name = clip(name, VENUE_MAX);
        if (address) mapped.address = clip(address, VENUE_MAX);
        if (city) mapped.city = clip(city, VENUE_MAX);
        if (Object.keys(mapped).length > 0) event.venue = mapped;
    }
    if (node.eventType === 'ONLINE') event.isOnline = true;
}

/**
 * Traduce la pagina nel nostro schema evento.
 *
 * @param {string} html    la pagina scaricata
 * @param {URL} sourceUrl  il link normalizzato da cui e stata scaricata
 * @returns {{event: object, platform: string | null}}
 */
export function parseEventPage(html, sourceUrl) {
    const node = findEventNode(extractJsonLd(html));
    if (!node) throw new ImportError(422, 'no-event-found');

    const meta = extractMeta(html);
    const platform = platformOf(sourceUrl.hostname);

    const title = cleanText(node.name) ?? cleanText(meta.get('og:title'));
    const dateTime = isoOrUndefined(node.startDate);
    const canonical = httpsOrUndefined(typeof node.url === 'string' ? node.url : undefined);

    const event = {
        id: suggestId(platform, sourceUrl, title, dateTime),
        title: title ? clip(title, TITLE_MAX) : undefined,
        dateTime,
        endTime: isoOrUndefined(node.endDate),
        timezone: DEFAULT_TIMEZONE,
        isOnline: isOnlineOf(node),
        // La URL canonica del JSON-LD se resta sulla piattaforma, altrimenti il
        // link incollato, gia ripulito dalla query string.
        eventUrl: canonical && isAllowedHost(new URL(canonical).hostname) ? canonical : sourceUrl.toString(),
        // og:image e l'immagine pensata per le anteprime: ha gia il taglio
        // giusto per una card. Il JSON-LD ne ha di piu grandi, ma a volte quadrate.
        imageUrl: httpsOrUndefined(meta.get('og:image')) ?? httpsOrUndefined(firstImage(node.image)),
        excerpt: excerptFrom(node.description) ?? excerptFrom(meta.get('og:description')),
        venue: venueOf(node.location),
        active: true
    };

    const nextData = extractNextData(html);
    if (platform === 'luma') enrichFromLuma(event, nextData);
    if (platform === 'meetup') enrichFromMeetup(event, nextData);

    for (const [key, entry] of Object.entries(event)) {
        if (entry === undefined) delete event[key];
    }
    return { event, platform };
}

/**
 * Il giro completo: link -> pagina -> evento.
 *
 * @returns {Promise<{event: object, source: {url: string, platform: string | null, fetchedAt: string}}>}
 */
export async function importEvent(rawUrl, options = {}) {
    const sourceUrl = normalizeSourceUrl(rawUrl);
    const { html, finalUrl } = await fetchPage(sourceUrl, options);
    const { event, platform } = parseEventPage(html, finalUrl);

    return {
        event,
        source: { url: finalUrl.toString(), platform, fetchedAt: new Date().toISOString() }
    };
}
