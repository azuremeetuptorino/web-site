import { createEditorCore } from './editor-core.js';
import { apiGet } from './api.js';
import { createContentEditor } from './content-editor.js';

/**
 * Pannello Global Azure: due editor nello stesso tab.
 *
 *  - EDIZIONI (`/api/global-azure`): l'indice, una scheda per anno con data,
 *    sede, copertina e numeri.
 *  - CONTENUTI (`/api/global-azure/editions/{anno}`): agenda, speaker, tracce,
 *    foto e sponsor dell'anno scelto nel selettore. Lo stesso editor cambia
 *    documento quando si cambia anno.
 *
 * Tutto il resto — import da Sessionize, caricamento multiplo delle foto,
 * copia degli sponsor — vive accanto ai due editor e usa i comandi che il
 * nucleo espone (add, refill, readRow), come l'import degli eventi.
 */

const PLACEHOLDER_EVENT = '/assets/img/placeholder-event.svg';
const PLACEHOLDER_LOGO = '/assets/img/placeholder-logo.svg';

const YEAR = /^20\d{2}$/;

export const GA_TIER_LABEL = {
    organizer: 'Organizzatore',
    diamond: 'Diamond',
    platinum: 'Platinum',
    gold: 'Gold',
    silver: 'Silver',
    contributor: 'Con il contributo di'
};

/** Dalle fasce degli sponsor del sito a quelle di Global Azure. */
/** Dalle fasce degli sponsor del sito a quelle di Global Azure. */
const TIER_FROM_SITE = {
    diamond: 'diamond',
    platinum: 'platinum',
    gold: 'gold',
    silver: 'silver',
    bronze: 'silver',
    partner: 'contributor'
};

const number = (raw) => (raw === '' ? undefined : Number(raw));

function formatDay(date) {
    if (!date) return 'data da definire';
    const parsed = new Date(`${date}T12:00:00`);
    if (Number.isNaN(parsed.getTime())) return date;
    return new Intl.DateTimeFormat('it-IT', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' }).format(parsed);
}

/* ==========================================================
   EDIZIONI
   ========================================================== */

function nextYear() {
    const years = gaIndexEditor.rows('editions')
        .map((row) => Number(gaIndexEditor.value(row, 'id')))
        .filter((year) => Number.isInteger(year));
    return years.length > 0 ? Math.max(...years) + 1 : new Date().getFullYear();
}

export const gaIndexEditor = createEditorCore({
    endpoint: '/api/global-azure',

    ids: {
        loading: 'ga-index-loading',
        editor: 'ga-index-editor',
        alert: 'ga-index-alert',
        state: 'ga-index-state',
        save: 'ga-index-save',
        reload: 'ga-index-reload'
    },

    lists: {
        editions: {
            label: 'edizione',

            blank() {
                const year = nextYear();
                return {
                    id: String(year),
                    title: `Global Azure Torino ${year}`,
                    venue: { city: 'Torino' },
                    published: true
                };
            },

            fill(row, edition, { field }) {
                field(row, 'id').value = edition.id ?? '';
                field(row, 'date').value = edition.date ?? '';
                field(row, 'title').value = edition.title ?? '';
                field(row, 'tagline').value = edition.tagline ?? '';
                field(row, 'highlight').value = edition.highlight ?? '';
                field(row, 'venue.name').value = edition.venue?.name ?? '';
                field(row, 'venue.address').value = edition.venue?.address ?? '';
                field(row, 'venue.city').value = edition.venue?.city ?? '';
                field(row, 'registrationUrl').value = edition.registrationUrl ?? '';
                field(row, 'coverUrl').value = edition.coverUrl ?? '';
                field(row, 'sessionizeId').value = edition.sessionizeId ?? '';
                for (const key of ['attendees', 'sessions', 'speakers', 'tracks']) {
                    field(row, `stats.${key}`).value = edition.stats?.[key] ?? '';
                }
                field(row, 'current').checked = edition.current === true;
                field(row, 'published').checked = edition.published !== false;
            },

            collect(row, index, { value, field }) {
                return {
                    id: value(row, 'id'),
                    date: value(row, 'date'),
                    title: value(row, 'title'),
                    tagline: value(row, 'tagline'),
                    highlight: value(row, 'highlight'),
                    venue: {
                        name: value(row, 'venue.name'),
                        address: value(row, 'venue.address'),
                        city: value(row, 'venue.city')
                    },
                    registrationUrl: value(row, 'registrationUrl'),
                    coverUrl: value(row, 'coverUrl'),
                    sessionizeId: value(row, 'sessionizeId'),
                    stats: {
                        attendees: number(value(row, 'stats.attendees')),
                        sessions: number(value(row, 'stats.sessions')),
                        speakers: number(value(row, 'stats.speakers')),
                        tracks: number(value(row, 'stats.tracks'))
                    },
                    current: field(row, 'current').checked,
                    published: field(row, 'published').checked
                };
            },

            preview(row, { field, preview, value }) {
                preview(row, 'title').textContent = value(row, 'title') || `Edizione ${value(row, 'id')}`;
                preview(row, 'when').textContent = [formatDay(value(row, 'date')), value(row, 'venue.name')]
                    .filter(Boolean).join(' · ');

                const thumb = preview(row, 'cover');
                const wanted = value(row, 'coverUrl') || PLACEHOLDER_EVENT;
                if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);

                preview(row, 'current').hidden = !field(row, 'current').checked;
                preview(row, 'hidden').hidden = field(row, 'published').checked;
            }
        }
    },

    fill(data, { setList }) {
        setList('editions', [...(data.editions ?? [])].sort((a, b) => String(b.id).localeCompare(String(a.id))));
        refreshYears();
    },

    collect({ readList }) {
        return { version: 1, editions: readList('editions') };
    },

    onEdit(target, { rows, field, preview }) {
        // Una sola edizione corrente: spuntarne una toglie la spunta alle altre.
        if (target.dataset.field === 'current' && target.checked) {
            for (const row of rows('editions')) {
                const box = field(row, 'current');
                if (box !== target && box.checked) {
                    box.checked = false;
                    preview(row, 'current').hidden = true;
                }
            }
        }
        if (['id', 'current', 'title'].includes(target.dataset.field)) refreshYears();
    }
});

