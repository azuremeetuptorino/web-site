import { apiGet, apiPut, ApiError, SessionExpiredError } from './api.js';

/**
 * Editor del team.
 *
 * Tre cose che guidano il disegno di questo file:
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
 */

const PLACEHOLDER_AVATAR = '/assets/img/placeholder-avatar.svg';

const el = {
    loading: document.getElementById('team-loading'),
    editor: document.getElementById('team-editor'),
    list: document.getElementById('team-list'),
    empty: document.getElementById('team-empty'),
    alert: document.getElementById('team-alert'),
    state: document.getElementById('team-state'),
    save: document.getElementById('team-save'),
    add: document.getElementById('team-add'),
    reload: document.getElementById('team-reload'),
    template: document.getElementById('member-template')
};

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

/**
 * @param {{label: string, run: () => void}[]} actions
 */
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

const rows = () => [...el.list.querySelectorAll('.member-row')];
const field = (row, name) => row.querySelector(`[data-field="${name}"]`);
const preview = (row, name) => row.querySelector(`[data-preview="${name}"]`);

/**
 * Un valore che il <select> non conosce verrebbe silenziosamente sostituito da
 * quello vuoto, cioe cancellato al primo salvataggio. Meglio aggiungerlo come
 * opzione segnalata e lasciare che sia l'admin a decidere.
 */
function setSelect(select, value) {
    select.value = value ?? '';
    if (value && select.value !== value) {
        select.add(new Option(`${value} (valore non previsto)`, value, true, true));
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

function refreshPreview(row) {
    const name = field(row, 'name').value.trim();
    preview(row, 'name').textContent = name || 'Nuovo membro';
    preview(row, 'role').textContent = field(row, 'role').value.trim();

    const avatar = field(row, 'avatarUrl').value.trim();
    const thumb = preview(row, 'avatar');
    const wanted = avatar || PLACEHOLDER_AVATAR;
    if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);

    preview(row, 'hidden').hidden = field(row, 'active').checked;
}

function buildRow(member = {}, { isNew = false } = {}) {
    const row = el.template.content.firstElementChild.cloneNode(true);
    row.dataset.new = String(isNew);

    field(row, 'name').value = member.name ?? '';
    field(row, 'id').value = member.id ?? '';
    field(row, 'role').value = member.role ?? '';
    field(row, 'nick').value = member.nick ?? '';
    field(row, 'bio').value = member.bio ?? '';
    field(row, 'avatarUrl').value = member.avatarUrl ?? '';
    field(row, 'link.url').value = member.link?.url ?? '';
    field(row, 'active').checked = member.active !== false;

    setSelect(field(row, 'roleKey'), member.roleKey ?? 'staff');
    setSelect(field(row, 'link.type'), member.link?.type ?? '');

    // Una foto irraggiungibile non deve lasciare un'icona rotta nella lista.
    preview(row, 'avatar').addEventListener('error', (event) => {
        event.target.setAttribute('src', PLACEHOLDER_AVATAR);
    });

    refreshPreview(row);
    if (isNew) row.querySelector('.member-details').open = true;

    return row;
}

function render(members) {
    el.list.replaceChildren(...members.map((member) => buildRow(member)));
    el.empty.hidden = members.length > 0;
}

/* ==========================================================
   LETTURA DEL FORM
   ========================================================== */

const value = (row, name) => field(row, name).value.trim();

/**
 * Le schede nell'ordine in cui si vedono diventano order 10, 20, 30...
 * I campi vuoti si mandano cosi come sono: e il server a decidere quali sono
 * opzionali, qui non si indovina.
 */
function collect() {
    return rows().map((row, index) => {
        const member = {
            id: value(row, 'id'),
            name: value(row, 'name'),
            nick: value(row, 'nick'),
            role: value(row, 'role'),
            roleKey: value(row, 'roleKey'),
            bio: value(row, 'bio'),
            avatarUrl: value(row, 'avatarUrl'),
            order: (index + 1) * 10,
            active: field(row, 'active').checked
        };

        const type = value(row, 'link.type');
        const url = value(row, 'link.url');
        if (type || url) member.link = { type, url };

        return member;
    });
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
    const match = /^members\[(\d+)\]\.(.+)$/.exec(path ?? '');
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
        first.row.querySelector('.member-details').open = true;
        first.input?.focus();
    }
}

