import { apiGet, apiPut, ApiError, SessionExpiredError } from './api.js';
import { uploadImage } from './upload.js';

/**
 * La macchina dietro gli editor dell'admin.
 *
 * Team e sponsor sono la stessa cosa con campi diversi: una lista di schede
 * riordinabili, salvata tutta insieme con l'ETag. Tenerne due copie vorrebbe
 * dire correggere ogni bug due volte e, prima o poi, correggerlo in una sola —
 * ed e la gestione del conflitto quella che si perderebbe per prima.
 *
 * Quattro cose che guidano il disegno:
 *
 * 1. NIENTE HTML CONCATENATO CON I DATI. Le schede si clonano da un <template>
 *    e si riempiono via .value / .textContent. Senza escaping manuale non c'e
 *    escaping dimenticato.
 *
 * 2. L'ORDINE E LA POSIZIONE. `order` non e un campo da compilare: si riordina
 *    con le frecce e al salvataggio si rinumera 10, 20, 30. Un campo numerico
 *    libero sarebbe una seconda fonte di verita in disaccordo con quello che
 *    l'admin vede.
 *
 * 3. NON SI PERDE NIENTE SENZA UN CLICK. Il 409 (qualcun altro ha salvato) non
 *    ricarica e non sovrascrive da solo: tiene le modifiche locali nel form e
 *    chiede cosa fare. Stessa regola a sessione scaduta, dove un reload
 *    automatico butterebbe via il lavoro appena fatto.
 *
 * 4. GLI ERRORI VANNO ACCANTO AL CAMPO. Il server risponde con dei path tipo
 *    `members[3].link.url`: qui si traducono in "questa scheda, questo campo".
 *
 * Cosa deve fornire chi la usa: gli id degli elementi in pagina, l'endpoint, la
 * chiave della collezione e tre funzioni che sanno di quali campi si tratta —
 * `fill`, `collect`, `preview`. Tutto il resto e qui.
 *
 * Due convenzioni sono date per buone perche valgono per entrambi i documenti:
 * ogni elemento ha un campo `id` (slug) e un campo `name` (etichetta umana).
 */

const FIELD = (name) => `[data-field="${name}"]`;

