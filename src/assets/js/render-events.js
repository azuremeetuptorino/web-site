import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_EVENT } from './config.js';

const BADGE_LABEL = {
    upcoming: 'In arrivo',
    past: 'Terminato'
};

const DEFAULT_TIMEZONE = 'Europe/Rome';

/**
 * Un evento e "passato" quando la sua fine (o, senza fine, il suo inizio) e
 * gia trascorsa. `status` e un residuo dei dati vecchi: se c'e, vince.
 */
export function isPast(event, now = Date.now()) {
    if (event.status === 'past') return true;
    if (event.status === 'upcoming') return false;
    const reference = event.endTime ?? event.dateTime;
    return reference ? Date.parse(reference) < now : false;
}

/**
 * Prossimi in ordine cronologico crescente, poi passati dal piu recente.
 * E l'ordine con cui la gente legge un calendario di community.
 */
export function sortEvents(events, now = Date.now()) {
    const upcoming = [];
    const past = [];
    for (const event of events) {
        (isPast(event, now) ? past : upcoming).push(event);
    }
    const byDate = (a, b) => Date.parse(a.dateTime ?? 0) - Date.parse(b.dateTime ?? 0);
    upcoming.sort(byDate);
    past.sort((a, b) => byDate(b, a));
    return [...upcoming, ...past];
}

/**
 * "ven 16 ott 2026, 15:00", sempre nell'ora del luogo dell'evento.
 *
 * Le date sul blob sono in UTC: senza il fuso, chi guarda il sito da un altro
 * paese leggerebbe l'orario del suo computer, non quello a cui presentarsi.
 */
export function formatWhen(event) {
    if (!event.dateTime) return '';
    const date = new Date(event.dateTime);
    if (Number.isNaN(date.getTime())) return '';

    const options = { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' };
    try {
        return new Intl.DateTimeFormat('it-IT', { ...options, timeZone: event.timezone || DEFAULT_TIMEZONE }).format(date);
    } catch {
        // Un fuso sconosciuto al browser non deve far sparire la data.
        return new Intl.DateTimeFormat('it-IT', options).format(date);
    }
}

/** "Online", "Aula 10 dell'ITS ICT Piemonte · Torino" oppure la sola citta. */
export function formatWhere(event) {
    if (event.isOnline) return 'Online';
    const venue = event.venue;
    if (!venue) return '';
    // Il nome della sala se c'e, altrimenti l'indirizzo; poi la citta, salvo
    // che il nome la contenga gia ("Talent Garden Torino").
    const place = venue.name ?? venue.address ?? '';
    const city = venue.city ?? '';
    const cityRepeated = city && place.toLowerCase().includes(city.toLowerCase());
    return [place, cityRepeated ? '' : city].filter(Boolean).join(' · ');
}

function renderEvent(event, now) {
    const past = isPast(event, now);
    const title = escapeHtml(event.title);
    const image = escapeHtml(safeUrl(event.imageUrl, PLACEHOLDER_EVENT));
    const badge = past ? 'past' : 'upcoming';
    const url = safeUrl(event.eventUrl, '#');
    const external = url !== '#' ? ' target="_blank" rel="noopener noreferrer"' : '';
    const when = formatWhen(event);
    const where = formatWhere(event);

    const whenHtml = when
        ? `<p class="card-meta"><i class="bi bi-calendar-event" aria-hidden="true"></i> <time datetime="${escapeHtml(event.dateTime)}">${escapeHtml(when)}</time></p>`
        : '';
    const whereHtml = where
        ? `<p class="card-meta card-place"><i class="bi ${event.isOnline ? 'bi-camera-video' : 'bi-geo-alt'}" aria-hidden="true"></i> ${escapeHtml(where)}</p>`
        : '';

    return `<div class="swiper-slide">
    <a href="${escapeHtml(url)}"${external} class="card${past ? ' event-past' : ''}">
        <div class="card-img-wrapper">
            <span class="badge ${badge}">${escapeHtml(BADGE_LABEL[badge])}</span>
            <img src="${image}" alt="" loading="lazy">
        </div>
        <div class="card-body">
            ${whenHtml}
            <h3 class="card-title">${title}</h3>
            ${whereHtml}
        </div>
    </a>
</div>`;
}

/**
 * Riempie la track dello Swiper eventi. Gli eventi con `active: false` restano
 * sul blob ma non in pagina: e il modo per togliere un evento senza cancellarlo.
 * @returns {number} quanti eventi sono stati renderizzati
 */
export function renderEvents(container, payload, now = Date.now()) {
    const visible = (payload?.events ?? []).filter((event) => event && event.active !== false);
    const events = sortEvents(visible, now);
    container.innerHTML = events.map((event) => renderEvent(event, now)).join('\n');
    return events.length;
}