/* ==========================================================
   CARICAMENTO E SALVATAGGIO
   ========================================================== */

async function load() {
    const { payload } = await apiGet('/api/team');
    etag = payload.etag;
    render(payload.data?.members ?? []);
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
        const { payload } = await apiPut('/api/team', { data: { version: 1, members: collect() } }, etag);
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
        console.error('[admin] salvataggio del team fallito', error);
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

    console.error('[admin] salvataggio del team fallito', error);
    setAlert('error', `Il server ha rifiutato il salvataggio (${error.status}). Riprova tra poco.`);
}

/**
 * 409: il documento sul server e cambiato sotto le mani.
 *
 * Il form resta com'e. Si mostra chi ha salvato e quando, e si lascia scegliere:
 * in nessuno dei due casi qualcosa sparisce senza che sia stato chiesto.
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
                        // Si riparte dall'ETag del server: la nostra scrittura
                        // adesso e consapevole, non piu cieca.
                        etag = payload.etag;
                        save();
                    }
                },
                {
                    label: 'Scarta le mie e riparti dal server',
                    run: () => {
                        etag = payload.etag;
                        render(payload.data?.members ?? []);
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
   EVENTI
   ========================================================== */

function move(row, step) {
    const all = rows();
    const target = all[all.indexOf(row) + step];
    if (!target) return;

    if (step < 0) target.before(row);
    else target.after(row);

    row.querySelector('[data-action="' + (step < 0 ? 'up' : 'down') + '"]').focus();
    markDirty();
}

el.list.addEventListener('input', (event) => {
    const row = event.target.closest('.member-row');
    if (!row) return;

    // L'identificativo si genera dal nome finche il membro e nuovo e nessuno
    // l'ha toccato a mano: su un membro gia salvato cambiarlo da solo sarebbe
    // una modifica non richiesta.
    if (event.target.dataset.field === 'name' && row.dataset.new === 'true') {
        const id = field(row, 'id');
        if (id.dataset.touched !== 'true') id.value = slugify(event.target.value);
    }
    if (event.target.dataset.field === 'id') event.target.dataset.touched = 'true';

    refreshPreview(row);
    markDirty();
});

el.list.addEventListener('change', (event) => {
    const row = event.target.closest('.member-row');
    if (!row) return;
    refreshPreview(row);
    markDirty();
});

el.list.addEventListener('click', (event) => {
    const button = event.target.closest('[data-action]');
    if (!button) return;

    const row = button.closest('.member-row');
    const action = button.dataset.action;

    if (action === 'up') move(row, -1);
    if (action === 'down') move(row, 1);
    if (action === 'remove') {
        const name = field(row, 'name').value.trim() || 'questo membro';
        if (!confirm(`Elimino ${name}?\n\nSparisce dal sito al prossimo salvataggio.`)) return;
        row.remove();
        el.empty.hidden = rows().length > 0;
        markDirty();
    }
});

el.add.addEventListener('click', () => {
    const row = buildRow({ roleKey: 'staff', active: true }, { isNew: true });
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
        console.error('[admin] ricaricamento del team fallito', error);
        setAlert('error', 'Non sono riuscito a rileggere il team dal server.');
    } finally {
        setBusy(false);
    }
});

// Rete di sicurezza contro la chiusura distratta della scheda.
window.addEventListener('beforeunload', (event) => {
    if (dirty) event.preventDefault();
});

/* ==========================================================
   AVVIO
   ========================================================== */

/** @param {boolean} canWrite false se la sessione non ha il ruolo admin. */
export async function initTeamEditor(canWrite = true) {
    try {
        await load();
    } catch (error) {
        el.loading.replaceChildren();
        const message = document.createElement('p');
        message.textContent = error instanceof SessionExpiredError
            ? 'La sessione e scaduta: ricarica la pagina per rientrare.'
            : 'Non sono riuscito a leggere il team dal server.';
        el.loading.append(message);
        console.error('[admin] caricamento del team fallito', error);
        return;
    }

    el.loading.hidden = true;
    el.editor.hidden = false;

    if (!canWrite) {
        el.save.disabled = true;
        el.save.title = 'Serve il ruolo admin per salvare';
    }
}
