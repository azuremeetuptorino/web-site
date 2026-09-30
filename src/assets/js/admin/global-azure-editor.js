import { createEditorCore } from './editor-core.js';
import { apiGet, apiPost, ApiError, SessionExpiredError } from './api.js';
import { uploadImage } from './upload.js';
import { resizePhoto, extensionOf } from './photo-resize.js';
import { toLocalInput, fromLocalInput } from './events-editor.js';

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
const PLACEHOLDER_AVATAR = '/assets/img/placeholder-avatar.svg';
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

const KIND_LABEL = { keynote: 'keynote', plenary: 'plenaria', service: 'servizio' };

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

function formatClock(local) {
    const date = new Date(local);
    if (!local || Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function slugify(text) {
    return String(text ?? '')
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
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

/** Tracce e speaker come li vede adesso il form, non come erano al caricamento. */
function currentTracks() {
    return gaEditionEditor.rows('tracks')
        .map((row) => ({
            id: gaEditionEditor.value(row, 'id'),
            name: gaEditionEditor.value(row, 'name'),
            color: gaEditionEditor.value(row, 'color')
        }))
        .filter((track) => track.id);
}

function currentSpeakers() {
    return gaEditionEditor.rows('speakers')
        .map((row) => ({ id: gaEditionEditor.value(row, 'id'), name: gaEditionEditor.value(row, 'name') }))
        .filter((speaker) => speaker.id);
}

function selectedSpeakers(row) {
    try {
        return JSON.parse(row.dataset.speakerIds || '[]');
    } catch {
        return [];
    }
}

function renderTrackOptions(row, selected, tracks) {
    const select = row.querySelector('[data-field="trackId"]');
    select.replaceChildren(new Option('Nessuna', ''));
    for (const track of tracks) select.add(new Option(track.name || track.id, track.id));
    select.value = selected ?? '';
    if (selected && select.value !== selected) {
        select.add(new Option(`${selected} (traccia non piu in elenco)`, selected, true, true));
    }
}

function renderSpeakerChoices(row, speakers) {
    const selected = new Set(selectedSpeakers(row));
    const box = row.querySelector('[data-speaker-choices]');
    const known = new Set(speakers.map((speaker) => speaker.id));

    const entries = [
        ...[...selected].filter((id) => !known.has(id)).map((id) => ({ id, name: `${id} (non piu in elenco)` })),
        ...[...speakers].sort((a, b) => a.name.localeCompare(b.name, 'it'))
    ];
    // Chi e gia scelto sta in cima: con trenta nomi, altrimenti non si vede.
    entries.sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)));

    box.replaceChildren(...entries.map((speaker) => {
        const label = document.createElement('label');
        label.className = 'ga-choice';
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.value = speaker.id;
        input.checked = selected.has(speaker.id);
        input.dataset.speakerChoice = '';
        label.append(input, document.createTextNode(` ${speaker.name || speaker.id}`));
        return label;
    }));

    if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'field-note';
        empty.textContent = 'Nessuno speaker in elenco: aggiungili dalla scheda Speaker.';
        box.append(empty);
    }
}

function refreshSessionReferences(row) {
    const track = row.querySelector('[data-field="trackId"]').value;
    renderTrackOptions(row, track, currentTracks());
    renderSpeakerChoices(row, currentSpeakers());
}

