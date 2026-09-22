import { app } from '@azure/functions';

import { requireRole } from '../lib/auth.js';
import { blobStore, ConflictError } from '../lib/blob.js';
import { channelById, CHANNEL_IDS, countChars } from '../lib/reminder-channels.js';
import {
    buildOverview,
    documentFrom,
    getDraft,
    getRecord,
    readState,
    REMINDERS_BLOB,
    textFor,
    upcomingEvents,
    windowById,
    WINDOW_IDS,
    withDraft,
    withRecord
} from '../lib/reminders.js';
import { sendReminder, telegramConfig, TelegramError } from '../lib/telegram.js';
import { aiConfig, composeDrafts, ComposeError, createClient } from '../lib/ai-compose.js';
import { ok, badRequest, unauthorized, forbidden, notFound, conflict, json, serverError } from '../lib/http.js';

/**
 * I promemoria degli eventi in arrivo.
 *
 * Non c'e nessun cron dietro, ed e una scelta: le managed functions di Static
 * Web Apps sono solo HTTP e un pianificatore andrebbe messo fuori, ma
 * soprattutto un promemoria e un post a nome della community, e chi lo firma
 * vuole vederlo prima che esca. La scheda dell'admin dice cosa e dovuto, mostra
 * il testo gia adattato al limite di ogni canale, e aspetta un clic.
 *
 * TRE ROUTE, TRE VERBI DIVERSI:
 *  - GET  /api/reminders          cosa c'e da mandare e con che testo
 *  - POST /api/reminders/send     pubblica davvero (solo Telegram, oggi)
 *  - POST /api/reminders/mark     registra un post pubblicato a mano altrove
 *  - POST /api/reminders/compose  fa riscrivere i quattro testi a Claude
 *  - POST /api/reminders/draft    salva o annulla un testo modificato a mano
 *
 * `mark` esiste perche tre canali su quattro non hanno un'API utilizzabile: si
 * copia il testo, si incolla, e si torna qui a dire che e fatto. Senza quel
 * segno la scheda continuerebbe a chiedere lo stesso promemoria.
 */

const EVENTS_BLOB = 'events.json';

/** Chi ha premuto il pulsante, come per gli altri documenti. */
const authorOf = (auth) => auth.principal.userDetails ?? auth.principal.userId ?? 'sconosciuto';

/**
 * Il controllo comune a `send` e `mark`.
 *
 * Sta tutto prima di qualunque effetto: quando questa funzione ha finito, o si
 * e gia risposto con un errore, oppure si sa che l'evento esiste, che e ancora
 * futuro, e che nessuno ha modificato lo stato nel frattempo. Solo allora si
 * chiama Telegram, che e l'unica cosa irreversibile di tutto il giro.
 */
async function prepare(request, deps, { needsChannel = true } = {}) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return { error: auth.status === 401 ? unauthorized() : forbidden() };

    let body;
    try {
        body = await request.json();
    } catch {
        return { error: badRequest('invalid-json') };
    }

    const issues = [];
    if (!WINDOW_IDS.includes(body?.window)) {
        issues.push({ path: 'window', message: `valore non ammesso, usa uno tra: ${WINDOW_IDS.join(', ')}` });
    }
    if (needsChannel && !CHANNEL_IDS.includes(body?.channel)) {
        issues.push({ path: 'channel', message: `valore non ammesso, usa uno tra: ${CHANNEL_IDS.join(', ')}` });
    }
    if (typeof body?.eventId !== 'string' || body.eventId === '') {
        issues.push({ path: 'eventId', message: 'obbligatorio' });
    }
    if (issues.length > 0) return { error: badRequest('validation', { issues }) };

    const { store, now } = deps;
    const moment = now();

    const events = await store.readPrivate(EVENTS_BLOB);
    const event = upcomingEvents(events.data, moment).find((candidate) => candidate.id === body.eventId);
    if (!event) {
        // Distinguere le due cose serve all'admin: un evento che non c'e e un
        // errore di richiesta, uno gia passato e solo un promemoria inutile.
        const exists = (events.data?.events ?? []).some((candidate) => candidate?.id === body.eventId);
        return { error: exists ? json(422, { error: 'event-not-upcoming' }) : notFound('event-not-found') };
    }

    const state = await readState(store);

    // L'If-Match arriva dalla scheda con l'ETag che aveva quando l'ha disegnata.
    // Se non corrisponde, qualcuno ha gia agito: si ferma prima di pubblicare un
    // doppione, e si restituisce la copia buona cosi la scheda si riallinea.
    const expected = request.headers.get('if-match');
    if (expected && expected !== state.etag) {
        return { error: conflict({ etag: state.etag, data: state.data }) };
    }

    return {
        auth,
        body,
        event,
        window: windowById(body.window),
        channel: needsChannel ? channelById(body.channel) : null,
        state: state.data,
        etag: state.etag,
        now: moment
    };
}

