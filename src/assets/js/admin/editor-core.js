import { apiGet, apiPut, ApiError, SessionExpiredError } from './api.js';
import { uploadImage } from './upload.js';

/**
 * Il nucleo degli editor dell'admin.
 *
 * Quattro documenti — team, sponsor, eventi, contenuti della home — e un solo
 * modo di gestirli: leggi con l'ETag, modifica, risalva tutto insieme. Cambia
 * solo quali campi ci sono dentro.
 *
 * QUATTRO REGOLE CHE VALGONO PER TUTTI
 *
 * 1. Niente HTML concatenato con i dati. Le righe si clonano da un <template> e
 *    si riempiono via .value / .textContent: senza escaping manuale non c'e
 *    escaping dimenticato.
 *
 * 2. Non si perde niente senza un click. Il 409 (qualcun altro ha salvato) non
 *    ricarica e non sovrascrive da solo: tiene le modifiche locali nel form e
 *    chiede cosa fare. Stessa regola a sessione scaduta.
 *
 * 3. Gli errori vanno accanto al campo. Il server risponde con path come
 *    `members[3].link.url` o `about.text`, e qui diventano "questa riga, questo
 *    campo" o "questo campo".
 *
 * 4. `order` non e un campo da compilare: dove serve si riordina con le frecce
 *    e si rinumera al salvataggio.
 *
 * CONVENZIONI NEL MARKUP, tutte generiche:
 *   [data-field="percorso"]     un campo; il percorso e quello dell'issue
 *   [data-error-for="percorso"] dove finisce il messaggio d'errore
 *   [data-list="nome"]          contenitore di righe, con data-template="idTpl"
 *   [data-empty="nome"]         mostrato quando quella lista e vuota
 *   [data-add="nome"]           bottone che aggiunge una riga a quella lista
 *   [data-action=up|down|remove] dentro una riga
 *   input[type=file][data-upload="avatar|sponsor|site|event"]
 *                               carica e scrive nel [data-field] dello stesso .field
 */