export const gaEditionEditor = createEditorCore({
    endpoint: () => `/api/global-azure/editions/${year}`,

    ids: {
        loading: 'ga-edition-loading',
        editor: 'ga-edition-editor',
        alert: 'ga-edition-alert',
        state: 'ga-edition-state',
        save: 'ga-edition-save',
        reload: 'ga-edition-reload'
    },

    lists: {
        tracks: {
            label: 'traccia',
            autoSlug: true,
            blank: () => ({ color: '#0078D4' }),
            fill(row, track, { field }) {
                field(row, 'name').value = track.name ?? '';
                field(row, 'id').value = track.id ?? '';
                field(row, 'color').value = track.color ?? '#0078D4';
            },
            collect(row, index, { value }) {
                return { id: value(row, 'id'), name: value(row, 'name'), color: value(row, 'color') };
            }
        },

        speakers: {
            label: 'speaker',
            autoSlug: true,
            fill(row, speaker, { field }) {
                field(row, 'name').value = speaker.name ?? '';
                field(row, 'id').value = speaker.id ?? '';
                field(row, 'tagline').value = speaker.tagline ?? '';
                field(row, 'company').value = speaker.company ?? '';
                field(row, 'badges').value = (speaker.badges ?? []).join(', ');
                field(row, 'photoUrl').value = speaker.photoUrl ?? '';
                field(row, 'bio').value = speaker.bio ?? '';
                for (const type of ['linkedin', 'website', 'github', 'x', 'bluesky']) {
                    field(row, `links.${type}`).value = speaker.links?.[type] ?? '';
                }
            },
            collect(row, index, { value }) {
                return {
                    id: value(row, 'id'),
                    name: value(row, 'name'),
                    tagline: value(row, 'tagline'),
                    company: value(row, 'company'),
                    badges: value(row, 'badges').split(',').map((badge) => badge.trim()).filter(Boolean),
                    photoUrl: value(row, 'photoUrl'),
                    bio: value(row, 'bio'),
                    links: Object.fromEntries(
                        ['linkedin', 'website', 'github', 'x', 'bluesky'].map((type) => [type, value(row, `links.${type}`)])
                    )
                };
            },
            preview(row, { preview, value }) {
                preview(row, 'name').textContent = value(row, 'name') || 'Nuovo speaker';
                preview(row, 'tagline').textContent = value(row, 'tagline') || value(row, 'company');
                const thumb = preview(row, 'photo');
                const wanted = value(row, 'photoUrl') || PLACEHOLDER_AVATAR;
                if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);
            }
        },

        sessions: {
            label: 'sessione',
            autoSlug: 'title',
            blank() {
                // Una sessione nuova parte dopo l'ultima in lista: di solito e li che va.
                const last = gaEditionEditor.rows('sessions').at(-1);
                const end = last ? gaEditionEditor.value(last, 'end') : '';
                const start = end ? fromLocalInput(end) : undefined;
                return {
                    kind: 'talk',
                    start,
                    end: start ? new Date(Date.parse(start) + 55 * 60000).toISOString() : undefined
                };
            },
            fill(row, session, { field, rows, value }) {
                field(row, 'title').value = session.title ?? '';
                field(row, 'id').value = session.id ?? '';
                field(row, 'start').value = toLocalInput(session.start);
                field(row, 'end').value = toLocalInput(session.end);
                field(row, 'kind').value = session.kind ?? 'talk';
                field(row, 'language').value = session.language ?? '';
                field(row, 'description').value = session.description ?? '';
                row.dataset.speakerIds = JSON.stringify(session.speakerIds ?? []);

                // Qui l'editor non e ancora pronto a rispondere: le tracce e gli
                // speaker si leggono con gli strumenti che il nucleo passa.
                const tracks = rows('tracks').map((r) => ({ id: value(r, 'id'), name: value(r, 'name') })).filter((t) => t.id);
                const speakers = rows('speakers').map((r) => ({ id: value(r, 'id'), name: value(r, 'name') })).filter((s) => s.id);
                renderTrackOptions(row, session.trackId, tracks);
                renderSpeakerChoices(row, speakers);
            },
            collect(row, index, { value }) {
                return {
                    id: value(row, 'id'),
                    title: value(row, 'title'),
                    start: fromLocalInput(value(row, 'start')),
                    end: fromLocalInput(value(row, 'end')),
                    kind: value(row, 'kind'),
                    trackId: value(row, 'trackId'),
                    language: value(row, 'language'),
                    speakerIds: selectedSpeakers(row),
                    description: value(row, 'description')
                };
            },
            preview(row, { preview, value, rows }) {
                preview(row, 'title').textContent = value(row, 'title') || 'Nuova sessione';

                const from = formatClock(value(row, 'start'));
                const to = formatClock(value(row, 'end'));
                preview(row, 'time').textContent = from ? `${from}${to ? `–${to}` : ''}` : '--:--';

                const names = new Map(rows('speakers').map((r) => [value(r, 'id'), value(r, 'name')]));
                preview(row, 'who').textContent = selectedSpeakers(row).map((id) => names.get(id) ?? id).join(', ');

                const trackId = value(row, 'trackId');
                const trackRow = rows('tracks').find((r) => value(r, 'id') === trackId);
                const chip = preview(row, 'track');
                chip.hidden = !trackRow;
                if (trackRow) {
                    chip.textContent = value(trackRow, 'name');
                    chip.style.setProperty('--track', value(trackRow, 'color') || '#0078D4');
                }

                const kind = preview(row, 'kind');
                kind.hidden = !KIND_LABEL[value(row, 'kind')];
                kind.textContent = KIND_LABEL[value(row, 'kind')] ?? '';
            }
        },

        photos: {
            label: 'scatto',
            fill(row, photo, { field }) {
                field(row, 'id').value = photo.id ?? '';
                field(row, 'url').value = photo.url ?? '';
                field(row, 'thumbUrl').value = photo.thumbUrl ?? '';
                field(row, 'width').value = photo.width ?? '';
                field(row, 'height').value = photo.height ?? '';
                field(row, 'caption').value = photo.caption ?? '';
                field(row, 'featured').checked = photo.featured === true;
            },
            collect(row, index, { value, field }) {
                return {
                    id: value(row, 'id'),
                    url: value(row, 'url'),
                    thumbUrl: value(row, 'thumbUrl'),
                    width: number(value(row, 'width')),
                    height: number(value(row, 'height')),
                    caption: value(row, 'caption'),
                    featured: field(row, 'featured').checked
                };
            },
            preview(row, { preview, value, field }) {
                const thumb = preview(row, 'thumb');
                const wanted = value(row, 'thumbUrl') || value(row, 'url');
                if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);
                row.classList.toggle('is-featured', field(row, 'featured').checked);
            }
        },

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

    fill(data, { setList }) {
        // L'ordine conta: le sessioni leggono tracce e speaker gia in pagina.
        setList('tracks', data.tracks);
        setList('speakers', data.speakers);
        setList('sessions', data.sessions);
        setList('photos', data.photos);
        setList('sponsors', data.sponsors);
        afterContentChange();
    },

    collect({ readList }) {
        return {
            version: 1,
            tracks: readList('tracks'),
            speakers: readList('speakers'),
            sessions: readList('sessions'),
            photos: readList('photos'),
            sponsors: readList('sponsors')
        };
    },

    onEdit(target) {
        const list = target.closest('[data-list]')?.dataset.list;
        // Rinominare una traccia o uno speaker cambia le anteprime delle sessioni.
        if (list === 'tracks' || list === 'speakers') refreshSessionPreviews();
        if (list === 'tracks') refreshTrackFilter();
    }
});

