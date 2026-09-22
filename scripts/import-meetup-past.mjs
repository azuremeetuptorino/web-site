/**
 * Riempie l'archivio con tutti gli eventi passati del gruppo Meetup.
 *
 * E una cosa da fare una volta sola: il sito nasce nel 2026, il gruppo esiste
 * dal 2018, e i 27 incontri in mezzo non sono da nessuna parte. Da qui in avanti
 * gli eventi entrano uno alla volta con l'importazione da link della /admin.
 *
 * PERCHE UNO SCRIPT E NON UN PULSANTE NELL'ADMIN. L'importazione da link legge
 * il JSON-LD `schema.org/Event`, che e un formato pubblico e stabile (vedi
 * api/src/lib/event-import.js). L'elenco degli eventi passati no: quello lo da
 * solo `www.meetup.com/gql2`, l'endpoint GraphQL interno del sito. Risponde
 * senza autenticazione, ma non e documentato e non promette niente a nessuno.
 * Dipenderci dentro una function significherebbe che il giorno che Meetup lo
 * cambia si rompe la /admin; dipenderci qui significa che si rompe uno script
 * che ha gia fatto il suo lavoro, e i dati sono al sicuro sul blob.
 *
 * COSA FA, nell'ordine: scarica tutti gli eventi passati; li traduce nel nostro
 * schema con le stesse funzioni che usa l'importazione da link, cosi gli id
 * coincidono e reimportare un evento dall'admin lo riconosce invece di
 * duplicarlo; li unisce al documento che c'e gia; valida; scrive il master
 * privato e ripubblica quello pubblico.
 *
 * E rilanciabile: gli eventi gia presenti non vengono toccati, perche potrebbero
 * essere stati corretti a mano dall'admin. `--force-update` li riscrive.
 *
 * Uso:
 *   node scripts/import-meetup-past.mjs --dry-run      # non scrive, dice cosa farebbe
 *   DATA_STORAGE_CONNECTION="..." node scripts/import-meetup-past.mjs
 *   node scripts/import-meetup-past.mjs --force-update
 *   node scripts/import-meetup-past.mjs --group altro-gruppo
 */

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

/** Le impostazioni locali delle function sono la fonte di verita in sviluppo. */
async function connectionFromLocalSettings() {
    try {
        const raw = await readFile(join(root, 'api', 'local.settings.json'), 'utf8');
        return JSON.parse(raw)?.Values?.DATA_STORAGE_CONNECTION ?? null;
    } catch {
        return null;
    }
}

process.env.DATA_STORAGE_CONNECTION =
    process.env.DATA_STORAGE_CONNECTION ||
    (await connectionFromLocalSettings()) ||
    'UseDevelopmentStorage=true';

const { readPrivate, writePrivate, publishPublic, PRIVATE_CONTAINER, PUBLIC_CONTAINER } =
    await import('../api/src/lib/blob.js');
const { excerptFrom, suggestId, normalizeSourceUrl } =
    await import('../api/src/lib/event-import.js');
const { validateEvents, DEFAULT_TIMEZONE } = await import('../api/src/lib/validate.js');

/* ==========================================================
   ARGOMENTI
   ========================================================== */

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (flag, fallback) => {
    const index = argv.indexOf(flag);
    return index >= 0 && argv[index + 1] ? argv[index + 1] : fallback;
};

const dryRun = has('--dry-run');
const forceUpdate = has('--force-update');
const group = value('--group', 'meetup-microsoft-azure-torino');

const BLOB_NAME = 'events.json';
/** Gli eventi inventati come segnaposto, da togliere appena ci sono quelli veri. */
const PLACEHOLDER_PREFIX = 'seed-';

/* ==========================================================
   MEETUP
   ========================================================== */

const GQL_ENDPOINT = 'https://www.meetup.com/gql2';
const PAGE_SIZE = 20;
const TIMEOUT_MS = 20_000;

/**
 * Chiediamo solo i campi che finiscono nella scheda. `description` arriva in
 * markdown e la riduciamo a un estratto; `standardUrl` e la copertina a 600px,
 * che e la larghezza della card: `highResUrl` sarebbe tre volte il peso per
 * niente.
 */
const QUERY = `query PastEvents($urlname: String!, $first: Int!, $after: String) {
  groupByUrlname(urlname: $urlname) {
    events(filter: { status: [PAST] }, first: $first, after: $after, sort: DESC) {
      totalCount
      pageInfo { endCursor hasNextPage }
      edges { node {
        id
        title
        eventUrl
        description
        dateTime
        endTime
        isOnline
        eventType
        venue { name address city }
        featuredEventPhoto { standardUrl }
      } }
    }
  }
}`;

