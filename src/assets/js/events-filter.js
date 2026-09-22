import { isPast, DEFAULT_TIMEZONE } from './render-events.js';

/**
 * Cosa mostrare nell'archivio: logica pura, senza DOM.
 *
 * Sta a parte per due motivi. Il primo e che si puo provare senza un browser
 * (vedi api/test/events-view.test.js). Il secondo e che sono le uniche due
 * domande che porta chi arriva sulla pagina — "quando e il prossimo?" e "di
 * cosa avete parlato?" — e vale la pena che si leggano in un file solo.
 */

export const UPCOMING = 'prossimi';
export const PAST = 'passati';

const STATES = [UPCOMING, PAST];

/** Tutti gli anni insieme. Non e un anno: e l'assenza di filtro. */
export const ALL_YEARS = 'tutti';

/** Quante card alla volta prima di "Mostra altri". */
export const PAGE_SIZE = 12;

/**
 * L'anno dell'evento nel SUO fuso, non in UTC.
 *
 * `dateTime.slice(0, 4)` sarebbe piu corto e sbagliato: un evento la sera del
 * 31 dicembre a Roma e gia l'anno dopo in UTC, e finirebbe nella chip
 * sbagliata proprio nel caso in cui l'anno conta.
 */
export function yearOf(event) {
    const date = new Date(event?.dateTime ?? '');
    if (Number.isNaN(date.getTime())) return '';

    try {
        return new Intl.DateTimeFormat('en-US', {
            timeZone: event.timezone || DEFAULT_TIMEZONE,
            year: 'numeric'
        }).format(date);
    } catch {
        return String(date.getFullYear());
    }
}

/** @returns {{upcoming: object[], past: object[]}} nell'ordine in cui arrivano. */
export function splitEvents(events, now = Date.now()) {
    const upcoming = [];
    const past = [];
    for (const event of events) {
        (isPast(event, now) ? past : upcoming).push(event);
    }
    return { upcoming, past };
}

/** Gli anni degli eventi passati, dal piu recente. Sono le chip. */
export function yearsOf(events, now = Date.now()) {
    const years = new Set();
    for (const event of splitEvents(events, now).past) {
        const year = yearOf(event);
        if (year) years.add(year);
    }
    return [...years].sort().reverse();
}

/**
 * Lo stato iniziale, letto dalla query string e corretto con quello che c'e
 * davvero.
 *
 * Due correzioni deliberate: senza eventi futuri si apre su "Passati", perche
 * una pagina che si apre su una sezione vuota sembra rotta; e un anno che
 * nessun evento porta viene ignorato invece di dare zero risultati, perche in
 * un link vecchio quell'anno puo semplicemente non esserci piu.
 *
 * @param {string} search  location.search
 */
export function readFilter(search, events, now = Date.now()) {
    const parameters = new URLSearchParams(search ?? '');
    const { upcoming } = splitEvents(events, now);

    const asked = parameters.get('stato');
    const status = STATES.includes(asked)
        ? asked
        : (upcoming.length > 0 ? UPCOMING : PAST);

    const askedYear = parameters.get('anno');
    const year = askedYear && yearsOf(events, now).includes(askedYear) ? askedYear : ALL_YEARS;

    return { status, year };
}

/** Lo stato come query string, da rimettere nella barra degli indirizzi. */
export function filterToSearch({ status, year }) {
    const parameters = new URLSearchParams();
    if (status) parameters.set('stato', status);
    if (status === PAST && year && year !== ALL_YEARS) parameters.set('anno', year);
    const query = parameters.toString();
    return query ? `?${query}` : '';
}

/**
 * Gli eventi da mostrare per lo stato corrente.
 * L'ordine e gia quello giusto: `visibleEvents` mette i prossimi in avanti nel
 * tempo e i passati all'indietro, che e come si legge un archivio.
 */
export function selectEvents(events, { status, year }, now = Date.now()) {
    const { upcoming, past } = splitEvents(events, now);
    if (status === UPCOMING) return upcoming;
    if (!year || year === ALL_YEARS) return past;
    return past.filter((event) => yearOf(event) === year);
}