/* ==========================================================
   CONTORNO: CONTEGGI, FILTRI, SOTTO-SCHEDE
   ========================================================== */

const editionRoot = document.getElementById('ga-edition-editor');
const trackFilter = document.getElementById('ga-session-filter');
const speakerSearch = document.getElementById('ga-speaker-search');

function refreshCounts() {
    for (const badge of editionRoot.querySelectorAll('[data-ga-count]')) {
        badge.textContent = String(gaEditionEditor.rows(badge.dataset.gaCount).length);
    }
}

function refreshSessionPreviews() {
    for (const row of gaEditionEditor.rows('sessions')) {
        gaEditionEditor.refreshPreview(row);
    }
}

function refreshTrackFilter() {
    const selected = trackFilter.value;
    trackFilter.replaceChildren(new Option('Tutte', ''), new Option('Senza traccia', '-'));
    for (const track of currentTracks()) trackFilter.add(new Option(track.name || track.id, track.id));
    trackFilter.value = [...trackFilter.options].some((option) => option.value === selected) ? selected : '';
    applyFilters();
}

function applyFilters() {
    const track = trackFilter.value;
    for (const row of gaEditionEditor.rows('sessions')) {
        const own = gaEditionEditor.value(row, 'trackId');
        row.hidden = track === '' ? false : track === '-' ? own !== '' : own !== track;
    }

    const query = speakerSearch.value.trim().toLowerCase();
    for (const row of gaEditionEditor.rows('speakers')) {
        const text = `${gaEditionEditor.value(row, 'name')} ${gaEditionEditor.value(row, 'tagline')} ${gaEditionEditor.value(row, 'company')}`.toLowerCase();
        row.hidden = query !== '' && !text.includes(query);
    }
}

