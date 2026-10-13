import { createEditorCore } from './editor-core.js';
import { apiPost, ApiError, SessionExpiredError } from './api.js';
import { uploadImage } from './upload.js';
import { resizePhoto, extensionOf } from './photo-resize.js';
import { toLocalInput, fromLocalInput } from './events-editor.js';

/**
 * L'editor dei contenuti di un evento: tracce, speaker, sessioni e foto, con
 * l'import da Sessionize, il caricamento multiplo delle foto, i filtri e le
 * sotto-schede intorno.
 *
 * Lo usano due pannelli: i contenuti di un'edizione di Global Azure (che ha
 * anche gli sponsor) e le pagine degli eventi speciali. Ciascuno ha il suo
 * markup in admin/index.html; gli elementi di contorno si trovano per id, con
 * il prefisso del pannello: `${prefix}-session-filter`, `${prefix}-photo-drop`...
 * I template delle righe sono gli stessi per tutti e due.
 *
 * @param {object} options
 * @param {string} options.prefix prefisso degli id di contorno (`ga`, `ep`)
 * @param {object} options.ids gli id che vuole createEditorCore
 * @param {() => string} options.endpoint il documento aperto
 * @param {object} [options.extraLists] liste in piu, per esempio gli sponsor
 * @param {(data: object) => void} [options.fillExtra] campi del documento fuori dalle liste
 * @param {() => object} [options.collectExtra]
 * @param {() => string} options.uploadPrefix l'inizio del nome dei file delle foto
 * @param {(sessionizeId: string) => void} [options.onSessionizeImported]
 */