/** Scrive lo stato con la difesa dal conflitto gia impostata. */
const persist = (store, state, etag, auth) =>
    store.writePrivate(REMINDERS_BLOB, documentFrom(state, authorOf(auth)), { ifMatch: etag ?? undefined, ifAbsent: !etag });

/* ==========================================================
   GET /api/reminders
   ========================================================== */

export async function handleGetReminders(request, context, deps = {}) {
    const auth = requireRole(request, 'admin');
    if (!auth.ok) return auth.status === 401 ? unauthorized() : forbidden();

    const { store = blobStore, now = Date.now, env = process.env } = deps;

    const ai = aiConfig(env);

    try {
        const [events, state] = await Promise.all([store.readPrivate(EVENTS_BLOB), readState(store)]);

        return ok({
            etag: state.etag,
            ...buildOverview({
                eventsDoc: events.data,
                state: state.data,
                now: now(),
                telegram: { configured: Boolean(telegramConfig(env)) },
                ai: { configured: Boolean(ai), model: ai?.deployment ?? null }
            })
        });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
}

/* ==========================================================
   POST /api/reminders/send
   ========================================================== */

export async function handleSendReminder(request, context, deps = {}) {
    const { store = blobStore, fetchImpl = fetch, now = Date.now, env = process.env } = deps;

    let prepared;
    try {
        prepared = await prepare(request, { store, now });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
    if (prepared.error) return prepared.error;

    const { auth, event, window, channel, state, etag } = prepared;

    if (typeof channel.send !== 'function' && channel.mode !== 'api') {
        // WhatsApp, LinkedIn e Instagram: il testo si copia, non si spedisce.
        return badRequest('channel-not-sendable', { channel: channel.id });
    }

    const already = getRecord(state, event.id, window.id, channel.id);
    if (already) return conflict({ etag, sent: already, error: 'already-sent' });

    const draft = getDraft(state, event.id, window.id, channel.id);
    const message = textFor(channel, event, window.id, draft);
    if (message.length > message.limit) {
        return badRequest('text-too-long', { length: message.length, limit: message.limit });
    }

    const credentials = telegramConfig(env);
    if (!credentials) return json(503, { error: 'telegram-not-configured' });

    let result;
    try {
        result = await sendReminder({
            ...credentials,
            text: message.text,
            imageUrl: event.imageUrl
            // Niente parse_mode: i testi sono semplici per scelta, vedi
            // reminder-channels.js. Cosi quello che si copia e quello che esce.
        }, { fetchImpl });
    } catch (error) {
        if (error instanceof TelegramError) {
            if (error.status >= 500) context.warn?.(`[reminders/send] ${error.code}`, error.extra);
            return json(error.status, { error: error.code, ...error.extra });
        }
        return serverError(context, error, 'send-failed');
    }

    const record = {
        at: new Date(prepared.now).toISOString(),
        by: authorOf(auth),
        mode: 'api',
        method: result.method,
        messageId: result.messageId
    };
    const notes = result.fellBack
        ? ['La copertina non e stata accettata da Telegram: il promemoria e uscito come solo testo.']
        : [];

    try {
        const written = await persist(store, withRecord(state, event.id, window.id, channel.id, record), etag, auth);
        return ok({ etag: written.etag, sent: record, recorded: true, notes });
    } catch (error) {
        // IL POST E GIA USCITO. Qualunque cosa sia andata storta adesso, non si
        // puo rispondere con un errore: l'admin lo rimanderebbe. Si risponde che
        // e partito ma non risulta registrato, e la scheda dice di segnarlo.
        context.error(error);
        const conflicted = error instanceof ConflictError;
        return ok({
            etag: null,
            sent: record,
            recorded: false,
            reason: conflicted ? 'conflict' : 'storage-unavailable',
            notes
        });
    }
}

/* ==========================================================
   POST /api/reminders/mark
   ========================================================== */

export async function handleMarkReminder(request, context, deps = {}) {
    const { store = blobStore, now = Date.now } = deps;

    let prepared;
    try {
        prepared = await prepare(request, { store, now });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
    if (prepared.error) return prepared.error;

    const { auth, body, event, window, channel, state, etag } = prepared;

    // `sent: false` serve a correggere un segno messo per sbaglio. Non ritira
    // niente da nessuna parte: il post, se e uscito, resta dov'e.
    const record = body.sent === false ? null : {
        at: new Date(prepared.now).toISOString(),
        by: authorOf(auth),
        mode: 'manual'
    };

    try {
        const written = await persist(store, withRecord(state, event.id, window.id, channel.id, record), etag, auth);
        return ok({ etag: written.etag, sent: record });
    } catch (error) {
        if (error instanceof ConflictError) {
            const current = await readState(store);
            return conflict({ etag: current.etag, data: current.data });
        }
        return serverError(context, error, 'storage-unavailable');
    }
}

/* ==========================================================
   POST /api/reminders/compose
   ========================================================== */

/**
 * Fa riscrivere i quattro testi e li salva come bozze.
 *
 * Non pubblica niente: sostituisce solo cio che la scheda mostrera al posto dei
 * template. E una scrittura sola per tutta la finestra, perche la chiamata al
 * modello e una: chiedere quattro volte costerebbe quattro volte e produrrebbe
 * quattro testi che non si sono visti fra loro.
 */
export async function handleComposeReminder(request, context, deps = {}) {
    const { store = blobStore, now = Date.now, env = process.env } = deps;

    let prepared;
    try {
        prepared = await prepare(request, { store, now }, { needsChannel: false });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
    if (prepared.error) return prepared.error;

    const { auth, event, window, state, etag } = prepared;

    const config = aiConfig(env);
    if (!config) return json(503, { error: 'ai-not-configured' });

    let composed;
    try {
        const client = deps.client ?? createClient(config);
        composed = await composeDrafts(event, window.id, { client, deployment: config.deployment });
    } catch (error) {
        if (error instanceof ComposeError) {
            if (error.status >= 500) context.warn?.(`[reminders/compose] ${error.code}`, error.extra);
            return json(error.status, { error: error.code, ...error.extra });
        }
        return serverError(context, error, 'compose-failed');
    }

    const at = new Date(prepared.now).toISOString();
    const by = authorOf(auth);

    let next = state;
    for (const [channelId, draft] of Object.entries(composed.channels)) {
        next = withDraft(next, event.id, window.id, channelId, {
            text: draft.text,
            source: 'ai',
            model: composed.model,
            at,
            by
        });
    }

    try {
        const written = await persist(store, next, etag, auth);
        return ok({ etag: written.etag, drafts: composed.channels, model: composed.model });
    } catch (error) {
        if (error instanceof ConflictError) {
            const current = await readState(store);
            return conflict({ etag: current.etag, data: current.data });
        }
        return serverError(context, error, 'storage-unavailable');
    }
}

/* ==========================================================
   POST /api/reminders/draft
   ========================================================== */

/**
 * Salva un testo modificato a mano, oppure lo toglie per tornare al template.
 *
 * Il limite si controlla qui e non solo nel browser: la bozza salvata e quella
 * che poi parte, e un testo troppo lungo verrebbe rifiutato da Telegram al
 * momento peggiore, cioe al clic su Pubblica.
 */
export async function handleDraftReminder(request, context, deps = {}) {
    const { store = blobStore, now = Date.now } = deps;

    let prepared;
    try {
        prepared = await prepare(request, { store, now });
    } catch (error) {
        return serverError(context, error, 'storage-unavailable');
    }
    if (prepared.error) return prepared.error;

    const { auth, body, event, window, channel, state, etag } = prepared;

    let draft = null;
    if (body.text !== null && body.text !== undefined) {
        if (typeof body.text !== 'string' || body.text.trim() === '') {
            return badRequest('validation', { issues: [{ path: 'text', message: 'obbligatorio' }] });
        }

        const limit = channel.limitFor(event);
        const length = countChars(body.text);
        if (length > limit) return badRequest('text-too-long', { length, limit });

        draft = {
            text: body.text,
            source: 'manual',
            at: new Date(prepared.now).toISOString(),
            by: authorOf(auth)
        };
    }

    try {
        const written = await persist(store, withDraft(state, event.id, window.id, channel.id, draft), etag, auth);
        return ok({ etag: written.etag, draft });
    } catch (error) {
        if (error instanceof ConflictError) {
            const current = await readState(store);
            return conflict({ etag: current.etag, data: current.data });
        }
        return serverError(context, error, 'storage-unavailable');
    }
}

/* ==========================================================
   REGISTRAZIONE
   ========================================================== */

app.http('reminders', {
    route: 'reminders',
    methods: ['GET'],
    authLevel: 'anonymous',
    handler: handleGetReminders
});

app.http('reminders-send', {
    route: 'reminders/send',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handleSendReminder
});

app.http('reminders-mark', {
    route: 'reminders/mark',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handleMarkReminder
});

app.http('reminders-compose', {
    route: 'reminders/compose',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handleComposeReminder
});

app.http('reminders-draft', {
    route: 'reminders/draft',
    methods: ['POST'],
    authLevel: 'anonymous',
    handler: handleDraftReminder
});