/** Quante sessioni tiene ogni speaker: uno a zero e probabilmente un refuso. */
function refreshSpeakerUsage() {
    const usage = new Map();
    for (const row of gaEditionEditor.rows('sessions')) {
        for (const id of selectedSpeakers(row)) usage.set(id, (usage.get(id) ?? 0) + 1);
    }
    for (const row of gaEditionEditor.rows('speakers')) {
        const count = usage.get(gaEditionEditor.value(row, 'id')) ?? 0;
        const flag = row.querySelector('[data-preview="sessions"]');
        flag.hidden = false;
        flag.textContent = count === 1 ? '1 sessione' : `${count} sessioni`;
        flag.classList.toggle('editor-flag-muted', count > 0);
    }
}

function afterContentChange() {
    refreshCounts();
    refreshTrackFilter();
    refreshSpeakerUsage();
}

// Righe aggiunte o tolte da qualunque parte (bottoni, import, upload). Si
// osservano solo i figli diretti delle liste: il resto del sottoalbero cambia
// anche per mano di afterContentChange, e osservarlo sarebbe un giro infinito.
const contentObserver = new MutationObserver(() => afterContentChange());
for (const list of editionRoot.querySelectorAll('[data-list]')) {
    contentObserver.observe(list, { childList: true });
}

trackFilter.addEventListener('change', applyFilters);
speakerSearch.addEventListener('input', applyFilters);

// Aprendo una sessione, tracce e speaker si rileggono: nel frattempo possono
// esserne stati aggiunti.
editionRoot.addEventListener('toggle', (event) => {
    const row = event.target.closest?.('[data-list="sessions"] .editor-row');
    if (row && event.target.open) refreshSessionReferences(row);
}, true);

editionRoot.addEventListener('change', (event) => {
    if (!event.target.matches('[data-speaker-choice]')) return;
    const row = event.target.closest('.editor-row');
    const chosen = [...row.querySelectorAll('[data-speaker-choice]:checked')].map((input) => input.value);
    row.dataset.speakerIds = JSON.stringify(chosen);
    gaEditionEditor.refreshPreview(row);
    gaEditionEditor.markDirty();
    refreshSpeakerUsage();
});

editionRoot.addEventListener('input', (event) => {
    if (!event.target.matches('.ga-choices-search')) return;
    const query = event.target.value.trim().toLowerCase();
    for (const label of event.target.closest('.ga-choices').querySelectorAll('.ga-choice')) {
        label.hidden = query !== '' && !label.textContent.toLowerCase().includes(query);
    }
});

// Sotto-schede.
const subtabs = [...editionRoot.querySelectorAll('.ga-subtab')];
function selectSection(tab) {
    for (const other of subtabs) {
        const selected = other === tab;
        other.setAttribute('aria-selected', String(selected));
        other.tabIndex = selected ? 0 : -1;
        editionRoot.querySelector(`[data-ga-panel="${other.dataset.gaSection}"]`).hidden = !selected;
    }
}
for (const tab of subtabs) {
    tab.addEventListener('click', () => selectSection(tab));
    tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = subtabs[(subtabs.indexOf(tab) + step + subtabs.length) % subtabs.length];
        next.focus();
        selectSection(next);
    });
}

/* ==========================================================
   SCELTA DELL'ANNO
   ========================================================== */

const yearSelect = document.getElementById('ga-year');
const editionLoading = document.getElementById('ga-edition-loading');
const editionNone = document.getElementById('ga-edition-none');
const sessionizeInput = document.getElementById('ga-sessionize-id');

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
   IMPORT DA SESSIONIZE
   ========================================================== */

const sessionizeBox = document.getElementById('ga-sessionize');
const sessionizeButton = document.getElementById('ga-sessionize-btn');
const sessionizeError = document.getElementById('ga-sessionize-error');

function sessionizeMessage(error) {
    switch (error.payload?.error) {
        case 'invalid-sessionize-id':
            return 'Non sembra un id Sessionize: sono 8 caratteri circa, lettere e cifre, come dtzcs2li.';
        case 'upstream-not-found':
            return 'Sessionize dice che quell’endpoint non esiste. Controlla l’id in API / Embed.';
        case 'nothing-to-import':
            return 'L’endpoint risponde ma non contiene sessioni ne speaker. L’agenda e gia pubblicata su Sessionize?';
        case 'upstream-timeout':
            return 'Sessionize non ha risposto in tempo. Riprova tra poco.';
        case 'upstream-unknown-format':
            return 'Sessionize ha risposto in un formato che non conosco. Prova con un endpoint di tipo JSON o Embed.';
        default:
            break;
    }
    if (error.status === 403) return 'Il tuo account non ha il ruolo admin: l’importazione e stata rifiutata.';
    if (error.status >= 500) return 'Non riesco a leggere da Sessionize in questo momento. Riprova tra poco.';
    return `Il server ha rifiutato l’importazione (${error.status}).`;
}