/* ==========================================================
   CONTENUTI DI UN'EDIZIONE
   ========================================================== */

let year = null;

const contents = createContentEditor({
    prefix: 'ga',
    ids: {
        loading: 'ga-edition-loading',
        editor: 'ga-edition-editor',
        alert: 'ga-edition-alert',
        state: 'ga-edition-state',
        save: 'ga-edition-save',
        reload: 'ga-edition-reload'
    },
    endpoint: () => `/api/global-azure/editions/${year}`,
    extraLists: {
    sponsors: {
        label: 'sponsor',
        autoSlug: true,
        blank: () => ({ tier: 'gold' }),
        fill(row, sponsor, { field, setSelect }) {
            field(row, 'name').value = sponsor.name ?? '';
            field(row, 'id').value = sponsor.id ?? '';
            setSelect(field(row, 'tier'), sponsor.tier ?? 'gold');
            field(row, 'logoUrl').value = sponsor.logoUrl ?? '';
            field(row, 'websiteUrl').value = sponsor.websiteUrl ?? '';
        },
        collect(row, index, { value }) {
            return {
                id: value(row, 'id'),
                name: value(row, 'name'),
                tier: value(row, 'tier'),
                logoUrl: value(row, 'logoUrl'),
                websiteUrl: value(row, 'websiteUrl')
            };
        },
        preview(row, { preview, value }) {
            preview(row, 'name').textContent = value(row, 'name') || 'Nuovo sponsor';
            preview(row, 'tier').textContent = GA_TIER_LABEL[value(row, 'tier')] ?? value(row, 'tier');
            const thumb = preview(row, 'logo');
            const wanted = value(row, 'logoUrl') || PLACEHOLDER_LOGO;
            if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);
        }
    }
    },
    uploadPrefix: () => year,
    // L'id usato per l'import torna nella scheda dell'edizione, se manca.
    onSessionizeImported(sessionizeId) {
        const indexRow = indexRowFor(year);
        if (indexRow && !gaIndexEditor.value(indexRow, 'sessionizeId')) {
            gaIndexEditor.field(indexRow, 'sessionizeId').value = sessionizeId;
            gaIndexEditor.markDirty();
        }
    }
});

export const gaEditionEditor = contents.editor;

/* ==========================================================
   SCELTA DELL'ANNO
   ========================================================== */

const yearSelect = document.getElementById('ga-year');
const editionLoading = document.getElementById('ga-edition-loading');
const editionNone = document.getElementById('ga-edition-none');
const sessionizeInput = contents.sessionizeInput;

let editionStarted = false;
let canWriteEdition = true;

// Un'edizione aggiunta o tolta dall'indice cambia le voci del selettore.
new MutationObserver(() => refreshYears())
    .observe(document.querySelector('#ga-index-editor [data-list="editions"]'), { childList: true });

function indexRowFor(id) {
    return gaIndexEditor.rows('editions').find((row) => gaIndexEditor.value(row, 'id') === id);
}

function prefillSessionize() {
    const row = year ? indexRowFor(year) : null;
    sessionizeInput.value = row ? gaIndexEditor.value(row, 'sessionizeId') : '';
}

