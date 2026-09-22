import { apiGet, apiPost, ApiError, SessionExpiredError } from './api.js';

/**
 * La scheda dei promemoria.
 *
 * Non usa `createEditorCore` come le altre: li c'e un modulo da compilare e da
 * salvare tutto insieme, qui c'e una lista di cose da fare e dei pulsanti che
 * agiscono uno alla volta. Non esiste uno stato "non salvato" - ogni azione
 * parte e finisce da sola - e infatti `isDirty` risponde sempre di no.
 *
 * IL TESTO NON SI COMPONE QUI. Arriva gia scritto da `/api/reminders`, adattato
 * al limite di ogni canale. E la stessa stringa che la function spedira su
 * Telegram: se la costruissero in due, prima o poi l'anteprima e il post
 * finirebbero per non coincidere piu.
 *
 * Dopo ogni azione si ricarica tutto invece di aggiornare la riga toccata. Sono
 * pochi eventi, la chiamata e una, e in cambio non esiste il caso in cui la
 * pagina mostra uno stato che il server non ha.
 */

const PLACEHOLDER_EVENT = '/assets/img/placeholder-event.svg';

const el = {
    loading: document.getElementById('reminder-loading'),
    panel: document.getElementById('reminder-panel'),
    list: document.getElementById('reminder-list'),
    empty: document.getElementById('reminder-empty'),
    alert: document.getElementById('reminder-alert'),
    state: document.getElementById('reminder-state'),
    reload: document.getElementById('reminder-reload')
};

const templates = {
    event: document.getElementById('reminder-event-template'),
    window: document.getElementById('reminder-window-template'),
    channel: document.getElementById('reminder-channel-template')
};

const slot = (root, name) => root.querySelector(`[data-slot="${name}"]`);
const action = (root, name) => root.querySelector(`[data-action="${name}"]`);

/** Stato della pagina: l'ultima risposta del server e l'ETag con cui agire. */
let data = null;
let etag = null;
let canWrite = true;
let busy = false;

/* ==========================================================
   AVVISI
   ========================================================== */

function clearAlert() {
    el.alert.hidden = true;
    el.alert.replaceChildren();
}

function setAlert(kind, message, { details = [], actions = [] } = {}) {
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
        for (const entry of actions) {
            const button = document.createElement('button');
            button.type = 'button';
            button.className = 'editor-btn';
            button.textContent = entry.label;
            button.addEventListener('click', entry.run);
            row.append(button);
        }
        el.alert.append(row);
    }

    el.alert.hidden = false;
    el.alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/** Un messaggio in italiano per ogni codice che le function possono restituire. */
function messageFor(error) {
    const payload = error.payload ?? {};

    switch (payload.error) {
        case 'telegram-not-configured':
            return 'Telegram non e configurato su questo sito: servono le impostazioni TELEGRAM_BOT_TOKEN e TELEGRAM_CHAT_ID. Intanto puoi copiare il testo e pubblicarlo a mano.';
        case 'telegram-rate-limited':
            return payload.retryAfter
                ? `Telegram chiede di aspettare ${payload.retryAfter} secondi prima di pubblicare ancora.`
                : 'Telegram chiede di rallentare: riprova fra poco.';
        case 'telegram-unauthorized':
            return 'Il token del bot non e valido o e stato revocato. Va rigenerato con @BotFather e rimesso nelle impostazioni.';
        case 'telegram-rejected':
            return `Telegram ha rifiutato il messaggio: ${payload.description ?? 'motivo non specificato'}. Di solito significa che il bot non e amministratore del canale.`;
        case 'telegram-timeout':
        case 'telegram-unreachable':
            return 'Telegram non ha risposto in tempo. Controlla sul canale se il promemoria e uscito lo stesso, poi riprova.';
        case 'ai-not-configured':
            return 'La riscrittura automatica non e configurata su questo sito.';
        case 'ai-rate-limited':
            return 'Il servizio di riscrittura e occupato: riprova fra qualche secondo.';
        case 'ai-unauthorized':
            return 'Le credenziali del servizio di riscrittura non sono valide.';
        case 'ai-refused':
            return 'Il modello non ha voluto scrivere questo testo. Prova a rivedere titolo e descrizione dell’evento.';
        case 'ai-bad-output':
            return 'La risposta del modello non era utilizzabile. Riprova: di solito al secondo tentativo va.';
        case 'ai-timeout':
        case 'ai-failed':
            return 'Il servizio di riscrittura non ha risposto. Riprova fra poco, oppure usa il testo standard.';
        case 'already-sent':
            return 'Questo promemoria risulta gia inviato. Ho ricaricato la scheda.';
        case 'event-not-upcoming':
            return 'L’evento e gia passato o non e piu attivo: non ha piu senso ricordarlo.';
        case 'event-not-found':
            return 'Non trovo piu questo evento. Forse e stato cancellato dalla scheda Eventi.';
        case 'text-too-long':
            return `Il testo supera il limite del canale (${payload.length} caratteri contro ${payload.limit}). Accorcialo prima di pubblicare.`;
        case 'storage-unavailable':
            return 'Non riesco a leggere i dati del sito in questo momento. Riprova fra poco.';
        default:
            break;
    }

    if (error.status === 403) return 'Il tuo account non ha il ruolo admin: l’operazione e stata rifiutata.';
    return `Il server ha rifiutato l’operazione (${error.status}).`;
}

