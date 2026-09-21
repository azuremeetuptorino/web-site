import { createEditorCore } from './editor-core.js';
import { apiPost, ApiError, SessionExpiredError } from './api.js';

/**
 * Editor degli eventi.
 *
 * La scheda si compila di rado a mano: il caso normale e incollare il link
 * della pagina pubblica su Luma o Meetup e lasciare che `/api/events/import`
 * la riempia. Per questo il modulo ha due meta: la forma dei dati (come gli
 * altri editor) e, sotto, il cablaggio della barra di importazione, che vive
 * accanto alla lista e usa i comandi che il nucleo espone per inserire una
 * riga e dare un esito.
 *
 * Le date viaggiano in ISO UTC e si mostrano con <input type="datetime-local">,
 * che parla l'ora del computer di chi modifica: da Torino e l'ora giusta. Il
 * fuso salvato (`timezone`) serve al sito pubblico per scrivere l'orario in ora
 * italiana a chiunque lo guardi.
 */

const PLACEHOLDER_EVENT = '/assets/img/placeholder-event.svg';
const DEFAULT_TIMEZONE = 'Europe/Rome';

/* ==========================================================
   DATE
   ========================================================== */

const pad = (number) => String(number).padStart(2, '0');

/** ISO -> valore per datetime-local, nell'ora locale del browser. */
export function toLocalInput(iso) {
    if (!iso) return '';
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) return '';
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/**
 * datetime-local -> ISO UTC. Un valore che non si legge torna com'e: sara il
 * server a dire "non e una data valida" accanto al campo, come per ogni altro
 * errore, invece di sparire in silenzio.
 */
export function fromLocalInput(value) {
    if (!value) return '';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

function formatWhen(iso, timezone) {
    const date = new Date(iso);
    if (!iso || Number.isNaN(date.getTime())) return 'data da inserire';

    const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    try {
        return new Intl.DateTimeFormat('it-IT', { ...options, timeZone: timezone || DEFAULT_TIMEZONE }).format(date);
    } catch {
        return new Intl.DateTimeFormat('it-IT', options).format(date);
    }
}

/** Piu recenti in alto: i prossimi eventi sono quelli su cui si lavora. */
const byDateDesc = (a, b) => (Date.parse(b.dateTime ?? 0) || 0) - (Date.parse(a.dateTime ?? 0) || 0);

/* ==========================================================
   FORMA DEI DATI
   ========================================================== */

export const eventsEditor = createEditorCore({
    endpoint: '/api/events',

    ids: {
        loading: 'event-loading',
        editor: 'event-editor',
        alert: 'event-alert',
        state: 'event-state',
        save: 'event-save',
        reload: 'event-reload'
    },

    lists: {
        events: {
            label: 'evento',
            autoSlug: 'title',

            blank: () => ({ timezone: DEFAULT_TIMEZONE, isOnline: false, active: true }),

            fill(row, event, { field }) {
                field(row, 'title').value = event.title ?? '';
                field(row, 'id').value = event.id ?? '';
                field(row, 'dateTime').value = toLocalInput(event.dateTime);
                field(row, 'endTime').value = toLocalInput(event.endTime);
                field(row, 'timezone').value = event.timezone ?? DEFAULT_TIMEZONE;
                field(row, 'eventUrl').value = event.eventUrl ?? '';
                field(row, 'imageUrl').value = event.imageUrl ?? '';
                field(row, 'excerpt').value = event.excerpt ?? '';
                field(row, 'isOnline').checked = event.isOnline === true;
                field(row, 'venue.name').value = event.venue?.name ?? '';
                field(row, 'venue.address').value = event.venue?.address ?? '';
                field(row, 'venue.city').value = event.venue?.city ?? '';
                field(row, 'active').checked = event.active !== false;
            },

            collect(row, index, { value, field }) {
                return {
                    id: value(row, 'id'),
                    title: value(row, 'title'),
                    dateTime: fromLocalInput(value(row, 'dateTime')),
                    endTime: fromLocalInput(value(row, 'endTime')),
                    timezone: value(row, 'timezone') || DEFAULT_TIMEZONE,
                    isOnline: field(row, 'isOnline').checked,
                    eventUrl: value(row, 'eventUrl'),
                    imageUrl: value(row, 'imageUrl'),
                    excerpt: value(row, 'excerpt'),
                    venue: {
                        name: value(row, 'venue.name'),
                        address: value(row, 'venue.address'),
                        city: value(row, 'venue.city')
                    },
                    active: field(row, 'active').checked
                };
            },

            preview(row, { field, preview, value }) {
                preview(row, 'title').textContent = value(row, 'title') || 'Nuovo evento';

                const start = fromLocalInput(value(row, 'dateTime'));
                const where = field(row, 'isOnline').checked
                    ? 'Online'
                    : value(row, 'venue.name') || value(row, 'venue.city');
                preview(row, 'when').textContent = [formatWhen(start, value(row, 'timezone')), where].filter(Boolean).join(' · ');

                const thumb = preview(row, 'image');
                const wanted = value(row, 'imageUrl') || PLACEHOLDER_EVENT;
                if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);

                preview(row, 'hidden').hidden = field(row, 'active').checked;
                const reference = fromLocalInput(value(row, 'endTime')) || start;
                preview(row, 'past').hidden = !(reference && Date.parse(reference) < Date.now());
            }
        }
    },

    fill(data, { setList }) {
        setList('events', [...(data.events ?? [])].sort(byDateDesc));
    },

    collect({ readList }) {
        return { version: 1, events: readList('events') };
    }
});

