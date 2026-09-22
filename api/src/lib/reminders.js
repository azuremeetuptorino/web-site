/**
 * Quando ricordare un evento, e cosa e gia stato ricordato.
 *
 * QUANDO. Tre richiami prima di ogni evento: due settimane, una settimana, due
 * giorni. Il primo serve a farsi mettere in agenda, l'ultimo a farsi ricordare
 * da chi l'agenda non la guarda. Sono finestre e non scadenze: una volta che si
 * aprono restano aperte, perche un promemoria in ritardo e comunque meglio di
 * un promemoria saltato.
 *
 * COSA E GIA USCITO. Sta in un blob suo, `site-data/reminders.json`, e non
 * dentro l'evento. Due motivi. Il validatore degli eventi scarta i campi che
 * non conosce, quindi un campo aggiunto li verrebbe cancellato al primo
 * salvataggio dall'admin. E l'ETag: la scheda dei promemoria e l'editor degli
 * eventi scrivono in momenti diversi, e tenerli sullo stesso documento
 * significherebbe farli litigare per il diritto di salvare.
 *
 * Questo file non parla con Azure ne con i social: riceve lo store e i dati,
 * restituisce oggetti. E il motivo per cui si prova senza storage.
 */

import { CHANNELS, channelById, channelSummaries, countChars, formatWhen, formatWhere } from './reminder-channels.js';

/** Il nome del blob nel container privato. Nessuna copia pubblica: non riguarda i visitatori. */
export const REMINDERS_BLOB = 'reminders.json';

/** I tre richiami, dal piu lontano al piu vicino. L'ordine conta: lo usa `superseded`. */
export const WINDOWS = [
    { id: '14d', days: 14, label: 'Due settimane prima' },
    { id: '7d', days: 7, label: 'Una settimana prima' },
    { id: '2d', days: 2, label: 'Due giorni prima' }
];

export const WINDOW_IDS = WINDOWS.map((window) => window.id);

export const windowById = (id) => WINDOWS.find((window) => window.id === id) ?? null;

export const EMPTY_STATE = { version: 1, sent: {}, drafts: {} };

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stessa forma degli id evento accettata dal validatore. */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

/* ==========================================================
   FINESTRE
   ========================================================== */

/**
 * Le tre finestre di un evento, con lo stato di ciascuna.
 *
 * `superseded` marca le finestre superate da una piu vicina gia aperta: a un
 * giorno dall'evento, mandare "mancano due settimane" sarebbe sbagliato. Restano
 * comunque azionabili - la scheda le mostra chiuse - perche l'ultima parola su
 * cosa pubblicare ce l'ha chi pubblica.
 *
 * Si misura su `dateTime` e non su `endTime`: ricordare un evento gia iniziato
 * non ha senso.
 */
export function windowsFor(event, now = Date.now()) {
    const start = Date.parse(event?.dateTime ?? '');
    if (Number.isNaN(start)) return [];

    const windows = WINDOWS.map((window) => {
        const dueAt = start - window.days * DAY_MS;
        return { ...window, dueAt: new Date(dueAt).toISOString(), due: now >= dueAt };
    });

    // Le finestre sono in ordine decrescente di anticipo: una e superata se
    // dopo di lei ce n'e un'altra gia aperta.
    return windows.map((window, index) => ({
        ...window,
        superseded: window.due && windows.slice(index + 1).some((next) => next.due)
    }));
}

/**
 * Gli eventi per cui ha ancora senso un promemoria: attivi e non ancora
 * iniziati, dal piu imminente. Gli inattivi sono nascosti dal sito, e ricordare
 * qualcosa che non si vede sarebbe una figuraccia.
 */
export function upcomingEvents(eventsDoc, now = Date.now()) {
    const list = Array.isArray(eventsDoc) ? eventsDoc : (eventsDoc?.events ?? []);

    return list
        .filter((event) => event && event.active !== false)
        .filter((event) => {
            const start = Date.parse(event.dateTime ?? '');
            return !Number.isNaN(start) && start > now;
        })
        .sort((a, b) => Date.parse(a.dateTime) - Date.parse(b.dateTime));
}

/* ==========================================================
   STATO
   ========================================================== */

/**
 * Tiene solo le chiavi che questo modulo sa leggere.
 *
 * Il file lo scrive solo il server, quindi non e validazione di input: e una
 * difesa contro un blob modificato a mano o rimasto da una versione precedente,
 * che altrimenti farebbe comparire nella scheda finestre o canali inesistenti.
 */
function normalizeSection(raw) {
    const clean = {};
    if (!raw || typeof raw !== 'object') return clean;

    for (const [eventId, windows] of Object.entries(raw)) {
        if (!ID_PATTERN.test(eventId) || !windows || typeof windows !== 'object') continue;

        for (const [windowId, channels] of Object.entries(windows)) {
            if (!WINDOW_IDS.includes(windowId) || !channels || typeof channels !== 'object') continue;

            for (const [channelId, entry] of Object.entries(channels)) {
                if (!channelById(channelId) || !entry || typeof entry !== 'object') continue;
                clean[eventId] ??= {};
                clean[eventId][windowId] ??= {};
                clean[eventId][windowId][channelId] = entry;
            }
        }
    }
    return clean;
}