const HEADERS = {
    // Meetup risponde con una pagina ridotta a chi non sembra un browser.
    'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36',
    'content-type': 'application/json',
    accept: 'application/json',
    'accept-language': 'it-IT,it;q=0.9,en;q=0.8',
    origin: 'https://www.meetup.com',
    referer: `https://www.meetup.com/${group}/events/?type=past`
};

async function fetchPage(after) {
    let response;
    try {
        response = await fetch(GQL_ENDPOINT, {
            method: 'POST',
            headers: HEADERS,
            body: JSON.stringify({ query: QUERY, variables: { urlname: group, first: PAGE_SIZE, after } }),
            signal: AbortSignal.timeout(TIMEOUT_MS)
        });
    } catch (error) {
        throw new Error(`Meetup non raggiungibile: ${error.message}`);
    }

    if (!response.ok) throw new Error(`Meetup ha risposto ${response.status}`);

    const payload = await response.json();
    if (payload.errors) {
        throw new Error(`GraphQL: ${payload.errors.map((e) => e.message).join('; ')}`);
    }

    const connection = payload?.data?.groupByUrlname?.events;
    if (!connection) throw new Error(`Gruppo "${group}" non trovato, o la forma della risposta e cambiata.`);
    return connection;
}

/** Tutti gli eventi passati, seguendo il cursore fino in fondo. */
async function fetchAllPastEvents() {
    const nodes = [];
    let after = null;
    let declared = null;

    do {
        const connection = await fetchPage(after);
        declared ??= connection.totalCount;
        nodes.push(...connection.edges.map((edge) => edge.node));
        after = connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
    } while (after);

    if (declared !== null && nodes.length !== declared) {
        console.warn(`  attenzione: Meetup ne dichiara ${declared}, ne sono arrivati ${nodes.length}`);
    }
    return nodes;
}

/* ==========================================================
   TRADUZIONE NEL NOSTRO SCHEMA
   ========================================================== */

const VENUE_MAX = 120;
const clip = (text, max) => (text.length > max ? text.slice(0, max).trimEnd() : text);

function cleanText(input) {
    if (typeof input !== 'string') return undefined;
    const cleaned = input.replace(/\s+/g, ' ').trim();
    return cleaned === '' ? undefined : cleaned;
}

/**
 * Stesse regole di `enrichFromMeetup`: il nome del luogo si butta se l'indirizzo
 * lo ripete, altrimenti sulla card comparirebbe due volte la stessa riga.
 */
function venueOf(venue) {
    if (!venue || typeof venue !== 'object') return undefined;

    const name = cleanText(venue.name);
    const address = cleanText(venue.address);
    const city = cleanText(venue.city);

    const mapped = {};
    if (name && !(address ?? '').startsWith(name)) mapped.name = clip(name, VENUE_MAX);
    if (address) mapped.address = clip(address, VENUE_MAX);
    if (city) mapped.city = clip(city, VENUE_MAX);

    return Object.keys(mapped).length > 0 ? mapped : undefined;
}

/**
 * Meetup scrive "Online event" come nome del luogo degli eventi a distanza:
 * sulla card e rumore, il pallino "online" lo dice gia.
 */
function isPlaceholderVenue(venue) {
    return venue?.name !== undefined
        && venue.address === undefined
        && venue.city === undefined
        && /^online event$/i.test(venue.name);
}

function toIso(input) {
    if (typeof input !== 'string') return undefined;
    const parsed = Date.parse(input);
    return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
}

function toEvent(node) {
    // Passa dal normalizzatore dell'importazione da link: stessa ripulitura
    // della query string e stesso controllo sull'host.
    let url;
    try {
        url = normalizeSourceUrl(node.eventUrl);
    } catch {
        return null;
    }

    const dateTime = toIso(node.dateTime);
    if (!dateTime || !cleanText(node.title)) return null;

    let venue = venueOf(node.venue);
    if (isPlaceholderVenue(venue)) venue = undefined;

    const event = {
        id: suggestId('meetup', url, node.title, dateTime),
        title: cleanText(node.title),
        dateTime,
        endTime: toIso(node.endTime),
        timezone: DEFAULT_TIMEZONE,
        isOnline: node.isOnline === true || node.eventType === 'ONLINE',
        eventUrl: url.toString(),
        imageUrl: node.featuredEventPhoto?.standardUrl,
        excerpt: excerptFrom(node.description),
        venue,
        active: true
    };

    for (const [key, entry] of Object.entries(event)) {
        if (entry === undefined) delete event[key];
    }
    return event;
}