/* ==========================================================
   IMPORTAZIONE DAL LINK
   ========================================================== */

const importBox = document.getElementById('event-import');
const importUrl = document.getElementById('event-import-url');
const importButton = document.getElementById('event-import-btn');
const importError = document.getElementById('event-import-error');

const PLATFORM_LABEL = { luma: 'Luma', meetup: 'Meetup' };

function showImportError(message) {
    importError.textContent = message;
    importError.hidden = false;
    importUrl.setAttribute('aria-invalid', 'true');
}

function clearImportError() {
    importError.hidden = true;
    importError.textContent = '';
    importUrl.removeAttribute('aria-invalid');
}

function setImportBusy(busy) {
    importBox.classList.toggle('is-busy', busy);
    importButton.disabled = busy;
    importButton.querySelector('[data-import-label]').textContent = busy ? 'Leggo la pagina...' : 'Importa';
}

/** Un messaggio in italiano per ogni codice che la function puo restituire. */
function messageFor(error) {
    const payload = error.payload ?? {};

    switch (payload.error) {
        case 'invalid-url':
            return 'Il link non e un indirizzo valido: deve iniziare con https://.';
        case 'host-not-allowed':
            return `Posso importare solo dalle pagine di ${(payload.allowed ?? ['luma.com', 'meetup.com']).join(', ')}.`;
        case 'no-event-found':
            return 'In quella pagina non ho trovato un evento. E il link della pagina dell’evento, e non del gruppo o del calendario?';
        case 'upstream-not-found':
            return 'La piattaforma dice che quella pagina non esiste. Controlla il link.';
        case 'upstream-timeout':
            return 'La piattaforma non ha risposto in tempo. Riprova tra poco.';
        case 'upstream-unreachable':
        case 'upstream-failed':
        case 'upstream-too-large':
        case 'too-many-redirects':
            return 'Non riesco a leggere la pagina dalla piattaforma in questo momento. Riprova tra poco, oppure compila la scheda a mano.';
        default:
            break;
    }
    if (error.status === 403) return 'Il tuo account non ha il ruolo admin: l’importazione e stata rifiutata.';
    return `Il server ha rifiutato l’importazione (${error.status}).`;
}

/**
 * Mette la scheda importata in lista.
 *
 * Se un evento con lo stesso identificativo o lo stesso link c'e gia, si
 * aggiorna quello invece di creare un doppione: e il caso di quando su Luma
 * cambia l'orario e si reimporta. L'identificativo gia salvato si conserva,
 * perche e la chiave con cui il resto del sito lo riconosce.
 */
function place(event, source) {
    const platform = PLATFORM_LABEL[source?.platform] ?? 'la pagina';
    const rows = eventsEditor.rows('events');
    const existing = rows.find((row) =>
        eventsEditor.value(row, 'id') === event.id ||
        (event.eventUrl && eventsEditor.value(row, 'eventUrl') === event.eventUrl)
    );

    let row;
    if (existing) {
        row = eventsEditor.refill(existing, { ...event, id: eventsEditor.value(existing, 'id') });
        eventsEditor.setAlert(
            'warn',
            `«${event.title ?? event.id}» era gia in lista: ho aggiornato la scheda con i dati letti da ${platform}. Controlla e poi salva.`
        );
    } else {
        row = eventsEditor.add('events', event);
        eventsEditor.setAlert(
            'success',
            `Ho letto «${event.title ?? event.id}» da ${platform}. Controlla la scheda qui sotto, poi premi Salva e pubblica.`
        );
    }

    row.scrollIntoView({ block: 'center', behavior: 'smooth' });
    row.querySelector('[data-field="title"]')?.focus({ preventScroll: true });
}

async function runImport() {
    clearImportError();
    eventsEditor.clearAlert();

    const url = importUrl.value.trim();
    if (!url) {
        showImportError('Incolla il link della pagina dell’evento.');
        importUrl.focus();
        return;
    }

    setImportBusy(true);
    try {
        const { payload } = await apiPost('/api/events/import', { url });
        place(payload.event, payload.source);
        importUrl.value = '';
    } catch (error) {
        if (error instanceof SessionExpiredError) {
            eventsEditor.handleError(error);
        } else if (error instanceof ApiError) {
            showImportError(messageFor(error));
        } else {
            console.error('[admin] importazione evento fallita', error);
            showImportError('Importazione non riuscita. Controlla la connessione e riprova.');
        }
    } finally {
        setImportBusy(false);
    }
}

if (importBox) {
    importButton.addEventListener('click', () => runImport());
    importUrl.addEventListener('keydown', (event) => {
        if (event.key !== 'Enter') return;
        event.preventDefault();
        runImport();
    });
    importUrl.addEventListener('input', clearImportError);
}
