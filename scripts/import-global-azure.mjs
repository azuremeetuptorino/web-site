/**
 * Migrazione una tantum delle foto di Global Azure Torino dal vecchio sito
 * WordPress (globalazuretorino.welol.it) al blob del sito nuovo.
 *
 * Cosa fa, per ogni edizione trovata:
 *   1. legge le gallerie da tre pagine: la home (2026), /edizione-2025/ e
 *      /edizioni-passate/ (2018-2024, un blocco per anno sotto il suo titolo);
 *   2. scarica l'originale di ogni foto (il link del lightbox, non la miniatura);
 *   3. ne fa due WebP con sharp — 2000 px e miniatura 640 px, le stesse misure
 *      dell'upload dall'admin — e li carica in public/global-azure/<anno>/;
 *   4. aggiunge le foto al documento dell'edizione (global-azure/<anno>.json),
 *      senza toccare quelle gia presenti: si puo rilanciare senza doppioni.
 *
 * Per il 2026 prende anche i loghi degli sponsor dalla home e li mette al posto
 * dei segnaposto, se lo sponsor c'e gia nel documento.
 *
 * Il documento passa dallo stesso validatore dell'API e si scrive con If-Match:
 * se nel frattempo qualcuno salva dall'admin, lo script si ferma invece di
 * sovrascrivere.
 *
 * Uso:
 *   npm run import:ga                           # su Azurite
 *   npm run import:ga -- --dry-run              # elenca e basta
 *   npm run import:ga -- --years=2019,2024      # solo alcuni anni
 *   DATA_STORAGE_CONNECTION="..." npm run import:ga   # su un account vero
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import sharp from 'sharp';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const SITE = 'https://globalazuretorino.welol.it';
const UPLOADS = /https:\/\/globalazuretorino\.welol\.it\/wp-content\/uploads\/[^"'\s)]+?\.(?:jpe?g|png|webp)/i;

const LARGE_EDGE = 2000;
const THUMB_EDGE = 640;
const PARALLEL = 4;

/* ==========================================================
   ARGOMENTI E STORAGE
   ========================================================== */

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyYears = args.find((arg) => arg.startsWith('--years='))?.slice(8).split(',').filter(Boolean);

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

const { readPrivate, writePrivate, publishPublic, uploadPublicAsset } = await import('../api/src/lib/blob.js');
const { validateGlobalAzureEdition } = await import('../api/src/lib/validate.js');
const { assetName } = await import('../api/src/lib/image.js');

/* ==========================================================
   LETTURA DELLE GALLERIE
   ========================================================== */

async function fetchText(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return response.text();
}