/* ==========================================================
   UNIONE
   ========================================================== */

const byDateDesc = (a, b) => String(b.dateTime).localeCompare(String(a.dateTime));

/**
 * Unisce gli eventi scaricati a quelli che ci sono gia.
 *
 * Un evento gia presente NON si sovrascrive: potrebbe essere stato corretto a
 * mano dall'admin, e un reimport non deve cancellare quel lavoro. I segnaposto
 * inventati invece se ne vanno: esistevano solo per non mostrare un archivio
 * vuoto.
 */
function merge(existing, imported) {
    const removed = existing.filter((event) => String(event.id).startsWith(PLACEHOLDER_PREFIX));
    const kept = existing.filter((event) => !String(event.id).startsWith(PLACEHOLDER_PREFIX));
    const byId = new Map(kept.map((event) => [event.id, event]));

    const added = [];
    const updated = [];
    const untouched = [];

    for (const event of imported) {
        if (!byId.has(event.id)) {
            byId.set(event.id, event);
            added.push(event);
        } else if (forceUpdate) {
            byId.set(event.id, { ...byId.get(event.id), ...event });
            updated.push(event);
        } else {
            untouched.push(event);
        }
    }

    return { events: [...byId.values()].sort(byDateDesc), added, updated, untouched, removed };
}

/* ==========================================================
   ESECUZIONE
   ========================================================== */

const target = process.env.DATA_STORAGE_CONNECTION.startsWith('UseDevelopmentStorage')
    ? 'Azurite'
    : 'un account Azure';

console.log(`\nEventi passati di "${group}" -> ${target}${dryRun ? '  (prova a vuoto)' : ''}\n`);

const nodes = await fetchAllPastEvents();
const imported = nodes.map(toEvent).filter(Boolean);
if (imported.length < nodes.length) {
    console.log(`  ${nodes.length - imported.length} scartati: senza titolo, senza data o con una URL che non e di Meetup`);
}
console.log(`  scaricati da Meetup: ${imported.length}`);

const current = await readPrivate(BLOB_NAME);
const document = current.data ?? { version: 1, events: [] };
const existing = Array.isArray(document.events) ? document.events : [];
console.log(`  gia sul blob: ${existing.length}`);

const { events, added, updated, untouched, removed } = merge(existing, imported);

console.log('');
for (const event of removed) console.log(`  - rimosso segnaposto  ${event.id}`);
for (const event of added) console.log(`  + ${event.dateTime.slice(0, 10)}  ${event.title.slice(0, 58)}`);
if (updated.length > 0) console.log(`  ~ riscritti: ${updated.length}`);
if (untouched.length > 0) console.log(`  = gia presenti, lasciati com'erano: ${untouched.length} (--force-update per riscriverli)`);

const next = { ...document, version: document.version ?? 1, events };

// Si valida sempre, anche a vuoto: un documento che non passa la validazione
// verrebbe rifiutato dalla PUT dell'admin, e scoprirlo adesso costa meno che
// scoprirlo quando qualcuno prova a salvare.
const result = validateEvents(next);
if (!result.ok) {
    console.error('\nIl documento non e valido, non scrivo niente:\n');
    for (const issue of result.issues) console.error(`  ${issue.path}: ${issue.message}`);
    process.exit(1);
}

console.log(`\n  totale dopo l'unione: ${result.value.events.length}`);

if (dryRun) {
    console.log('\nProva a vuoto: niente e stato scritto.\n');
    process.exit(0);
}

const written = {
    ...result.value,
    updatedAt: new Date().toISOString(),
    updatedBy: 'scripts/import-meetup-past.mjs'
};

await writePrivate(BLOB_NAME, written);
console.log(`  ${PRIVATE_CONTAINER()}/${BLOB_NAME}: scritto`);

await publishPublic(BLOB_NAME, written);
console.log(`  ${PUBLIC_CONTAINER()}/${BLOB_NAME}: pubblicato`);

// La copia imbarcata nel deploy e la rete di sicurezza se il blob non risponde:
// lasciarla con dentro gli eventi inventati significherebbe mostrare quelli.
await writeFile(
    join(root, 'src', 'data', BLOB_NAME),
    `${JSON.stringify({ version: written.version, events: written.events }, null, 4)}\n`,
    'utf8'
);
console.log(`  src/data/${BLOB_NAME}: allineato (da committare)`);

console.log('\nFatto.\n');
