import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_EVENT } from './config.js';

const BADGE_LABEL = {
    upcoming: 'In arrivo',
    past: 'Terminato'
};

/** Un evento e "passato" se lo dice il dato o se la data e gia trascorsa. */
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

function renderEvent(event, now) {
    const past = isPast(event, now);
    const title = escapeHtml(event.title);
    const image = escapeHtml(safeUrl(event.imageUrl, PLACEHOLDER_EVENT));
    const badge = past ? 'past' : 'upcoming';
    const url = safeUrl(event.eventUrl, '#');
    const external = url !== '#' ? ' target="_blank" rel="noopener noreferrer"' : '';

    return `<div class="swiper-slide">
    <a href="${escapeHtml(url)}"${external} class="card${past ? ' event-past' : ''}">
        <div class="card-img-wrapper">
            <span class="badge ${badge}">${escapeHtml(BADGE_LABEL[badge])}</span>
            <img src="${image}" alt="Evento" loading="lazy">
        </div>
        <div class="card-body"><h3 class="card-title">${title}</h3></div>
    </a>
</div>`;
}

/**
 * Riempie la track dello Swiper eventi.
 * @returns {number} quanti eventi sono stati renderizzati
 */
export function renderEvents(container, payload, now = Date.now()) {
    const events = sortEvents(payload?.events ?? [], now);
    container.innerHTML = events.map((event) => renderEvent(event, now)).join('\n');
    return events.length;
}