function handleError(error) {
    if (error instanceof SessionExpiredError) {
        setAlert(
            'warn',
            'La sessione e scaduta. Rientra in un’altra scheda, poi torna qui e ricarica.',
            { actions: [{ label: 'Apri il login', run: () => window.open('/.auth/login/aad', '_blank', 'noopener') }] }
        );
        return;
    }

    if (!(error instanceof ApiError)) {
        console.error('[admin] promemoria', error);
        setAlert('error', 'Qualcosa non ha funzionato. Controlla la connessione e riprova.');
        return;
    }

    // Il 409 non e un errore da correggere: e qualcun altro che ha agito. Si
    // ricarica e si lascia decidere, invece di insistere su dati vecchi.
    if (error.status === 409 && error.payload.error !== 'already-sent') {
        setAlert('warn', 'Qualcun altro ha aggiornato i promemoria nel frattempo: ho ricaricato la scheda, ricontrolla prima di agire.');
        load();
        return;
    }

    setAlert(error.status === 409 ? 'warn' : 'error', messageFor(error));
    if (error.payload.error === 'already-sent') load();
}

/* ==========================================================
   DATE
   ========================================================== */

const dayFormat = new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

function shortDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? '' : dayFormat.format(date);
}

/* ==========================================================
   DISEGNO
   ========================================================== */

/**
 * Una scheda canale.
 *
 * Quali pulsanti si vedono dipende da tre cose: se il canale sa pubblicare da
 * solo, se il promemoria risulta gia uscito, e se c'e una bozza al posto del
 * testo standard. Tenerlo tutto qui evita che la pagina mostri un "Pubblica"
 * per un canale che non puo pubblicare.
 */