export function createCollectionEditor(shape) {
    const el = Object.fromEntries(
        Object.entries(shape.ids).map(([key, id]) => [key, document.getElementById(id)])
    );

    /** ETag del documento caricato: e il biglietto da riconsegnare in If-Match. */
    let etag = null;
    let dirty = false;
    let lastSavedAt = null;
    let busy = false;

    /* ==========================================================
       STATO E AVVISI
       ========================================================== */

    const time = (value) => {
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime())
            ? null
            : date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    };

    function refreshState() {
        if (busy) {
            el.state.textContent = 'Salvataggio in corso...';
        } else if (dirty) {
            el.state.textContent = 'Modifiche non salvate';
        } else if (lastSavedAt) {
            el.state.textContent = `Salvato alle ${time(lastSavedAt)}`;
        } else {
            el.state.textContent = '';
        }
        el.state.dataset.dirty = String(dirty);
    }

    function markDirty() {
        dirty = true;
        refreshState();
    }

    function setBusy(value) {
        busy = value;
        for (const button of [el.save, el.add, el.reload]) button.disabled = value;
        refreshState();
    }

    function clearAlert() {
        el.alert.hidden = true;
        el.alert.replaceChildren();
    }

    /** @param {{label: string, run: () => void}[]} actions */
    function setAlert(kind, message, { actions = [], details = [] } = {}) {
        el.alert.className = `editor-alert editor-alert-${kind}`;
        el.alert.replaceChildren();

        const paragraph = document.createElement('p');
        paragraph.textContent = message;
        el.alert.append(paragraph);

        if (details.length > 0) {
            const list = document.createElement('ul');
            for (const detail of details) {
                const item = document.createElement('li');
                item.textContent = detail;
                list.append(item);
            }
            el.alert.append(list);
        }

        if (actions.length > 0) {
            const row = document.createElement('div');
            row.className = 'editor-alert-actions';
            for (const action of actions) {
                const button = document.createElement('button');
                button.type = 'button';
                button.className = 'editor-btn';
                button.textContent = action.label;
                button.addEventListener('click', action.run);
                row.append(button);
            }
            el.alert.append(row);
        }

        el.alert.hidden = false;
        el.alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    /* ==========================================================
       SCHEDE
       ========================================================== */

    const rows = () => [...el.list.querySelectorAll('.editor-row')];
    const field = (row, name) => row.querySelector(FIELD(name));
    const preview = (row, name) => row.querySelector(`[data-preview="${name}"]`);
    const value = (row, name) => field(row, name).value.trim();

    /**
     * Un valore che il <select> non conosce verrebbe silenziosamente sostituito
     * da quello vuoto, cioe cancellato al primo salvataggio. Meglio aggiungerlo
     * come opzione segnalata e lasciare che sia l'admin a decidere.
     */
    function setSelect(select, selected) {
        select.value = selected ?? '';
        if (selected && select.value !== selected) {
            select.add(new Option(`${selected} (valore non previsto)`, selected, true, true));
        }
    }

    function slugify(text) {
        return text
            .normalize('NFD').replace(/[̀-ͯ]/g, '')
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 49);
    }

    /** Passato alle funzioni della forma, cosi non ripetono le query. */
    const tools = { field, preview, value, setSelect };

    function refreshPreview(row) {
        shape.preview(row, tools);
    }

    function buildRow(item = {}, { isNew = false } = {}) {
        const row = el.template.content.firstElementChild.cloneNode(true);
        row.dataset.new = String(isNew);

        shape.fill(row, item, tools);

        // Un'immagine irraggiungibile non deve lasciare un'icona rotta in lista.
        for (const thumb of row.querySelectorAll('[data-preview-fallback]')) {
            thumb.addEventListener('error', (event) => {
                event.target.setAttribute('src', event.target.dataset.previewFallback);
            });
        }

        refreshPreview(row);
        if (isNew) row.querySelector('.editor-details').open = true;

        return row;
    }

    function render(items) {
        el.list.replaceChildren(...items.map((item) => buildRow(item)));
        el.empty.hidden = items.length > 0;
    }

    /**
     * Le schede nell'ordine in cui si vedono diventano order 10, 20, 30...
     * I campi vuoti si mandano cosi come sono: e il server a decidere quali
     * sono opzionali, qui non si indovina.
     */
    function collect() {
        return rows().map((row, index) => ({
            ...shape.collect(row, tools),
            order: (index + 1) * 10
        }));
    }

    /* ==========================================================
       ERRORI DI VALIDAZIONE
       ========================================================== */

    function clearFieldErrors() {
        for (const slot of el.list.querySelectorAll('.field-error')) {
            slot.hidden = true;
            slot.textContent = '';
        }
        for (const input of el.list.querySelectorAll('[aria-invalid]')) {
            input.removeAttribute('aria-invalid');
        }
    }

    /** `members[3].link.url` -> { index: 3, name: 'link.url' } */
    function parseIssuePath(path) {
        const match = new RegExp(`^${shape.key}\\[(\\d+)\\]\\.(.+)$`).exec(path ?? '');
        return match ? { index: Number(match[1]), name: match[2] } : null;
    }

    function showIssues(issues) {
        clearFieldErrors();

        const orphans = [];
        let first = null;
        const all = rows();

        for (const issue of issues) {
            const parsed = parseIssuePath(issue.path);
            const row = parsed ? all[parsed.index] : null;
            const slot = row?.querySelector(`[data-error-for="${parsed.name}"]`);

            if (!slot) {
                orphans.push(issue.path ? `${issue.path}: ${issue.message}` : issue.message);
                continue;
            }

            slot.textContent = issue.message;
            slot.hidden = false;
            field(row, parsed.name)?.setAttribute('aria-invalid', 'true');

            if (!first) first = { row, input: field(row, parsed.name) };
        }

        setAlert(
            'error',
            issues.length === 1
                ? 'C’e un campo da correggere, e segnalato qui sotto.'
                : `Ci sono ${issues.length} campi da correggere, sono segnalati qui sotto.`,
            { details: orphans }
        );

        if (first) {
            first.row.querySelector('.editor-details').open = true;
            first.input?.focus();
        }
    }

    /* ==========================================================
       CARICAMENTO E SALVATAGGIO
       ========================================================== */

    async function load() {
        const { payload } = await apiGet(shape.endpoint);
        etag = payload.etag;
        render(payload.data?.[shape.key] ?? []);
        dirty = false;
        lastSavedAt = null;
        clearAlert();
        clearFieldErrors();
        refreshState();
    }

    async function save() {
        clearAlert();
        clearFieldErrors();
        setBusy(true);

        try {
            const body = { data: { version: 1, [shape.key]: collect() } };
            const { payload } = await apiPut(shape.endpoint, body, etag);
            etag = payload.etag;
            dirty = false;
            lastSavedAt = new Date();

            if (payload.published === false) {
                setAlert(
                    'warn',
                    'Salvato, ma la copia pubblica non e stata aggiornata: il sito mostra ancora i dati di prima. Riprova a salvare tra poco.'
                );
            }
        } catch (error) {
            handleSaveError(error);
        } finally {
            setBusy(false);
        }
    }

    function handleSaveError(error) {
        if (error instanceof SessionExpiredError) {
            // Niente reload automatico: le modifiche sono ancora solo nel form.
            setAlert(
                'warn',
                'La sessione e scaduta. Rientra in un’altra scheda, poi torna qui e salva di nuovo: quello che hai scritto e ancora qui.',
                { actions: [{ label: 'Apri il login', run: () => window.open('/.auth/login/aad', '_blank', 'noopener') }] }
            );
            return;
        }

        if (!(error instanceof ApiError)) {
            console.error(`[admin] salvataggio di ${shape.endpoint} fallito`, error);
            setAlert('error', 'Non sono riuscito a salvare. Controlla la connessione e riprova.');
            return;
        }

        if (error.status === 400 && Array.isArray(error.payload.issues)) {
            showIssues(error.payload.issues);
            return;
        }
        if (error.status === 409) {
            showConflict(error.payload);
            return;
        }
        if (error.status === 403) {
            setAlert('error', 'Il tuo account non ha il ruolo admin: il salvataggio e stato rifiutato.');
            return;
        }

        console.error(`[admin] salvataggio di ${shape.endpoint} fallito`, error);
        setAlert('error', `Il server ha rifiutato il salvataggio (${error.status}). Riprova tra poco.`);
    }

    /**
     * 409: il documento sul server e cambiato sotto le mani.
     *
     * Il form resta com'e. Si mostra chi ha salvato e quando, e si lascia
     * scegliere: in nessuno dei due casi qualcosa sparisce senza che sia stato
     * chiesto.
     */
    function showConflict(payload) {
        const who = payload.data?.updatedBy ?? 'qualcun altro';
        const when = time(payload.data?.updatedAt);

        setAlert(
            'warn',
            `Ha salvato ${who}${when ? ` alle ${when}` : ''} mentre stavi modificando. Le tue modifiche sono ancora in pagina: scegli quale versione tenere.`,
            {
                actions: [
                    {
                        label: 'Tieni le mie e sovrascrivi',
                        run: () => {
                            // Si riparte dall'ETag del server: la nostra
                            // scrittura adesso e consapevole, non piu cieca.
                            etag = payload.etag;
                            save();
                        }
                    },
                    {
                        label: 'Scarta le mie e riparti dal server',
                        run: () => {
                            etag = payload.etag;
                            render(payload.data?.[shape.key] ?? []);
                            dirty = false;
                            clearAlert();
                            refreshState();
                        }
                    }
                ]
            }
        );
    }

    /* ==========================================================
       CARICAMENTO IMMAGINI
       ========================================================== */

    /**
     * Carica il file scelto e ne scrive la URL nel campo indicato da
     * `data-upload-target`.
     *
     * L'elemento NON viene salvato: il file e sul blob, ma nessun JSON lo cita
     * finche non si preme Salva. Se si cambia idea e si chiude la pagina resta
     * un blob orfano da qualche frazione di centesimo — molto meglio di un
     * salvataggio non richiesto del resto della scheda.
     */
    async function uploadInto(row, input) {
        const file = input.files?.[0];
        if (!file) return;

        const target = input.dataset.uploadTarget;
        const slot = row.querySelector(`[data-error-for="${target}"]`);
        const label = input.closest('.upload-btn');
        const text = label.querySelector('[data-upload-label]');
        const original = text.textContent;

        if (slot) slot.hidden = true;
        label.classList.add('is-busy');
        text.textContent = 'Carico...';

        try {
            field(row, target).value = await uploadImage(file, input.dataset.upload);
            refreshPreview(row);
            markDirty();
        } catch (error) {
            if (error instanceof SessionExpiredError) {
                handleSaveError(error);
            } else if (slot) {
                slot.textContent = error.message;
                slot.hidden = false;
            } else {
                setAlert('error', error.message);
            }
        } finally {
            label.classList.remove('is-busy');
            text.textContent = original;
            // Senza questo, riselezionare lo stesso file non scatena un altro
            // change e il secondo tentativo sembrerebbe non fare niente.
            input.value = '';
        }
    }

    /* ==========================================================
       EVENTI
       ========================================================== */

    function move(row, step) {
        const all = rows();
        const target = all[all.indexOf(row) + step];
        if (!target) return;

        if (step < 0) target.before(row);
        else target.after(row);

        row.querySelector(`[data-action="${step < 0 ? 'up' : 'down'}"]`).focus();
        markDirty();
    }

    el.list.addEventListener('input', (event) => {
        const row = event.target.closest('.editor-row');
        if (!row) return;

        // L'identificativo si genera dal nome finche l'elemento e nuovo e
        // nessuno l'ha toccato a mano: su uno gia salvato cambiarlo da solo
        // sarebbe una modifica non richiesta.
        if (event.target.dataset.field === 'name' && row.dataset.new === 'true') {
            const id = field(row, 'id');
            if (id.dataset.touched !== 'true') id.value = slugify(event.target.value);
        }
        if (event.target.dataset.field === 'id') event.target.dataset.touched = 'true';

        refreshPreview(row);
        markDirty();
    });

    el.list.addEventListener('change', (event) => {
        const row = event.target.closest('.editor-row');
        if (!row) return;

        if (event.target.dataset.upload) {
            uploadInto(row, event.target);
            return;
        }

        refreshPreview(row);
        markDirty();
    });

    el.list.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button) return;

        const row = button.closest('.editor-row');
        const action = button.dataset.action;

        if (action === 'up') move(row, -1);
        if (action === 'down') move(row, 1);
        if (action === 'remove') {
            const name = value(row, 'name') || `questo ${shape.label}`;
            if (!confirm(`Elimino ${name}?\n\nSparisce dal sito al prossimo salvataggio.`)) return;
            row.remove();
            el.empty.hidden = rows().length > 0;
            markDirty();
        }
    });

    el.add.addEventListener('click', () => {
        const row = buildRow(shape.blank(), { isNew: true });
        el.list.append(row);
        el.empty.hidden = true;
        field(row, 'name').focus();
        markDirty();
    });

    el.save.addEventListener('click', () => save());

    el.reload.addEventListener('click', async () => {
        if (dirty && !confirm('Ricaricando perdi le modifiche non salvate. Procedo?')) return;
        setBusy(true);
        try {
            await load();
        } catch (error) {
            console.error(`[admin] ricaricamento di ${shape.endpoint} fallito`, error);
            setAlert('error', 'Non sono riuscito a rileggere i dati dal server.');
        } finally {
            setBusy(false);
        }
    });

    /* ==========================================================
       AVVIO
       ========================================================== */

    /** @param {boolean} canWrite false se la sessione non ha il ruolo admin. */
    async function init(canWrite = true) {
        try {
            await load();
        } catch (error) {
            el.loading.replaceChildren();
            const message = document.createElement('p');
            message.textContent = error instanceof SessionExpiredError
                ? 'La sessione e scaduta: ricarica la pagina per rientrare.'
                : 'Non sono riuscito a leggere i dati dal server.';
            el.loading.append(message);
            console.error(`[admin] caricamento di ${shape.endpoint} fallito`, error);
            return;
        }

        el.loading.hidden = true;
        el.editor.hidden = false;

        if (!canWrite) {
            el.save.disabled = true;
            el.save.title = 'Serve il ruolo admin per salvare';
        }
    }

    return { init, isDirty: () => dirty };
}
