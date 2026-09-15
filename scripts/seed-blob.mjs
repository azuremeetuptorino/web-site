/**
 * Carica i JSON di `src/data/` su Blob Storage.
 *
 * Serve due volte: in locale, per popolare Azurite appena creato il container,
 * e una volta sola in produzione dopo provision-azure.ps1, perche lo script di
 * provisioning crea i container ma non ci mette dentro niente — e senza il
 * primo caricamento il sito leggerebbe 404 dal blob e ripiegherebbe per sempre
 * sulla copia imbarcata nel deploy.
 *
 * Il master privato NON viene sovrascritto se esiste gia: quello e il documento
 * che l'admin modifica, e rimetterci sopra il seed cancellerebbe il suo lavoro.
 * Per forzare (tipicamente su un ambiente appena buttato via) serve --force.
 *
 * La copia pubblica invece si riscrive sempre: e derivata.
 *
 * Uso:
 *   npm run seed                      # su Azurite
 *   npm run seed -- --force           # riscrive anche i master
 *   DATA_STORAGE_CONNECTION="..." npm run seed     # su un account vero
 *
 * L'import passa da api/src/lib/blob.js di proposito: il seed scrive con gli
 * stessi header e la stessa Cache-Control che usera poi l'editor dell'admin.
 */

import { readFile } from 'node:fs/promises';
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

const force = process.argv.includes('--force');

/** `master: true` = esiste anche una copia privata modificabile dall'admin. */
const FILES = [
    { name: 'team.json', master: true },
    { name: 'sponsors.json', master: true },
    { name: 'events.json', master: false }
];

async function seed({ name, master }) {
    let document;
    try {
        document = JSON.parse(await readFile(join(root, 'src', 'data', name), 'utf8'));
    } catch (error) {
        console.error(`  ${name}: non leggibile da src/data/ (${error.message})`);
        return;
    }

    if (master) {
        const existing = await readPrivate(name);
        if (existing.etag && !force) {
            console.log(`  ${PRIVATE_CONTAINER()}/${name}: gia presente, lasciato com'e (--force per riscriverlo)`);
        } else {
            await writePrivate(name, document);
            console.log(`  ${PRIVATE_CONTAINER()}/${name}: ${existing.etag ? 'riscritto' : 'creato'}`);
        }
    }

    await publishPublic(name, document);
    console.log(`  ${PUBLIC_CONTAINER()}/${name}: pubblicato`);
}

console.log(`\nSeed dei dati su ${process.env.DATA_STORAGE_CONNECTION.startsWith('UseDevelopmentStorage') ? 'Azurite' : 'un account Azure'}\n`);

for (const file of FILES) {
    await seed(file);
}

console.log('\nFatto.\n');