function renderChannel(context, meta, channel) {
    const node = templates.channel.content.firstElementChild.cloneNode(true);
    const { event, windowId } = context;
    const eventId = event.id;

    slot(node, 'icon').className = `bi ${meta.icon}`;
    slot(node, 'label').textContent = meta.label;

    const text = slot(node, 'text');
    const editor = slot(node, 'editor');
    const isDraft = channel.source !== 'template';

    text.textContent = channel.text;
    editor.value = channel.text;
    text.hidden = isDraft;
    editor.hidden = !isDraft;

    const counter = slot(node, 'counter');
    const showCount = (length) => {
        counter.textContent = `${length} / ${channel.limit}`;
        counter.classList.toggle('is-over', length > channel.limit);
        counter.classList.toggle('is-truncated', length <= channel.limit && channel.truncated);
    };
    showCount(channel.length);

    if (channel.notes?.length > 0) {
        const notes = slot(node, 'notes');
        notes.textContent = channel.notes.join(' ');
        notes.hidden = false;
    }

    const badge = slot(node, 'state');
    if (channel.sent) {
        badge.textContent = `Inviato il ${shortDate(channel.sent.at)}`;
        badge.className = 'editor-flag reminder-flag-sent';
        badge.hidden = false;
        node.classList.add('is-sent');
    }

    const send = action(node, 'send');
    const mark = action(node, 'mark');
    const unmark = action(node, 'unmark');
    const image = action(node, 'image');
    const saveDraft = action(node, 'save-draft');
    const resetDraft = action(node, 'reset-draft');

    // Telegram pubblica da qui; gli altri tre si copiano e si segnano.
    const sendable = meta.mode === 'api' && data.telegram.configured;
    send.hidden = !sendable || Boolean(channel.sent);
    slot(send, 'send-label').textContent = `Pubblica su ${meta.label}`;

    mark.hidden = Boolean(channel.sent);
    unmark.hidden = !channel.sent;

    if (meta.mode === 'api' && !data.telegram.configured && !channel.sent) {
        mark.title = 'Telegram non e configurato: pubblica a mano e segnalo qui.';
    }

    // LA COPERTINA. Su Telegram il bot la spedisce insieme al testo; sugli altri
    // tre si pubblica a mano, e un post con l'immagine rende molto piu di uno
    // senza. Mostrarla qui serve a due cose: sapere che c'e, e vedere cosa si
    // sta per allegare prima di allegarlo.
    if (event.imageUrl) {
        const photo = slot(node, 'photo');
        slot(node, 'photo-img').src = event.imageUrl;
        // La didascalia dice solo cio che cambia da canale a canale: dove il bot
        // la spedisce da solo, e dove senza non si pubblica proprio.
        slot(node, 'photo-note').textContent = sendable ? 'Parte insieme al messaggio.'
            : channel.requiresImage ? 'Obbligatoria su Instagram.'
                : 'Da allegare al post.';
        photo.hidden = false;

        image.href = event.imageUrl;
        image.hidden = false;
    }
    // Senza copertina non si mostra un riquadro vuoto: per Instagram, che senza
    // non puo pubblicare, ci pensa gia la nota che arriva dal server.

    saveDraft.hidden = !isDraft;
    resetDraft.hidden = !isDraft;

    if (!canWrite) {
        for (const button of node.querySelectorAll('button[data-action]')) {
            if (button.dataset.action !== 'copy') button.disabled = true;
        }
        editor.readOnly = true;
    }

    const payload = { eventId, window: windowId, channel: meta.id };

    editor.addEventListener('input', () => showCount([...editor.value].length));

    action(node, 'copy').addEventListener('click', () => copy(node, isDraft ? editor.value : channel.text));
    send.addEventListener('click', () => run(send, 'Pubblico...', () => apiPost('/api/reminders/send', payload, etag), reportSend));
    mark.addEventListener('click', () => run(mark, 'Segno...', () => apiPost('/api/reminders/mark', { ...payload, sent: true }, etag)));
    unmark.addEventListener('click', () => {
        const message = channel.sent?.mode === 'api'
            ? 'Il post su Telegram resta pubblicato: vuoi solo togliere il segno da questa scheda?'
            : 'Vuoi togliere il segno da questo promemoria?';
        if (window.confirm(message)) {
            run(unmark, 'Tolgo...', () => apiPost('/api/reminders/mark', { ...payload, sent: false }, etag));
        }
    });
    saveDraft.addEventListener('click', () => run(saveDraft, 'Salvo...', () =>
        apiPost('/api/reminders/draft', { ...payload, text: editor.value }, etag)));
    resetDraft.addEventListener('click', () => run(resetDraft, 'Ripristino...', () =>
        apiPost('/api/reminders/draft', { ...payload, text: null }, etag)));

    return node;
}

function renderWindow(event, entry) {
    const node = templates.window.content.firstElementChild.cloneNode(true);

    slot(node, 'label').textContent = entry.label;

    const state = slot(node, 'state');
    if (!entry.due) state.textContent = `si apre il ${shortDate(entry.dueAt)}`;
    else if (entry.superseded) state.textContent = 'superata';
    else state.textContent = 'da mandare';

    node.classList.toggle('is-due', entry.due && !entry.superseded);
    node.classList.toggle('is-faded', !entry.due || entry.superseded);

    const cards = slot(node, 'channels');
    for (const meta of data.channels) {
        cards.append(renderChannel({ event, windowId: entry.id }, meta, entry.channels[meta.id]));
    }

    const compose = action(node, 'compose');
    if (data.ai.configured) {
        compose.hidden = false;
        compose.disabled = !canWrite;
        compose.addEventListener('click', () => {
            const rewritten = data.channels.some((meta) => entry.channels[meta.id].source !== 'template');
            if (rewritten && !window.confirm('Ci sono gia dei testi riscritti per questa finestra: li sostituisco tutti?')) return;

            run(compose, 'Scrivo...', () => apiPost('/api/reminders/compose', { eventId: event.id, window: entry.id }, etag));
        });
    }

    return node;
}

