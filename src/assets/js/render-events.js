import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_EVENT } from './config.js';

/**
 * Le card degli eventi, in due formati.
 *
 * La home ne mostra cinque in carosello, la pagina /eventi/ le mostra tutte in
 * griglia con la descrizione. E la stessa card: cambia solo l'involucro e se il
 * testo c'e o no, perche due markup diversi per la stessa cosa vorrebbe dire
 * correggere ogni bug due volte.
 */

const BADGE_LABEL = {
    upcoming: 'In arrivo',
    past: 'Terminato'
};

/** Fuso di riferimento quando un evento non ne porta uno: la community e a Torino. */
export const DEFAULT_TIMEZONE = 'Europe/Rome';

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
 * E l'ordine con cui la gente legge un calendario di community, ed e anche
 * l'ordine giusto per tagliare i primi cinque: si vede prima cosa sta per
 * succedere, e in mancanza di futuro cosa e appena successo.
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
 * La lista che vede il pubblico: solo gli eventi attivi, nell'ordine di sopra.
 * `active: false` toglie un evento dal sito senza cancellarlo dall'archivio.
 */
export function visibleEvents(payload, now = Date.now()) {
    const list = Array.isArray(payload) ? payload : (payload?.events ?? []);
    return sortEvents(list.filter((event) => event && event.active !== false), now);
}

/**
 * "ven 16 ott 2026, 15:00", sempre nell'ora del luogo dell'evento.
 *
 * Le date sul blob sono in UTC: senza il fuso, chi guarda il sito da un altro
 * paese leggerebbe l'orario del suo computer, non quello a cui presentarsi.
 */
export function formatWhen(event, options = {}) {
    if (!event.dateTime) return '';
    const date = new Date(event.dateTime);
    if (Number.isNaN(date.getTime())) return '';

    const format = {
        weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
        hour: '2-digit', minute: '2-digit',
        ...options
    };
    try {
        return new Intl.DateTimeFormat('it-IT', { ...format, timeZone: event.timezone || DEFAULT_TIMEZONE }).format(date);
    } catch {
        // Un fuso sconosciuto al browser non deve far sparire la data.
        return new Intl.DateTimeFormat('it-IT', format).format(date);
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

/**
 * Una card. `excerpt: true` aggiunge la descrizione: in griglia c'e lo spazio
 * per dire di cosa si parla, nel carosello no.
 */
export function eventCard(event, now = Date.now(), { excerpt = false } = {}) {
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
    const textHtml = excerpt && event.excerpt
        ? `<p class="card-excerpt">${escapeHtml(event.excerpt)}</p>`
        : '';
    const whereHtml = where
        ? `<p class="card-meta card-place"><i class="bi ${event.isOnline ? 'bi-camera-video' : 'bi-geo-alt'}" aria-hidden="true"></i> ${escapeHtml(where)}</p>`
        : '';

    return `<a href="${escapeHtml(url)}"${external} class="card${past ? ' event-past' : ''}">
    <div class="card-img-wrapper">
        <span class="badge ${badge}">${escapeHtml(BADGE_LABEL[badge])}</span>
        <img src="${image}" alt="" loading="lazy">
    </div>
    <div class="card-body">
        ${whenHtml}
        <h3 class="card-title">${title}</h3>
        ${textHtml}
        ${whereHtml}
    </div>
</a>`;
}

/**
 * Riempie la track dello Swiper in home.
 *
 * `limit` e il motivo per cui la home non e l'archivio: cinque card bastano a
 * dire "questa community si incontra davvero", e tutto il resto sta in
 * /eventi/, dove si puo cercare invece di trascinare.
 *
 * @returns {number} quante card sono state renderizzate
 */
export function renderEvents(container, payload, now = Date.now(), { limit } = {}) {
    const events = visibleEvents(payload, now);
    const shown = limit ? events.slice(0, limit) : events;

    container.innerHTML = shown
        .map((event) => `<div class="swiper-slide">${eventCard(event, now)}</div>`)
        .join('\n');
    return shown.length;
}

/**
 * Riempie la griglia dell'archivio. Riceve gli eventi gia filtrati: cosa
 * mostrare lo decide events-filter.js, qui si disegna e basta.
 *
 * `append` serve a "Mostra altri": riscrivere tutta la griglia butterebbe via
 * e ricostruirebbe anche le card che sono gia sotto gli occhi di chi legge.
 *
 * @returns {number} quante card sono state aggiunte
 */
export function renderEventGrid(container, events, now = Date.now(), { append = false } = {}) {
    const html = events.map((event) => eventCard(event, now, { excerpt: true })).join('\n');

    if (append) container.insertAdjacentHTML('beforeend', html);
    else container.innerHTML = html;

    return events.length;
}