/**
 * Legge lo stato dal container privato.
 *
 * Un blob che non c'e non e un errore: e il primo avvio, prima che sia stato
 * mandato qualsiasi promemoria. Il chiamante lo riconosce da `etag: null` e
 * scrivera con `ifAbsent`.
 */
export async function readState(store) {
    const { etag, data } = await store.readPrivate(REMINDERS_BLOB);

    return {
        etag,
        data: {
            version: 1,
            sent: normalizeSection(data?.sent),
            drafts: normalizeSection(data?.drafts)
        }
    };
}

const entryAt = (state, section, eventId, windowId, channelId) =>
    state?.[section]?.[eventId]?.[windowId]?.[channelId] ?? null;

export const getRecord = (state, eventId, windowId, channelId) =>
    entryAt(state, 'sent', eventId, windowId, channelId);

export const getDraft = (state, eventId, windowId, channelId) =>
    entryAt(state, 'drafts', eventId, windowId, channelId);

/**
 * Lo stato con una voce aggiunta, sostituita o tolta. `value: null` toglie.
 *
 * Copia invece di modificare: lo stato letto viene usato anche per rispondere
 * al chiamante quando la scrittura fallisce, e non deve risultare gia cambiato.
 * Togliendo una voce si potano anche i livelli rimasti vuoti, se no il file si
 * riempirebbe di gusci di eventi passati.
 */
export function withEntry(state, section, eventId, windowId, channelId, value) {
    const next = { ...state, [section]: { ...state[section] } };
    const events = next[section];

    if (value === null) {
        if (!events[eventId]?.[windowId]?.[channelId]) return next;

        const windows = { ...events[eventId] };
        const channels = { ...windows[windowId] };
        delete channels[channelId];

        if (Object.keys(channels).length > 0) windows[windowId] = channels;
        else delete windows[windowId];

        if (Object.keys(windows).length > 0) events[eventId] = windows;
        else delete events[eventId];

        return next;
    }

    events[eventId] = {
        ...events[eventId],
        [windowId]: { ...events[eventId]?.[windowId], [channelId]: value }
    };
    return next;
}

export const withRecord = (state, eventId, windowId, channelId, record) =>
    withEntry(state, 'sent', eventId, windowId, channelId, record);

export const withDraft = (state, eventId, windowId, channelId, draft) =>
    withEntry(state, 'drafts', eventId, windowId, channelId, draft);

/** Il documento come finisce sul blob, con la firma di chi ha scritto. */
export const documentFrom = (state, by) => ({
    version: 1,
    sent: state.sent,
    drafts: state.drafts,
    updatedAt: new Date().toISOString(),
    updatedBy: by
});

/* ==========================================================
   LA RISPOSTA DELLA SCHEDA
   ========================================================== */

/**
 * Il testo che verrebbe pubblicato adesso su un canale, con la sua misura.
 *
 * La bozza, se c'e, vince sul template: e il testo che l'admin ha scelto, o
 * riscrivendolo o facendoselo riscrivere. Il conteggio si rifa qui perche una
 * bozza modificata a mano puo aver sforato dopo il salvataggio.
 */
export function textFor(channel, event, windowId, draft) {
    const template = channel.buildText(event, windowId);
    if (!draft?.text) return { ...template, source: 'template', draft: null };

    const length = countChars(draft.text);
    return {
        text: draft.text,
        length,
        limit: template.limit,
        truncated: length > template.limit,
        notes: length > template.limit
            ? [`La bozza supera di ${length - template.limit} caratteri il limite del canale: accorciala prima di pubblicare.`]
            : [],
        requiresImage: template.requiresImage,
        imageUrl: template.imageUrl,
        source: draft.source ?? 'manual',
        draft: { text: draft.text, source: draft.source ?? 'manual', at: draft.at ?? null, by: draft.by ?? null }
    };
}

/**
 * Tutto quello che serve alla scheda dell'admin per disegnarsi, gia pronto.
 *
 * Il browser non compone nessun testo: lo riceve fatto. Cosi quello che si
 * legge nell'anteprima e esattamente quello che parte, e non due stringhe
 * costruite da due pezzi di codice diversi che un giorno divergono.
 */
export function buildOverview({ eventsDoc, state, now = Date.now(), telegram = {}, ai = {} }) {
    const events = upcomingEvents(eventsDoc, now).map((event) => ({
        id: event.id,
        title: event.title ?? '',
        dateTime: event.dateTime,
        timezone: event.timezone ?? null,
        eventUrl: event.eventUrl ?? null,
        imageUrl: event.imageUrl ?? null,
        when: formatWhen(event),
        where: formatWhere(event),

        windows: windowsFor(event, now).map((window) => ({
            id: window.id,
            label: window.label,
            dueAt: window.dueAt,
            due: window.due,
            superseded: window.superseded,

            channels: Object.fromEntries(CHANNELS.map((channel) => [
                channel.id,
                {
                    ...textFor(channel, event, window.id, getDraft(state, event.id, window.id, channel.id)),
                    sent: getRecord(state, event.id, window.id, channel.id)
                }
            ]))
        }))
    }));

    return {
        now: new Date(now).toISOString(),
        telegram: { configured: Boolean(telegram.configured) },
        ai: { configured: Boolean(ai.configured), model: ai.model ?? null },
        channels: channelSummaries(),
        windows: WINDOWS.map(({ id, label, days }) => ({ id, label, days })),
        events
    };
}
