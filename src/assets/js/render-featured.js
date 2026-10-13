import { escapeHtml, safeUrl } from './dom.js';
import { visibleEvents, isPast, formatWhen, formatWhere, eventPageUrl, DEFAULT_TIMEZONE } from './render-events.js';
import { visibleEditions, pickEdition, editionPhase, editionStart } from './render-global-azure.js';

/**
 * Gli eventi speciali: quelli di events.json con `featured: true`, che hanno
 * una pagina sul sito (/evento/?id=...) con sessioni e foto, come Global Azure
 * ma senza edizioni.
 *
 * Funzioni pure, come render-global-azure.js: i dati entrano, l'HTML esce.
 */

/** Prima dell'inizio, tra inizio e fine, dopo la fine. */
export function eventPhase(event, now = Date.now()) {
    if (isPast(event, now)) return 'past';
    const start = Date.parse(event?.dateTime ?? '');
    return Number.isFinite(start) && start <= now ? 'live' : 'upcoming';
}

/** L'evento speciale con questo id, se e pubblicato. */
export function findFeatured(payload, id) {
    return visibleEvents(payload).find((event) => event.featured && event.id === id) ?? null;
}

/* ==========================================================
   BANNER IN HOME
   ========================================================== */

/**
 * Chi va nel banner della home: un evento speciale non ancora finito, se c'e,
 * altrimenti Global Azure come sempre. Se sono in arrivo entrambi vince il
 * piu vicino; Global Azure nel suo giorno resta in vetrina.
 *
 * @returns {{kind: 'event', event: object} | {kind: 'ga'}}
 */
export function pickHomeBanner(eventsPayload, gaIndex, now = Date.now()) {
    const event = visibleEvents(eventsPayload ?? [], now).find((entry) => entry.featured && !isPast(entry, now));
    if (!event) return { kind: 'ga' };

    const edition = pickEdition(visibleEditions(gaIndex), null);
    const phase = edition ? editionPhase(edition, now) : 'unknown';
    if (phase === 'live') return { kind: 'ga' };
    if (phase === 'upcoming' && editionStart(edition) < Date.parse(event.dateTime)) return { kind: 'ga' };

    return { kind: 'event', event };
}

const dayPart = (event, options) => {
    try {
        return new Intl.DateTimeFormat('it-IT', { ...options, timeZone: event.timezone || DEFAULT_TIMEZONE })
            .format(new Date(event.dateTime));
    } catch {
        return new Intl.DateTimeFormat('it-IT', options).format(new Date(event.dateTime));
    }
};

/**
 * Il banner per un evento speciale: lo stesso di Global Azure, con giorno e
 * mese al posto dell'anno. Il conto alla rovescia lo avvia main.js.
 * @returns {number} 1 se c'e qualcosa da mostrare, 0 altrimenti
 */
export function renderFeaturedTeaser(container, event, now = Date.now()) {
    if (!event?.dateTime) return 0;

    const phase = eventPhase(event, now);
    const text = [formatWhen(event), formatWhere(event)].filter(Boolean).join(' — ');

    container.href = eventPageUrl(event);
    container.dataset.phase = phase;
    container.innerHTML = `
        <span class="ga-teaser-year ga-teaser-date" aria-hidden="true">
            <span>${escapeHtml(dayPart(event, { day: 'numeric' }))}</span>
            <small>${escapeHtml(dayPart(event, { month: 'short' }))}</small>
        </span>
        <span class="ga-teaser-body">
            <span class="ga-teaser-eyebrow">${phase === 'live' ? 'In corso ora' : 'Evento speciale'}</span>
            <strong>${escapeHtml(event.title)}</strong>
            ${text ? `<span class="ga-teaser-text">${escapeHtml(text)}</span>` : ''}
        </span>
        <span class="ga-teaser-cta">Scopri il programma <i class="bi bi-arrow-right" aria-hidden="true"></i></span>
        ${phase === 'upcoming' ? '<span class="ga-teaser-countdown" data-teaser-countdown></span>' : ''}`;
    return 1;
}

/* ==========================================================
   HERO DELLA PAGINA
   ========================================================== */

export function renderEventHeroMeta(event, phase) {
    const items = [];
    // Data e ora separate: "alle ore" passerebbe dal maiuscolo del CSS.
    const day = formatWhen(event, { weekday: 'long', month: 'long', hour: undefined, minute: undefined });
    const time = formatWhen(event, { weekday: undefined, day: undefined, month: undefined, year: undefined });
    const when = [day, time].filter(Boolean).join(' · ');
    if (when) items.push(`<li><i class="bi bi-calendar-event" aria-hidden="true"></i> <span>${escapeHtml(when)}</span></li>`);

    const where = formatWhere(event);
    if (where) {
        items.push(`<li><i class="bi ${event.isOnline ? 'bi-camera-video' : 'bi-geo-alt'}" aria-hidden="true"></i> <span>${escapeHtml(where)}</span></li>`);
    }

    const status = {
        live: ['is-live', 'In corso ora'],
        upcoming: ['is-upcoming', 'In arrivo'],
        past: ['is-past', 'Evento concluso']
    }[phase];
    if (status) items.push(`<li class="ga-status ${status[0]}"><span class="ga-status-dot" aria-hidden="true"></span> ${status[1]}</li>`);

    return items.join('');
}

/** Iscriviti finche si fa in tempo; poi, come per Global Azure, prima le foto. */
export function renderEventHeroActions(event, phase, content) {
    const actions = [];
    const registration = safeUrl(event.eventUrl, '');
    if (registration && phase !== 'past') {
        actions.push(`<a class="ga-btn ga-btn-primary" href="${escapeHtml(registration)}" target="_blank" rel="noopener noreferrer">
            <i class="bi bi-ticket-perforated" aria-hidden="true"></i> Iscriviti</a>`);
    }
    const agenda = content.sessions.length > 0 ? ['#agenda', 'bi-calendar3-week', 'Sessioni'] : null;
    const photos = content.photos.length > 0 ? ['#foto', 'bi-images', `${content.photos.length} foto`] : null;
    const order = phase === 'past' ? [photos, agenda] : [agenda, photos];
    for (const [href, icon, label] of order.filter(Boolean)) {
        actions.push(`<a class="ga-btn ${actions.length ? 'ga-btn-ghost' : 'ga-btn-primary'}" href="${href}">
            <i class="bi ${icon}" aria-hidden="true"></i> ${escapeHtml(label)}</a>`);
    }
    if (registration && phase === 'past') {
        actions.push(`<a class="ga-btn ga-btn-ghost" href="${escapeHtml(registration)}" target="_blank" rel="noopener noreferrer">
            <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Pagina dell'evento</a>`);
    }
    return actions.join('');
}