export function createContentEditor({
    prefix, ids, endpoint, extraLists = {}, fillExtra, collectExtra, uploadPrefix, onSessionizeImported
}) {
    const byId = (name) => document.getElementById(`${prefix}-${name}`);
    const listNames = ['tracks', 'speakers', 'sessions', 'photos', ...Object.keys(extraLists)];

    /** Tracce e speaker come li vede adesso il form, non come erano al caricamento. */
    function currentTracks() {
        return editor.rows('tracks')
            .map((row) => ({
                id: editor.value(row, 'id'),
                name: editor.value(row, 'name'),
                color: editor.value(row, 'color')
            }))
            .filter((track) => track.id);
    }

    function currentSpeakers() {
        return editor.rows('speakers')
            .map((row) => ({ id: editor.value(row, 'id'), name: editor.value(row, 'name') }))
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

    const editor = createEditorCore({
        endpoint,
        ids,

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
                    const last = editor.rows('sessions').at(-1);
                    const end = last ? editor.value(last, 'end') : '';
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
            ...extraLists
        },

        fill(data, { setList }) {
            // L'ordine conta: le sessioni leggono tracce e speaker gia in pagina.
            for (const name of listNames) setList(name, data[name]);
            fillExtra?.(data);
            afterContentChange();
        },

        collect({ readList }) {
            return {
                version: 1,
                ...Object.fromEntries(listNames.map((name) => [name, readList(name)])),
                ...collectExtra?.()
            };
        },

        onEdit(target) {
            const list = target.closest('[data-list]')?.dataset.list;
            // Rinominare una traccia o uno speaker cambia le anteprime delle sessioni.
            if (list === 'tracks' || list === 'speakers') refreshSessionPreviews();
            if (list === 'tracks') refreshTrackFilter();
        }
    });

    /* ----- contorno: conteggi, filtri, sotto-schede ----- */

    const root = document.getElementById(ids.editor);
    const trackFilter = byId('session-filter');
    const speakerSearch = byId('speaker-search');

    function refreshCounts() {
        for (const badge of root.querySelectorAll('[data-ga-count]')) {
            badge.textContent = String(editor.rows(badge.dataset.gaCount).length);
        }
    }

    function refreshSessionPreviews() {
        for (const row of editor.rows('sessions')) {
            editor.refreshPreview(row);
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
        for (const row of editor.rows('sessions')) {
            const own = editor.value(row, 'trackId');
            row.hidden = track === '' ? false : track === '-' ? own !== '' : own !== track;
        }

        const query = speakerSearch.value.trim().toLowerCase();
        for (const row of editor.rows('speakers')) {
            const text = `${editor.value(row, 'name')} ${editor.value(row, 'tagline')} ${editor.value(row, 'company')}`.toLowerCase();
            row.hidden = query !== '' && !text.includes(query);
        }
    }

    /** Quante sessioni tiene ogni speaker: uno a zero e probabilmente un refuso. */
    function refreshSpeakerUsage() {
        const usage = new Map();
        for (const row of editor.rows('sessions')) {
            for (const id of selectedSpeakers(row)) usage.set(id, (usage.get(id) ?? 0) + 1);
        }
        for (const row of editor.rows('speakers')) {
            const count = usage.get(editor.value(row, 'id')) ?? 0;
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
    for (const list of root.querySelectorAll('[data-list]')) {
        contentObserver.observe(list, { childList: true });
    }

    trackFilter.addEventListener('change', applyFilters);
    speakerSearch.addEventListener('input', applyFilters);

    // Aprendo una sessione, tracce e speaker si rileggono: nel frattempo possono
    // esserne stati aggiunti.
    root.addEventListener('toggle', (event) => {
        const row = event.target.closest?.('[data-list="sessions"] .editor-row');
        if (row && event.target.open) refreshSessionReferences(row);
    }, true);

    root.addEventListener('change', (event) => {
        if (!event.target.matches('[data-speaker-choice]')) return;
        const row = event.target.closest('.editor-row');
        const chosen = [...row.querySelectorAll('[data-speaker-choice]:checked')].map((input) => input.value);
        row.dataset.speakerIds = JSON.stringify(chosen);
        editor.refreshPreview(row);
        editor.markDirty();
        refreshSpeakerUsage();
    });

    root.addEventListener('input', (event) => {
        if (!event.target.matches('.ga-choices-search')) return;
        const query = event.target.value.trim().toLowerCase();
        for (const label of event.target.closest('.ga-choices').querySelectorAll('.ga-choice')) {
            label.hidden = query !== '' && !label.textContent.toLowerCase().includes(query);
        }
    });

    // Sotto-schede.
    const subtabs = [...root.querySelectorAll('.ga-subtab')];
    function selectSection(tab) {
        for (const other of subtabs) {
            const selected = other === tab;
            other.setAttribute('aria-selected', String(selected));
            other.tabIndex = selected ? 0 : -1;
            root.querySelector(`[data-ga-panel="${other.dataset.gaSection}"]`).hidden = !selected;
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

    /* ----- import da Sessionize ----- */

    const sessionizeBox = byId('sessionize');
    const sessionizeInput = byId('sessionize-id');
    const sessionizeButton = byId('sessionize-btn');
    const sessionizeError = byId('sessionize-error');

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
        const byId = new Map(editor.rows(name).map((row) => [editor.value(row, 'id'), row]));
        let added = 0;
        let updated = 0;

        for (const item of items) {
            const existing = byId.get(item.id);
            if (existing) {
                editor.refill(existing, combine(item, compactObject(editor.readRow(existing))), { open: false });
                updated += 1;
            } else {
                const row = editor.add(name, item, { open: false });
                // L'id viene da Sessionize: non deve riscriversi se poi si ritocca il titolo.
                row.dataset.new = 'false';
                added += 1;
            }
        }
        return { added, updated };
    }

    function sortSessionRows() {
        const rows = editor.rows('sessions');
        const key = (row) => fromLocalInput(editor.value(row, 'start')) || '9999';
        const sorted = [...rows].sort((a, b) => key(a).localeCompare(key(b)));
        rows[0]?.parentElement.append(...sorted);
    }

    async function runSessionizeImport() {
        sessionizeError.hidden = true;
        editor.clearAlert();

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

            onSessionizeImported?.(sessionizeId);

            const parts = [
                `${sessions.added + sessions.updated} sessioni (${sessions.added} nuove)`,
                `${speakers.added + speakers.updated} speaker (${speakers.added} nuovi)`,
                `${tracks.added + tracks.updated} tracce`
            ];
            editor.setAlert(
                'success',
                `Da Sessionize: ${parts.join(', ')}. Controlla e poi premi Salva e pubblica.`
            );
        } catch (error) {
            if (error instanceof SessionExpiredError) {
                editor.handleError(error);
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

    /* ----- foto: caricamento multiplo ----- */

    const drop = byId('photo-drop');
    const photoInput = byId('photo-input');
    const progress = byId('photo-progress');
    const progressBar = byId('photo-progress-bar');
    const progressText = byId('photo-progress-text');

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
            editor.setAlert('error', 'Nessuna foto da caricare: servono file JPEG, PNG o WebP.');
            return;
        }

        const taken = new Set(editor.rows('photos').map((row) => editor.value(row, 'id')));
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
                    const url = await uploadImage(large.blob, 'photo', { filename: `${uploadPrefix()}-${base}.${extensionOf(large.blob)}` });
                    const thumbUrl = await uploadImage(thumb.blob, 'photo', { filename: `${uploadPrefix()}-${base}-thumb.${extensionOf(thumb.blob)}` });
                    slots[index] = { id: photoId(base, taken), url, thumbUrl, width: large.width, height: large.height };
                } catch (error) {
                    if (error instanceof SessionExpiredError) {
                        stopped = true;
                        editor.handleError(error);
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
            for (const photo of slots) if (photo) editor.add('photos', photo, { open: false });
            drop.classList.remove('is-busy');
            progress.hidden = true;
            photoInput.value = '';
        }

        const added = slots.filter(Boolean).length;
        if (stopped) return;
        if (failures.length > 0 || skipped > 0) {
            editor.setAlert(
                'warn',
                `Caricate ${added} foto su ${fileList.length}. Ricordati di salvare.`,
                { details: [...failures, ...(skipped ? [`${skipped} file ignorati: non sono JPEG, PNG o WebP`] : [])] }
            );
        } else {
            editor.setAlert('success', `Caricate ${added} foto. Aggiungi le didascalie che vuoi, poi premi Salva e pubblica.`);
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

    return { editor, sessionizeInput };
}

/* ==========================================================
   AIUTI
   ========================================================== */

const PLACEHOLDER_AVATAR = '/assets/img/placeholder-avatar.svg';

const KIND_LABEL = { keynote: 'keynote', plenary: 'plenaria', service: 'servizio' };

const number = (raw) => (raw === '' ? undefined : Number(raw));

function formatClock(local) {
    const date = new Date(local);
    if (!local || Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
}

function slugify(text) {
    return String(text ?? '')
        .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
}

const PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const PARALLEL_UPLOADS = 2;