async function fetchBuffer(url) {
    const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok) throw new Error(`${url}: ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

/** Le foto di una galleria sono i link con `data-lbox`: puntano all'originale. */
function lightboxLinks(html) {
    const links = [];
    for (const match of html.matchAll(/<a\b[^>]*\bdata-lbox="[^"]*"[^>]*>/gi)) {
        const href = /\bhref="([^"]+)"/i.exec(match[0])?.[1];
        if (href && UPLOADS.test(href)) links.push({ url: href.replace(/-\d+x\d+(?=\.\w+$)/, ''), at: match.index });
    }
    return links;
}

const unique = (links) => [...new Map(links.map((link) => [link.url, link])).values()];

/**
 * /edizioni-passate/ ha un blocco per anno: ogni foto appartiene all'ultimo
 * titolo con un anno che la precede.
 */
function groupByHeading(html) {
    const headings = [...html.matchAll(/<h[1-6][^>]*>([\s\S]*?)<\/h[1-6]>/gi)]
        .map((match) => ({ at: match.index, year: /\b(20\d{2})\b/.exec(match[1].replace(/<[^>]+>/g, ''))?.[1] }))
        .filter((heading) => heading.year);

    const groups = new Map();
    for (const link of lightboxLinks(html)) {
        const year = headings.filter((heading) => heading.at < link.at).at(-1)?.year;
        if (!year) continue;
        if (!groups.has(year)) groups.set(year, []);
        groups.get(year).push(link);
    }
    return groups;
}

/** I loghi degli sponsor 2026 in home, riconosciuti dal nome del file. */
const SPONSOR_LOGOS = [
    [/AzureMeetup/i, 'azure-meetup-torino'],
    [/Alveo/i, 'alveo'],
    [/v-valley/i, 'v-valley'],
    [/Qumulo/i, 'qumulo'],
    [/avePoint/i, 'avepoint'],
    [/extranet/i, 'extranet'],
    [/TD-SYNNEX/i, 'td-synnex'],
    [/Microsoft/i, 'microsoft'],
    [/logo-ITS/i, 'its-ict-piemonte']
];

function sponsorLogos(html) {
    const found = new Map();
    for (const match of html.matchAll(/<img\b[^>]*\bsrc="([^"]+\.(?:png|jpe?g|webp|svg))"/gi)) {
        const url = match[1].replace(/-\d+x\d+(?=\.\w+$)/, '');
        const hit = SPONSOR_LOGOS.find(([pattern]) => pattern.test(url.split('/').pop()));
        if (hit && !found.has(hit[1])) found.set(hit[1], url);
    }
    return found;
}

/* ==========================================================
   ELABORAZIONE
   ========================================================== */

const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 36);

const baseName = (url) => decodeURIComponent(url.split('/').pop()).replace(/\.\w+$/, '');

async function processPhoto(year, url) {
    const original = await fetchBuffer(url);
    const base = baseName(url);
    const image = sharp(original, { failOn: 'none' }).rotate();

    const large = await image.clone()
        .resize({ width: LARGE_EDGE, height: LARGE_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 82 })
        .toBuffer({ resolveWithObject: true });
    const thumb = await image.clone()
        .resize({ width: THUMB_EDGE, height: THUMB_EDGE, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: 78 })
        .toBuffer({ resolveWithObject: true });

    const headers = { contentType: 'image/webp', cacheControl: 'public, max-age=31536000, immutable' };
    const largeUpload = await uploadPublicAsset(`global-azure/${year}/${assetName(base, large.data, 'webp')}`, large.data, headers);
    const thumbUpload = await uploadPublicAsset(`global-azure/${year}/${assetName(`${base}-thumb`, thumb.data, 'webp')}`, thumb.data, headers);

    return {
        id: `p-${slug(base) || 'foto'}`,
        url: largeUpload.url,
        thumbUrl: thumbUpload.url,
        width: large.info.width,
        height: large.info.height,
        caption: undefined,
        featured: false
    };
}

async function inBatches(items, worker) {
    const results = [];
    let next = 0;
    await Promise.all(Array.from({ length: PARALLEL }, async () => {
        while (next < items.length) {
            const index = next;
            next += 1;
            try {
                results[index] = await worker(items[index], index);
            } catch (error) {
                console.warn(`    ! ${items[index].url ?? items[index]}: ${error.message}`);
            }
        }
    }));
    return results;
}

async function importYear(year, links, logos) {
    const blobName = `global-azure/${year}.json`;
    const { etag, data } = await readPrivate(blobName);
    const document = {
        version: 1,
        tracks: [], speakers: [], sessions: [], photos: [], sponsors: [],
        ...(data ?? {})
    };

    const known = new Set(document.photos.map((photo) => photo.id));
    const todo = links.filter((link) => !known.has(`p-${slug(baseName(link.url)) || 'foto'}`));

    console.log(`\n  ${year}: ${links.length} foto sul vecchio sito, ${todo.length} da importare`);
    if (dryRun) {
        for (const link of todo) console.log(`    - ${link.url}`);
        return;
    }

    const photos = (await inBatches(todo, (link) => processPhoto(year, link.url))).filter(Boolean);
    for (const photo of photos) {
        if (known.has(photo.id)) continue;
        known.add(photo.id);
        document.photos.push(photo);
        process.stdout.write('.');
    }

    // Qualche foto in evidenza, se nessuno l'ha ancora scelta: il mosaico
    // della galleria ha bisogno di qualche tessera grande per respirare.
    if (!document.photos.some((photo) => photo.featured)) {
        document.photos.forEach((photo, index) => {
            if (index % 7 === 0 && index < 21 && (photo.width ?? 0) >= (photo.height ?? 0)) photo.featured = true;
        });
    }

    let logosUpdated = 0;
    for (const sponsor of document.sponsors) {
        const source = logos?.get(sponsor.id);
        if (!source || !/placeholder/.test(sponsor.logoUrl ?? '')) continue;
        try {
            const body = await fetchBuffer(source);
            const extension = source.split('.').pop().toLowerCase().replace('jpeg', 'jpg');
            const type = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', svg: 'image/svg+xml' }[extension];
            const upload = await uploadPublicAsset(`sponsors/${assetName(sponsor.id, body, extension)}`, body,
                { contentType: type, cacheControl: 'public, max-age=31536000, immutable' });
            sponsor.logoUrl = upload.url;
            logosUpdated += 1;
        } catch (error) {
            console.warn(`    ! logo ${sponsor.id}: ${error.message}`);
        }
    }

    const result = validateGlobalAzureEdition(document);
    if (!result.ok) {
        console.error(`    documento ${year} non valido, non lo scrivo:`, result.issues.slice(0, 5));
        return;
    }

    const saved = { ...result.value, updatedAt: new Date().toISOString(), updatedBy: 'import-global-azure' };
    await writePrivate(blobName, saved, { ifMatch: etag ?? undefined, ifAbsent: !etag });
    await publishPublic(blobName, saved);
    console.log(`\n    ${photos.length} foto aggiunte${logosUpdated ? `, ${logosUpdated} loghi sponsor` : ''} -> ${blobName}`);
}

/* ==========================================================
   AVVIO
   ========================================================== */

console.log(`\nImport Global Azure da ${SITE} su ${process.env.DATA_STORAGE_CONNECTION.startsWith('UseDevelopmentStorage') ? 'Azurite' : 'un account Azure'}${dryRun ? ' (prova, non scrivo niente)' : ''}`);

const [home, edition2025, past] = await Promise.all([
    fetchText(`${SITE}/`),
    fetchText(`${SITE}/edizione-2025/`),
    fetchText(`${SITE}/edizioni-passate/`)
]);

const years = groupByHeading(past);
years.set('2025', lightboxLinks(edition2025));
years.set('2026', lightboxLinks(home));
const logos = new Map([['2026', sponsorLogos(home)]]);

for (const [year, links] of [...years.entries()].sort(([a], [b]) => b.localeCompare(a))) {
    if (onlyYears && !onlyYears.includes(year)) continue;
    await importYear(year, unique(links), logos.get(year));
}

console.log('\nFatto.\n');
