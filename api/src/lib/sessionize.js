/**
 * Importazione di agenda e speaker di un'edizione di Global Azure da Sessionize.
 *
 * Sessionize espone gli stessi dati in due forme, a seconda di come e stato
 * creato l'endpoint nella sezione "API / Embed" dell'evento:
 *
 *  - JSON: `GET /api/v2/{id}/view/All` restituisce sessioni, speaker e sale in
 *    un solo documento. E la forma buona, e si prova per prima.
 *  - EMBED: la stessa URL restituisce uno script che scrive nella pagina un
 *    loader, e l'HTML vero arriva da `view/<Vista>?under=True`. E il caso di
 *    Global Azure Torino 2026 (`dtzcs2li`). Qui si leggono tre viste —
 *    GridSmart (orari, sale, sessioni di servizio), Sessions (descrizioni) e
 *    Speakers (foto, tagline, bio) — e si ricompone lo stesso risultato.
 *
 * Nessuno dei due percorsi scrive niente: il risultato torna all'admin, che lo
 * fonde con le righe esistenti e salva quando vuole.
 *
 * Gli id prodotti sono stabili fra un import e l'altro (sessione = id
 * Sessionize, speaker e tracce = slug del nome): reimportare dopo una modifica
 * su Sessionize aggiorna le righe invece di duplicarle.
 */

import { ImportError, readCapped, decodeEntities } from './event-import.js';

const BASE = 'https://sessionize.com/api/v2';
const TIMEOUT_MS = 10_000;
const MAX_BYTES = 3 * 1024 * 1024;

/** Fuso dell'evento: la vista JSON scrive gli orari come ora locale senza offset. */
const EVENT_TIMEZONE = 'Europe/Rome';

const ID_SAFE = /^[a-z0-9]{4,20}$/;

/* ==========================================================
   DOWNLOAD
   ========================================================== */

async function download(url, { fetchImpl = fetch, embed = false } = {}) {
    let response;
    try {
        response = await fetchImpl(url, {
            method: 'GET',
            headers: embed
                // Senza questo header le viste `under=True` rispondono 404: e
                // la richiesta che fa il loader della embed.
                ? { 'x-requested-with': 'XMLHttpRequest', accept: 'text/html' }
                : { accept: 'application/json' },
            // L'host lo scriviamo noi: un redirect verso altrove non e previsto.
            redirect: 'error',
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new ImportError(504, 'upstream-timeout');
        }
        throw new ImportError(502, 'upstream-unreachable');
    }

    if (response.status === 404) throw new ImportError(404, 'upstream-not-found');
    if (!response.ok) throw new ImportError(502, 'upstream-failed', { status: response.status });

    return readCapped(response, MAX_BYTES);
}

/* ==========================================================
   UTILITA
   ========================================================== */

export function slugify(text, max = 40) {
    return String(text ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, max)
        .replace(/-+$/g, '');
}

/** Un id per il pattern del validatore, unico dentro `taken`. */
function uniqueId(base, taken, fallback) {
    let id = base.length >= 2 ? base : `${fallback}-${base || 'x'}`;
    let candidate = id;
    for (let counter = 2; taken.has(candidate); counter += 1) candidate = `${id.slice(0, 44)}-${counter}`;
    taken.add(candidate);
    return candidate;
}

function sessionIdFor(raw) {
    // Numerico per i talk, UUID per le sessioni di servizio.
    const compact = String(raw).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12);
    return `s-${compact}`;
}

