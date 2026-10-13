import { apiGet } from './api.js';
import { createContentEditor } from './content-editor.js';
import { eventsEditor } from './events-editor.js';

/**
 * Pannello Pagine evento: sessioni, speaker e foto degli eventi con la spunta
 * "Pagina dedicata" (`featured`), uno per volta, scelto nel selettore.
 *
 * L'elenco degli eventi viene dal documento salvato (`/api/events`), non dal
 * form della scheda Eventi: la pagina di un evento ha senso solo per un evento
 * che sul sito c'e gia. Si rilegge ogni volta che si apre il pannello, cosi una
 * spunta appena salvata compare senza ricaricare l'admin.
 */

const select = document.getElementById('ep-event');
const loading = document.getElementById('ep-loading');
const none = document.getElementById('ep-none');
const editorRoot = document.getElementById('ep-editor');
const publicLink = document.getElementById('ep-public-link');
const tab = document.getElementById('tab-pagine-evento');

let eventId = null;
let started = false;
let canWritePage = true;

const contents = createContentEditor({
    prefix: 'ep',
    ids: {
        loading: 'ep-loading',
        editor: 'ep-editor',
        alert: 'ep-alert',
        state: 'ep-state',
        save: 'ep-save',
        reload: 'ep-reload'
    },
    endpoint: () => `/api/event-pages/${eventId}`,
    uploadPrefix: () => eventId,
    // L'id Sessionize sta nel documento della pagina: l'evento non ne ha uno.
    fillExtra(data) {
        contents.sessionizeInput.value = data.sessionizeId ?? '';
    },
    collectExtra: () => ({ sessionizeId: contents.sessionizeInput.value.trim() })
});

export const eventPageEditor = contents.editor;

const formatDay = (iso) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
        ? ''
        : new Intl.DateTimeFormat('it-IT', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Europe/Rome' }).format(date);
};

async function featuredEvents() {
    const { payload } = await apiGet('/api/events');
    return (payload.data?.events ?? [])
        .filter((event) => event.featured)
        .sort((a, b) => (Date.parse(b.dateTime) || 0) - (Date.parse(a.dateTime) || 0));
}

function showPublicLink() {
    publicLink.href = eventId ? `/evento/?id=${encodeURIComponent(eventId)}` : '/eventi/';
}

async function open(id) {
    eventId = id;
    select.value = id;
    showPublicLink();
    if (started) {
        await eventPageEditor.reload();
    } else {
        started = true;
        loading.hidden = false;
        await eventPageEditor.init(canWritePage);
    }
}

/** Rilegge gli eventi con la pagina e, se serve, apre `wanted`. */
async function refresh(wanted) {
    let events;
    try {
        events = await featuredEvents();
    } catch (error) {
        eventPageEditor.handleError(error);
        return;
    }

    select.replaceChildren(...events.map((event) =>
        new Option([event.title, formatDay(event.dateTime)].filter(Boolean).join(' · '), event.id)));
    if (eventId && !events.some((event) => event.id === eventId)) {
        // Spunta tolta mentre la pagina era aperta: resta aperta finche non se
        // ne sceglie un'altra, per non perdere modifiche.
        select.add(new Option(`${eventId} (senza pagina dedicata)`, eventId));
    }

    if (events.length === 0 && !eventId) {
        loading.hidden = true;
        editorRoot.hidden = true;
        none.hidden = false;
        return;
    }
    none.hidden = true;

    const target = wanted ?? eventId ?? events[0].id;
    if (target === eventId) {
        select.value = eventId;
        return;
    }
    if (eventPageEditor.isDirty() && !confirm('Le modifiche alla pagina aperta non sono salvate e andranno perse. Cambio evento?')) {
        select.value = eventId;
        return;
    }
    await open(target);
}

select.addEventListener('change', async () => {
    const wanted = select.value;
    if (wanted === eventId) return;
    if (eventPageEditor.isDirty() && !confirm('Le modifiche alla pagina aperta non sono salvate e andranno perse. Cambio evento?')) {
        select.value = eventId;
        return;
    }
    await open(wanted);
});

// L'evento da aprire quando il pannello si apre dal bottone di una scheda.
let requested = null;

tab.addEventListener('click', () => refresh(requested ?? undefined));

// "Sessioni e foto" nella scheda di un evento porta qui, gia su quell'evento.
document.getElementById('panel-eventi').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-event-page]');
    if (!button) return;
    requested = eventsEditor.value(button.closest('.editor-row'), 'id');
    tab.click();
    requested = null;
});

export const eventPagesPanel = {
    async init(canWrite = true) {
        canWritePage = canWrite;
        await refresh();
    },
    isDirty: () => eventPageEditor.isDirty()
};