const compactObject = (object) => Object.fromEntries(
    Object.entries(object ?? {}).filter(([, value]) => value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0))
);

/**
 * Fonde le righe importate con quelle in pagina, per id. I campi che
 * Sessionize non conosce (colore della traccia, azienda, badge e link scritti
 * a mano) restano quelli dell'admin.
 */
function merge(name, items, combine) {
    const byId = new Map(gaEditionEditor.rows(name).map((row) => [gaEditionEditor.value(row, 'id'), row]));
    let added = 0;
    let updated = 0;

    for (const item of items) {
        const existing = byId.get(item.id);
        if (existing) {
            gaEditionEditor.refill(existing, combine(item, compactObject(gaEditionEditor.readRow(existing))), { open: false });
            updated += 1;
        } else {
            const row = gaEditionEditor.add(name, item, { open: false });
            // L'id viene da Sessionize: non deve riscriversi se poi si ritocca il titolo.
            row.dataset.new = 'false';
            added += 1;
        }
    }
    return { added, updated };
}

function sortSessionRows() {
    const rows = gaEditionEditor.rows('sessions');
    const key = (row) => fromLocalInput(gaEditionEditor.value(row, 'start')) || '9999';
    const sorted = [...rows].sort((a, b) => key(a).localeCompare(key(b)));
    rows[0]?.parentElement.append(...sorted);
}

async function runSessionizeImport() {
    sessionizeError.hidden = true;
    gaEditionEditor.clearAlert();

    const sessionizeId = sessionizeInput.value.trim();
    if (!sessionizeId) {
        sessionizeError.textContent = 'Scrivi l’id dell’endpoint Sessionize.';
        sessionizeError.hidden = false;
        sessionizeInput.focus();
        return;
    }

    sessionizeBox.classList.add('is-busy');
    sessionizeButton.disabled = true;
    sessionizeButton.querySelector('[data-import-label]').textContent = 'Leggo Sessionize...';

    try {
        const { payload } = await apiPost('/api/global-azure/sessionize', { sessionizeId });

        const tracks = merge('tracks', payload.tracks ?? [], (item, current) => ({ ...current, ...item, color: current.color ?? item.color }));
        const speakers = merge('speakers', payload.speakers ?? [], (item, current) => ({
            ...current,
            ...item,
            company: current.company ?? item.company,
            badges: current.badges ?? item.badges,
            links: { ...(item.links ?? {}), ...compactObject(current.links) }
        }));
        const sessions = merge('sessions', payload.sessions ?? [], (item, current) => ({ ...current, ...item }));
        sortSessionRows();
        afterContentChange();

        // L'id usato per l'import torna nella scheda dell'edizione, se manca.
        const indexRow = indexRowFor(year);
        if (indexRow && !gaIndexEditor.value(indexRow, 'sessionizeId')) {
            gaIndexEditor.field(indexRow, 'sessionizeId').value = sessionizeId;
            gaIndexEditor.markDirty();
        }

        const parts = [
            `${sessions.added + sessions.updated} sessioni (${sessions.added} nuove)`,
            `${speakers.added + speakers.updated} speaker (${speakers.added} nuovi)`,
            `${tracks.added + tracks.updated} tracce`
        ];
        gaEditionEditor.setAlert(
            'success',
            `Da Sessionize: ${parts.join(', ')}. Controlla e poi premi Salva e pubblica.`
        );
    } catch (error) {
        if (error instanceof SessionExpiredError) {
            gaEditionEditor.handleError(error);
        } else if (error instanceof ApiError) {
            sessionizeError.textContent = sessionizeMessage(error);
            sessionizeError.hidden = false;
        } else {
            console.error('[admin] import Sessionize fallito', error);
            sessionizeError.textContent = 'Importazione non riuscita. Controlla la connessione e riprova.';
            sessionizeError.hidden = false;
        }
    } finally {
        sessionizeBox.classList.remove('is-busy');
        sessionizeButton.disabled = false;
        sessionizeButton.querySelector('[data-import-label]').textContent = 'Importa';
    }
}