export function createEditorCore(shape) {
    const el = Object.fromEntries(
        Object.entries(shape.ids).map(([key, id]) => [key, document.getElementById(id)])
    );

    /** ETag del documento caricato: e il biglietto da riconsegnare in If-Match. */
    let etag = null;
    let dirty = false;
    let lastSavedAt = null;
    let busy = false;

    const lists = shape.lists ?? {};

    /* ==========================================================
       STATO E AVVISI
       ========================================================== */

    const time = (value) => {
        const date = value instanceof Date ? value : new Date(value);
        return Number.isNaN(date.getTime())
            ? null
            : date.toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' });
    };

    const addButtons = () => [...el.editor.querySelectorAll('[data-add]')];

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
        for (const button of [el.save, el.reload, ...addButtons()]) button.disabled = value;
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
       CAMPI
       ========================================================== */

    const field = (scope, name) => scope.querySelector(`[data-field="${name}"]`);
    const preview = (scope, name) => scope.querySelector(`[data-preview="${name}"]`);
    const value = (scope, name) => field(scope, name)?.value.trim() ?? '';

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

    /* ==========================================================
       LISTE
       ========================================================== */

    const container = (name) => el.editor.querySelector(`[data-list="${name}"]`);
    const rows = (name) => [...container(name).querySelectorAll('.editor-row')];
    const listNameOf = (row) => row.closest('[data-list]').dataset.list;

    function refreshEmpty(name) {
        const slot = el.editor.querySelector(`[data-empty="${name}"]`);
        if (slot) slot.hidden = rows(name).length > 0;
    }

    function buildRow(name, item = {}, { isNew = false } = {}) {
        const box = container(name);
        const template = document.getElementById(box.dataset.template);
        const row = template.content.firstElementChild.cloneNode(true);
        row.dataset.new = String(isNew);

        lists[name].fill(row, item, tools);

        // Un'immagine irraggiungibile non deve lasciare un'icona rotta in lista.
        for (const thumb of row.querySelectorAll('[data-preview-fallback]')) {
            thumb.addEventListener('error', (event) => {
                event.target.setAttribute('src', event.target.dataset.previewFallback);
            });
        }

        lists[name].preview?.(row, tools);
        if (isNew) {
            const details = row.querySelector('.editor-details');
            if (details) details.open = true;
        }

        return row;
    }

    function setList(name, items) {
        container(name).replaceChildren(...(items ?? []).map((item) => buildRow(name, item)));
        refreshEmpty(name);
    }

    function readList(name) {
        return rows(name).map((row, index) => lists[name].collect(row, index, tools));
    }

    const tools = { field, preview, value, setSelect, setList, readList, rows, form: () => el.editor };

    /* ==========================================================
       ERRORI DI VALIDAZIONE
       ========================================================== */

    function clearFieldErrors() {
        for (const slot of el.editor.querySelectorAll('.field-error')) {
            slot.hidden = true;
            slot.textContent = '';
        }
        for (const input of el.editor.querySelectorAll('[aria-invalid]')) {
            input.removeAttribute('aria-invalid');
        }
    }

    /**
     * Traduce il path di una issue nel campo che l'ha causata.
     *
     * `stats[1].value`     -> riga 1 della lista `stats`, campo `value`
     * `about.text`         -> campo `about.text` nel form
     *
     * Il primo caso vale anche per `footer.channels[0].url`: conta l'ultima
     * parentesi quadra, perche e li che finisce il nome della lista.
     */
    function locate(path) {
        const match = /^(.+)\[(\d+)\]\.(.+)$/.exec(path ?? '');

        if (match) {
            const [, listName, index, name] = match;
            const box = el.editor.querySelector(`[data-list="${listName}"]`);
            const row = box ? [...box.querySelectorAll('.editor-row')][Number(index)] : null;
            if (row) return { scope: row, name };
            return null;
        }

        return field(el.editor, path) ? { scope: el.editor, name: path } : null;
    }

    function showIssues(issues) {
        clearFieldErrors();

        const orphans = [];
        let first = null;

        for (const issue of issues) {
            const found = locate(issue.path);
            const slot = found?.scope.querySelector(`[data-error-for="${found.name}"]`);

            if (!slot) {
                orphans.push(issue.path ? `${issue.path}: ${issue.message}` : issue.message);
                continue;
            }

            slot.textContent = issue.message;
            slot.hidden = false;
            field(found.scope, found.name)?.setAttribute('aria-invalid', 'true');

            if (!first) first = found;
        }

        setAlert(
            'error',
            issues.length === 1
                ? 'C’e un campo da correggere, e segnalato qui sotto.'
                : `Ci sono ${issues.length} campi da correggere, sono segnalati qui sotto.`,
            { details: orphans }
        );

        if (first) {
            first.scope.querySelector('.editor-details')?.setAttribute('open', '');
            field(first.scope, first.name)?.focus();
        }
    }

    /* ==========================================================
       CARICAMENTO E SALVATAGGIO
       ========================================================== */

    async function load() {
        const { payload } = await apiGet(shape.endpoint);
        etag = payload.etag;
        shape.fill(payload.data ?? {}, tools);
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
            const { payload } = await apiPut(shape.endpoint, { data: shape.collect(tools) }, etag);
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
            handleError(error);
        } finally {
            setBusy(false);
        }
    }

    function handleError(error) {
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
            console.error(`[admin] ${shape.endpoint} fallito`, error);
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

        console.error(`[admin] ${shape.endpoint} fallito`, error);
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
                            shape.fill(payload.data ?? {}, tools);
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
     * Carica il file scelto e ne scrive la URL nel campo che gli sta accanto.
     *
     * Il bersaglio e il `[data-field]` dello stesso blocco `.field`: e sempre
     * vero per costruzione, e risparmia un attributo da tenere allineato.
     *
     * L'elemento NON viene salvato: il file e sul blob, ma nessun JSON lo cita
     * finche non si preme Salva. Se si cambia idea e si chiude la pagina resta
     * un blob orfano da qualche frazione di centesimo — molto meglio di un
     * salvataggio non richiesto del resto della scheda.
     */
    async function uploadInto(input) {
        const file = input.files?.[0];
        if (!file) return;

        const group = input.closest('.field');
        const target = group.querySelector('[data-field]');
        const slot = group.querySelector('.field-error');
        const label = input.closest('.upload-btn');
        const text = label.querySelector('[data-upload-label]');
        const original = text.textContent;

        if (slot) slot.hidden = true;
        label.classList.add('is-busy');
        text.textContent = 'Carico...';

        try {
            target.value = await uploadImage(file, input.dataset.upload);
            const row = input.closest('.editor-row');
            if (row) lists[listNameOf(row)].preview?.(row, tools);
            shape.onUpload?.(target, tools);
            markDirty();
        } catch (error) {
            if (error instanceof SessionExpiredError) {
                handleError(error);
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
        const siblings = rows(listNameOf(row));
        const target = siblings[siblings.indexOf(row) + step];
        if (!target) return;

        if (step < 0) target.before(row);
        else target.after(row);

        row.querySelector(`[data-action="${step < 0 ? 'up' : 'down'}"]`).focus();
        markDirty();
    }

    function afterEdit(event) {
        const row = event.target.closest('.editor-row');

        if (row) {
            const name = listNameOf(row);

            // L'identificativo si genera dal nome finche la riga e nuova e
            // nessuno l'ha toccato a mano: su una gia salvata cambiarlo da solo
            // sarebbe una modifica non richiesta. `autoSlug: true` legge dal
            // campo `name`; una stringa indica un altro campo (`title`).
            const slugSource = lists[name].autoSlug === true ? 'name' : lists[name].autoSlug;
            if (slugSource && event.target.dataset.field === slugSource && row.dataset.new === 'true') {
                const id = field(row, 'id');
                if (id && id.dataset.touched !== 'true') id.value = slugify(event.target.value);
            }
            if (event.target.dataset.field === 'id') event.target.dataset.touched = 'true';

            lists[name].preview?.(row, tools);
        }

        shape.onEdit?.(event.target, tools);
        markDirty();
    }

    el.editor.addEventListener('input', (event) => {
        if (!event.target.matches('[data-field]')) return;
        afterEdit(event);
    });

    el.editor.addEventListener('change', (event) => {
        if (event.target.dataset.upload) {
            uploadInto(event.target);
            return;
        }
        if (!event.target.matches('[data-field]')) return;
        afterEdit(event);
    });

    el.editor.addEventListener('click', (event) => {
        const adder = event.target.closest('[data-add]');
        if (adder) {
            const name = adder.dataset.add;
            const row = buildRow(name, lists[name].blank?.() ?? {}, { isNew: true });
            container(name).append(row);
            refreshEmpty(name);
            row.querySelector('[data-field]')?.focus();
            markDirty();
            return;
        }

        const button = event.target.closest('[data-action]');
        if (!button) return;

        const row = button.closest('.editor-row');
        const action = button.dataset.action;

        if (action === 'up') move(row, -1);
        if (action === 'down') move(row, 1);
        if (action === 'remove') {
            const name = listNameOf(row);
            const what = value(row, 'name') || value(row, 'label') || `questo ${lists[name].label}`;
            if (!confirm(`Elimino ${what}?\n\nSparisce dal sito al prossimo salvataggio.`)) return;
            row.remove();
            refreshEmpty(name);
            markDirty();
        }
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

    /* ==========================================================
       COMANDI PER CHI STA FUORI
       Servono a un pezzo di interfaccia che vive accanto all'editor ma non
       dentro le sue convenzioni — l'importazione di un evento dal link — per
       inserire una riga e segnalare l'esito con gli stessi strumenti.
       ========================================================== */

    /** Aggiunge una riga nuova in fondo alla lista e la apre. */
    function add(name, item) {
        const row = buildRow(name, item, { isNew: true });
        container(name).append(row);
        refreshEmpty(name);
        markDirty();
        return row;
    }

    /** Riscrive i campi di una riga esistente e la apre. */
    function refill(row, item) {
        const name = listNameOf(row);
        lists[name].fill(row, item, tools);
        lists[name].preview?.(row, tools);
        row.querySelector('.editor-details')?.setAttribute('open', '');
        markDirty();
        return row;
    }

    return {
        init,
        isDirty: () => dirty,
        add,
        refill,
        rows,
        value,
        setAlert,
        clearAlert,
        markDirty,
        handleError
    };
}