/** Testo leggibile da un frammento HTML: <br> diventa a capo, i tag spariscono. */
function plain(html) {
    if (html === undefined || html === null) return undefined;
    const text = decodeEntities(
        String(html)
            .replace(/<br\s*\/?>/gi, '\n')
            .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
            .replace(/<[^>]+>/g, '')
    )
        .replace(/[ \t]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .trim();
    return text === '' ? undefined : text;
}

const cut = (text, max) => (text && text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

function languageOf(value) {
    const lower = String(value ?? '').toLowerCase();
    if (/ital/.test(lower)) return 'it';
    if (/engl|ingl/.test(lower)) return 'en';
    return undefined;
}

/** Badge dedotti dalla tagline, che su Sessionize e testo libero. */
function badgesFrom(tagline) {
    const badges = [];
    if (/\bMVP\b/i.test(tagline ?? '')) badges.push('Microsoft MVP');
    if (/\bMCT\b|certified trainer/i.test(tagline ?? '')) badges.push('MCT');
    if (/\bRD\b|regional director/i.test(tagline ?? '')) badges.push('Regional Director');
    return badges.length > 0 ? badges : undefined;
}

function linkType(url) {
    let host;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return null;
    }
    if (host.endsWith('linkedin.com')) return 'linkedin';
    if (host === 'x.com' || host.endsWith('.x.com') || host.endsWith('twitter.com')) return 'x';
    if (host.endsWith('github.com')) return 'github';
    if (host.endsWith('bsky.app')) return 'bluesky';
    return 'website';
}

function linksFrom(urls) {
    const links = {};
    for (const url of urls) {
        if (typeof url !== 'string' || !url.startsWith('https://')) continue;
        const type = linkType(url);
        if (type && !links[type]) links[type] = url;
    }
    return Object.keys(links).length > 0 ? links : undefined;
}

/**
 * "Ora locale di Torino" -> ISO UTC. Si chiede a Intl l'offset di quel momento
 * invece di scrivere +02:00 a mano: l'ora legale cambia a fine marzo, proprio
 * a ridosso di Global Azure.
 */
export function localToUtc(local, timeZone = EVENT_TIMEZONE) {
    const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(local ?? '');
    if (!match) return undefined;

    const [, y, mo, d, h, mi, s = '0'] = match;
    const asUtc = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);

    const parts = Object.fromEntries(
        new Intl.DateTimeFormat('en-US', {
            timeZone, hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(new Date(asUtc)).map((part) => [part.type, part.value])
    );
    const zoned = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);

    return new Date(asUtc - (zoned - asUtc)).toISOString();
}

/** Plenaria con un solo speaker = keynote; con tanti = apertura, saluti, tavola rotonda. */
function kindOf({ service, plenum, speakerCount }) {
    if (service) return 'service';
    if (plenum) return speakerCount === 1 ? 'keynote' : 'plenary';
    return 'talk';
}

/* ==========================================================
   FORMA JSON
   ========================================================== */

export function fromJson(data) {
    const trackIds = new Map();
    const takenTracks = new Set();
    const tracks = [...(data.rooms ?? [])]
        .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
        .map((room) => {
            const id = uniqueId(slugify(room.name), takenTracks, 'track');
            trackIds.set(room.id, id);
            return { id, name: cut(String(room.name ?? '').trim(), 60) };
        });

    const speakerIds = new Map();
    const takenSpeakers = new Set();
    const speakers = (data.speakers ?? []).map((speaker) => {
        const name = speaker.fullName ?? `${speaker.firstName ?? ''} ${speaker.lastName ?? ''}`.trim();
        const id = uniqueId(slugify(name), takenSpeakers, 'speaker');
        speakerIds.set(speaker.id, id);
        return compact({
            id,
            name: cut(name, 80),
            tagline: cut(plain(speaker.tagLine), 200),
            bio: cut(plain(speaker.bio), 2000),
            photoUrl: speaker.profilePicture || undefined,
            badges: badgesFrom(speaker.tagLine),
            links: linksFrom((speaker.links ?? []).map((link) => link.url))
        });
    });

    const languageItems = new Map();
    for (const category of data.categories ?? []) {
        if (!/lingua|language/i.test(category.title ?? '')) continue;
        for (const item of category.items ?? []) languageItems.set(item.id, languageOf(item.name));
    }

    const sessions = (data.sessions ?? [])
        .filter((session) => session.startsAt && session.endsAt)
        .map((session) => {
            const ids = (session.speakers ?? [])
                .map((speaker) => speakerIds.get(typeof speaker === 'object' ? speaker.id : speaker))
                .filter(Boolean);
            const kind = kindOf({
                service: session.isServiceSession,
                plenum: session.isPlenumSession,
                speakerCount: ids.length
            });
            const language = (session.categoryItems ?? []).map((item) => languageItems.get(item)).find(Boolean);
            return compact({
                id: sessionIdFor(session.id),
                title: cut(plain(session.title), 200),
                description: cut(plain(session.description), 4000),
                start: localToUtc(session.startsAt),
                end: localToUtc(session.endsAt),
                trackId: kind === 'talk' ? trackIds.get(session.roomId) : undefined,
                speakerIds: ids.length > 0 ? ids : undefined,
                language,
                kind
            });
        });

    return { tracks, speakers, sessions };
}

/* ==========================================================
   FORMA EMBED (HTML)
   ========================================================== */

/** Spezza l'HTML nei blocchi che iniziano con `marker`. */
function blocks(html, marker) {
    const parts = html.split(marker);
    parts.shift();
    return parts;
}

const first = (block, pattern) => pattern.exec(block)?.[1];

export function fromEmbed({ grid, sessions: sessionsHtml, speakers: speakersHtml }) {
    // Sale, nell'ordine delle colonne della griglia.
    const trackIds = new Map();
    const takenTracks = new Set();
    const tracks = [];
    for (const match of grid.matchAll(/sz-cssgrid__track-label sz-room sz-room--(\d+)"[^>]*>([^<]*)</g)) {
        if (trackIds.has(match[1])) continue;
        const name = cut(plain(match[2]), 60);
        const id = uniqueId(slugify(name), takenTracks, 'track');
        trackIds.set(match[1], id);
        tracks.push({ id, name });
    }

    // Speaker: la vista Speakers ha tutto, la griglia solo i nomi.
    const speakerIds = new Map();
    const takenSpeakers = new Set();
    const speakers = [];
    for (const block of blocks(speakersHtml ?? '', '<li id="sz-speaker-')) {
        const uuid = first(block, /^([0-9a-f-]+)"/i);
        const name = plain(first(block, /<h3 class="sz-speaker__name">([\s\S]*?)<\/h3>/));
        if (!uuid || !name) continue;

        const tagline = plain(first(block, /<h4 class="sz-speaker__tagline">([\s\S]*?)<\/h4>/));
        const linksHtml = first(block, /<ul class="sz-speaker__links">([\s\S]*?)<\/ul>/) ?? '';
        const photo = first(block, /<div class="sz-speaker__photo">\s*<img[^>]*src="([^"]+)"/);

        const id = uniqueId(slugify(name), takenSpeakers, 'speaker');
        speakerIds.set(uuid, id);
        speakers.push(compact({
            id,
            name: cut(name, 80),
            tagline: cut(tagline, 200),
            bio: cut(plain(first(block, /<p class="sz-speaker__bio">([\s\S]*?)<\/p>/)), 2000),
            photoUrl: photo ? decodeEntities(photo) : undefined,
            badges: badgesFrom(tagline),
            links: linksFrom([...linksHtml.matchAll(/href="([^"]+)"/g)].map((m) => decodeEntities(m[1])))
        }));
    }

    const descriptions = new Map();
    for (const block of blocks(sessionsHtml ?? '', '<li id="sz-session-')) {
        const id = first(block, /^([^"]+)"/);
        const description = plain(first(block, /<p class="sz-session__description">([\s\S]*?)<\/p>/));
        if (id && description) descriptions.set(id, description);
    }

    const sessions = [];
    const seen = new Set();
    for (const block of blocks(grid, '<div data-sessionid="')) {
        const rawId = first(block, /^([^"]+)"/);
        if (!rawId || seen.has(rawId)) continue;
        seen.add(rawId);

        const classes = first(block, /class="([^"]*)"/) ?? '';
        const times = first(block, /data-sztz="TimeWithDuration\|[^|]*\|([^"]+)"/)?.split('|') ?? [];
        const title = plain(first(block, /<h3 class="sz-session__title">([\s\S]*?)<\/h3>/));
        if (!title || times.length < 2) continue;

        const ids = [...block.matchAll(/data-speakerid="([^"]+)"/g)]
            .map((match) => speakerIds.get(match[1]))
            .filter(Boolean);
        const kind = kindOf({
            service: /sz-session--service/.test(classes),
            plenum: /sz-session--plenum/.test(classes),
            speakerCount: ids.length
        });
        const roomId = first(block, /data-roomid="(\d+)"/);
        const language = languageOf(first(block, /data-categoryname="language"[^>]*>([^<]*)</i));

        sessions.push(compact({
            id: sessionIdFor(rawId),
            title: cut(title, 200),
            description: cut(descriptions.get(rawId), 4000),
            start: new Date(times[0]).toISOString(),
            end: new Date(times[1]).toISOString(),
            trackId: kind === 'talk' ? trackIds.get(roomId) : undefined,
            speakerIds: [...new Set(ids)].length > 0 ? [...new Set(ids)] : undefined,
            language,
            kind
        }));
    }

    return { tracks, speakers, sessions };
}

function compact(item) {
    for (const [key, value] of Object.entries(item)) {
        if (value === undefined) delete item[key];
    }
    return item;
}

/* ==========================================================
   INGRESSO
   ========================================================== */

/**
 * @returns {Promise<{tracks: object[], speakers: object[], sessions: object[], source: object}>}
 */
export async function importSessionize(rawId, { fetchImpl = fetch } = {}) {
    const id = typeof rawId === 'string' ? rawId.trim().toLowerCase() : '';
    if (!ID_SAFE.test(id)) throw new ImportError(400, 'invalid-sessionize-id');

    const all = await download(`${BASE}/${id}/view/All`, { fetchImpl });

    let result;
    let mode;
    const trimmed = all.trimStart();
    if (trimmed.startsWith('{')) {
        let data;
        try {
            data = JSON.parse(trimmed);
        } catch {
            throw new ImportError(502, 'upstream-bad-json');
        }
        result = fromJson(data);
        mode = 'json';
    } else if (/document\.write|sessionize-loader/.test(all)) {
        const view = (name) => download(`${BASE}/${id}/view/${name}?under=True`, { fetchImpl, embed: true });
        const [grid, sessions, speakers] = await Promise.all([
            view('GridSmart'),
            view('Sessions').catch(() => ''),
            view('Speakers').catch(() => '')
        ]);
        result = fromEmbed({ grid, sessions, speakers });
        mode = 'embed';
    } else {
        throw new ImportError(502, 'upstream-unknown-format');
    }

    if (result.sessions.length === 0 && result.speakers.length === 0) {
        throw new ImportError(422, 'nothing-to-import');
    }

    return { ...result, source: { sessionizeId: id, mode, fetchedAt: new Date().toISOString() } };
}