sessionizeButton.addEventListener('click', runSessionizeImport);
sessionizeInput.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    runSessionizeImport();
});

/* ==========================================================
   FOTO: CARICAMENTO MULTIPLO
   ========================================================== */

const drop = document.getElementById('ga-photo-drop');
const photoInput = document.getElementById('ga-photo-input');
const progress = document.getElementById('ga-photo-progress');
const progressBar = document.getElementById('ga-photo-progress-bar');
const progressText = document.getElementById('ga-photo-progress-text');

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PARALLEL_UPLOADS = 2;

function photoId(base, taken) {
    const stem = `p-${slugify(base).slice(0, 36) || 'foto'}`;
    let id = stem;
    for (let counter = 2; taken.has(id); counter += 1) id = `${stem}-${counter}`;
    taken.add(id);
    return id;
}

async function uploadPhotos(fileList) {
    const files = [...fileList].filter((file) => PHOTO_TYPES.includes(file.type));
    const skipped = fileList.length - files.length;
    if (files.length === 0) {
        gaEditionEditor.setAlert('error', 'Nessuna foto da caricare: servono file JPEG, PNG o WebP.');
        return;
    }

    const taken = new Set(gaEditionEditor.rows('photos').map((row) => gaEditionEditor.value(row, 'id')));
    const failures = [];
    let done = 0;
    let stopped = false;

    progress.hidden = false;
    drop.classList.add('is-busy');
    const report = () => {
        progressBar.style.width = `${Math.round((done / files.length) * 100)}%`;
        progressText.textContent = `Caricate ${done} di ${files.length}${failures.length ? `, ${failures.length} non riuscite` : ''}...`;
    };
    report();

    // Le righe si prenotano nell'ordine dei file: con due caricamenti in
    // parallelo, altrimenti, la galleria uscirebbe mescolata.
    const slots = files.map(() => null);
    let next = 0;

    async function worker() {
        while (!stopped && next < files.length) {
            const index = next;
            next += 1;
            const file = files[index];
            const base = file.name.replace(/\.[^.]+$/, '');
            try {
                const { large, thumb } = await resizePhoto(file);
                const url = await uploadImage(large.blob, 'photo', { filename: `${year}-${base}.${extensionOf(large.blob)}` });
                const thumbUrl = await uploadImage(thumb.blob, 'photo', { filename: `${year}-${base}-thumb.${extensionOf(thumb.blob)}` });
                slots[index] = { id: photoId(base, taken), url, thumbUrl, width: large.width, height: large.height };
            } catch (error) {
                if (error instanceof SessionExpiredError) {
                    stopped = true;
                    gaEditionEditor.handleError(error);
                    return;
                }
                failures.push(`${file.name}: ${error.message ?? 'non leggibile come immagine'}`);
            }
            done += 1;
            report();
        }
    }

    try {
        await Promise.all(Array.from({ length: PARALLEL_UPLOADS }, worker));
    } finally {
        for (const photo of slots) if (photo) gaEditionEditor.add('photos', photo, { open: false });
        drop.classList.remove('is-busy');
        progress.hidden = true;
        photoInput.value = '';
    }

    const added = slots.filter(Boolean).length;
    if (stopped) return;
    if (failures.length > 0 || skipped > 0) {
        gaEditionEditor.setAlert(
            'warn',
            `Caricate ${added} foto su ${fileList.length}. Ricordati di salvare.`,
            { details: [...failures, ...(skipped ? [`${skipped} file ignorati: non sono JPEG, PNG o WebP`] : [])] }
        );
    } else {
        gaEditionEditor.setAlert('success', `Caricate ${added} foto. Aggiungi le didascalie che vuoi, poi premi Salva e pubblica.`);
    }
}

photoInput.addEventListener('change', () => {
    if (photoInput.files?.length) uploadPhotos(photoInput.files);
});
for (const type of ['dragenter', 'dragover']) {
    drop.addEventListener(type, (event) => {
        event.preventDefault();
        drop.classList.add('is-over');
    });
}
for (const type of ['dragleave', 'drop']) {
    drop.addEventListener(type, () => drop.classList.remove('is-over'));
}
drop.addEventListener('drop', (event) => {
    event.preventDefault();
    if (event.dataTransfer?.files?.length) uploadPhotos(event.dataTransfer.files);
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