function renderEvent(event) {
    const node = templates.event.content.firstElementChild.cloneNode(true);

    slot(node, 'title').textContent = event.title;
    slot(node, 'when').textContent = [event.when, event.where].filter(Boolean).join(' - ');
    slot(node, 'image').src = event.imageUrl || PLACEHOLDER_EVENT;

    // Quanti promemoria sono aperti e ancora non mandati: e l'unico numero che
    // serve per decidere se aprire la scheda o lasciarla chiusa.
    const pending = event.windows
        .filter((entry) => entry.due && !entry.superseded)
        .flatMap((entry) => data.channels.map((meta) => entry.channels[meta.id]))
        .filter((channel) => !channel.sent).length;

    const badge = slot(node, 'badge');
    if (pending > 0) {
        badge.textContent = pending === 1 ? '1 da mandare' : `${pending} da mandare`;
        badge.className = 'editor-flag reminder-flag-todo';
    } else {
        const next = event.windows.find((entry) => !entry.due);
        badge.textContent = next ? `prossimo il ${shortDate(next.dueAt)}` : 'tutto mandato';
        badge.className = 'editor-flag editor-flag-muted';
    }

    node.querySelector('details').open = pending > 0;

    const windows = slot(node, 'windows');
    // Prima quelle da fare, poi le superate, in fondo quelle non ancora aperte.
    const rank = (entry) => (entry.due && !entry.superseded ? 0 : entry.due ? 2 : 1);
    for (const entry of [...event.windows].sort((a, b) => rank(a) - rank(b))) {
        windows.append(renderWindow(event, entry));
    }

    return node;
}

function render() {
    el.list.replaceChildren();
    for (const event of data.events) el.list.append(renderEvent(event));

    el.empty.hidden = data.events.length > 0;
    el.state.textContent = `Aggiornato alle ${new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}`;

    el.loading.hidden = true;
    el.panel.hidden = false;
}

/* ==========================================================
   AZIONI
   ========================================================== */

/** Copia negli appunti, con lo stesso ritorno visivo della mail nel footer. */
async function copy(card, text) {
    const button = action(card, 'copy');
    const label = slot(button, 'copy-label');

    try {
        await navigator.clipboard.writeText(text);
        label.textContent = 'Copiato!';
        setTimeout(() => { label.textContent = 'Copia'; }, 2000);
    } catch {
        // Succede senza HTTPS o con i permessi negati: si seleziona il testo
        // cosi resta il gesto manuale, invece di un pulsante che non fa niente.
        const source = card.querySelector('[data-slot="editor"]:not([hidden]), [data-slot="text"]:not([hidden])');
        window.getSelection()?.selectAllChildren(source);
        setAlert('warn', 'Il browser non mi lascia usare gli appunti: il testo e selezionato, copialo con Ctrl+C.');
    }
}

/**
 * Esegue un'azione tenendo il pulsante occupato.
 *
 * `busy` e globale e non per pulsante: due azioni in parallelo partirebbero con
 * lo stesso ETag e la seconda si prenderebbe un conflitto che non ha senso
 * mostrare a chi ha solo cliccato in fretta.
 */
async function run(button, label, call, report) {
    if (busy) return;
    busy = true;

    const text = button.querySelector('span') ?? button;
    const original = text.textContent;
    text.textContent = label;
    button.disabled = true;
    clearAlert();

    try {
        const { payload } = await call();
        report?.(payload);
        await load({ keepAlert: Boolean(report) });
    } catch (error) {
        handleError(error);
        text.textContent = original;
        button.disabled = false;
    } finally {
        busy = false;
    }
}

/** L'esito di una pubblicazione su Telegram, che ha due modi di andare storta a meta. */
function reportSend(payload) {
    const notes = payload.notes ?? [];

    if (payload.recorded === false) {
        setAlert('warn', 'Il promemoria e uscito su Telegram, ma non sono riuscito a registrarlo qui. Controlla il canale e poi premi "Segna come inviato", cosi non te lo richiedo piu.', { details: notes });
        return;
    }

    setAlert('success', 'Promemoria pubblicato su Telegram.', { details: notes });
}

async function load({ keepAlert = false } = {}) {
    if (!keepAlert) clearAlert();

    try {
        const response = await apiGet('/api/reminders');
        data = response.payload;
        etag = response.payload.etag;
        render();
    } catch (error) {
        el.loading.hidden = true;
        el.panel.hidden = false;
        handleError(error);
    }
}

/* ==========================================================
   AVVIO
   ========================================================== */

el.reload?.addEventListener('click', () => load());

export const remindersPanel = {
    async init(writable) {
        canWrite = writable;
        await load();
    },

    // Non c'e niente di non salvato: ogni azione e gia andata a buon fine o no.
    isDirty: () => false
};