function refreshYears() {
    const rows = gaIndexEditor.rows('editions');
    const years = rows
        .map((row) => ({
            id: gaIndexEditor.value(row, 'id'),
            current: gaIndexEditor.field(row, 'current').checked
        }))
        .filter((entry) => YEAR.test(entry.id))
        .sort((a, b) => b.id.localeCompare(a.id));

    yearSelect.replaceChildren(...years.map((entry) =>
        new Option(entry.current ? `${entry.id} · corrente` : entry.id, entry.id)));

    if (year && !years.some((entry) => entry.id === year)) {
        // L'anno aperto e stato rinominato o tolto dall'indice: resta aperto
        // finche non se ne sceglie un altro, per non perdere modifiche.
        yearSelect.add(new Option(`${year} (non piu nell'indice)`, year));
    }

    if (!year && years.length > 0) {
        year = (years.find((entry) => entry.current) ?? years[0]).id;
        if (!editionStarted) startEdition();
    }
    if (year) yearSelect.value = year;
}

async function startEdition() {
    editionStarted = true;
    editionNone.hidden = true;
    editionLoading.hidden = false;
    prefillSessionize();
    await gaEditionEditor.init(canWriteEdition);
}

yearSelect.addEventListener('change', async () => {
    const wanted = yearSelect.value;
    if (wanted === year) return;
    if (gaEditionEditor.isDirty() && !confirm(`Le modifiche all'edizione ${year} non sono salvate e andranno perse. Cambio anno?`)) {
        yearSelect.value = year;
        return;
    }
    year = wanted;
    prefillSessionize();
    await gaEditionEditor.reload();
});

/* ==========================================================
   NUMERI DELL'EDIZIONE
   ========================================================== */

document.getElementById('ga-index-editor').addEventListener('click', async (event) => {
    const button = event.target.closest('[data-ga-recount]');
    if (!button) return;

    const row = button.closest('.editor-row');
    const id = gaIndexEditor.value(row, 'id');
    if (!YEAR.test(id)) return;

    button.disabled = true;
    try {
        let data;
        if (id === year && editionStarted) {
            data = {
                tracks: gaEditionEditor.rows('tracks'),
                speakers: gaEditionEditor.rows('speakers'),
                sessions: gaEditionEditor.rows('sessions').map((r) => gaEditionEditor.readRow(r))
            };
        } else {
            ({ payload: { data } } = await apiGet(`/api/global-azure/editions/${id}`));
        }
        const talks = (data.sessions ?? []).filter((session) => ['talk', 'keynote'].includes(session.kind ?? 'talk'));
        gaIndexEditor.field(row, 'stats.sessions').value = talks.length || '';
        gaIndexEditor.field(row, 'stats.speakers').value = (data.speakers ?? []).length || '';
        gaIndexEditor.field(row, 'stats.tracks').value = (data.tracks ?? []).length || '';
        gaIndexEditor.markDirty();
    } catch (error) {
        gaIndexEditor.handleError(error);
    } finally {
        button.disabled = false;
    }
});

/* ==========================================================
   SPONSOR: COPIA DA QUELLI DEL SITO
   ========================================================== */

document.getElementById('ga-sponsor-copy').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
        const { payload } = await apiGet('/api/sponsors');
        const present = new Set(gaEditionEditor.rows('sponsors').map((row) => gaEditionEditor.value(row, 'id')));
        let added = 0;
        for (const sponsor of payload.data?.sponsors ?? []) {
            if (sponsor.active === false || present.has(sponsor.id)) continue;
            gaEditionEditor.add('sponsors', {
                id: sponsor.id,
                name: sponsor.name,
                tier: TIER_FROM_SITE[sponsor.tier] ?? 'contributor',
                logoUrl: sponsor.logoUrl,
                websiteUrl: sponsor.websiteUrl
            }, { open: false });
            added += 1;
        }
        gaEditionEditor.setAlert(
            added > 0 ? 'success' : 'warn',
            added > 0
                ? `Copiati ${added} sponsor dal sito. Controlla le fasce: quelle di Global Azure non coincidono sempre.`
                : 'Tutti gli sponsor attivi del sito sono gia in lista.'
        );
    } catch (error) {
        gaEditionEditor.handleError(error);
    } finally {
        button.disabled = false;
    }
});

/* ==========================================================
   PANNELLO
   ========================================================== */

export const globalAzurePanel = {
    async init(canWrite = true) {
        canWriteEdition = canWrite;
        await gaIndexEditor.init(canWrite);
        if (!editionStarted) {
            editionLoading.hidden = true;
            editionNone.hidden = false;
        }
    },
    isDirty: () => gaIndexEditor.isDirty() || gaEditionEditor.isDirty()
};
