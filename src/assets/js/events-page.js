import { loadCollection } from './data.js';
import { renderDataError } from './dom.js';
import { renderSite } from './render-site.js';
import { renderEventGrid, visibleEvents } from './render-events.js';
import {
    readFilter, filterToSearch, selectEvents, splitEvents, yearsOf,
    UPCOMING, PAST, ALL_YEARS, PAGE_SIZE
} from './events-filter.js';
import { initNav } from './nav.js';
import { initEmailCopy } from './email-copy.js';
import { MEETUP_GROUP_URL } from './config.js';

/**
 * L'archivio degli eventi: /eventi/.
 *
 * La home ne mostra cinque, qui ci sono tutti. Due sole domande da servire —
 * "quando e il prossimo?" e "di cosa avete parlato?" — e infatti i comandi sono
 * due: il segmentato Prossimi/Passati e le chip per anno, generate dai dati.
 * Niente ricerca testuale finche l'archivio non supera la quarantina di eventi:
 * prima di allora si trova prima guardando.
 *
 * Lo stato sta nella query string (`?stato=passati&anno=2025`), cosi un anno
 * dell'archivio si puo mandare a qualcuno.
 */

const el = {
    status: document.getElementById('events-status'),
    toolbar: document.getElementById('events-toolbar'),
    count: document.getElementById('events-count'),
    years: document.getElementById('events-years'),
    panel: document.getElementById('events-panel'),
    grid: document.getElementById('events-grid'),
    empty: document.getElementById('events-empty'),
    more: document.getElementById('events-more')
};

const tabs = [...document.querySelectorAll('[role="tab"][data-status]')];

let events = [];
let filter = { status: UPCOMING, year: ALL_YEARS };
let shown = PAGE_SIZE;

/* ==========================================================
   TESTI
   ========================================================== */

const plural = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function countLabel() {
    const { upcoming, past } = splitEvents(events);
    return [
        upcoming.length === 0
            ? 'Nessun evento in programma'
            : plural(upcoming.length, 'evento in programma', 'eventi in programma'),
        past.length === 0
            ? 'nessuno in archivio'
            : plural(past.length, 'evento in archivio', 'eventi in archivio')
    ].join(', ') + '.';
}

/**
 * Lo stato vuoto non e un buco: dice cosa fare.
 * Senza eventi futuri il posto giusto dove mandare qualcuno e Meetup, dove si
 * annunciano per primi.
 */
function showEmpty() {
    if (filter.status === UPCOMING) {
        renderDataError(
            el.empty,
            'Nessun evento in programma per ora.',
            MEETUP_GROUP_URL,
            'Seguici su Meetup per non perdere il prossimo'
        );
        return;
    }
    renderDataError(
        el.empty,
        filter.year === ALL_YEARS
            ? 'Ancora nessun evento in archivio.'
            : `Nessun evento nel ${filter.year}.`
    );
}

/* ==========================================================
   CHIP PER ANNO
   ========================================================== */

/**
 * Le chip si costruiscono una volta sola dai dati: sono gli anni in cui la
 * community si e trovata, non una lista scritta a mano che qualcuno dovra
 * ricordarsi di aggiornare a gennaio.
 */
function buildYearChips() {
    const years = yearsOf(events);
    el.years.replaceChildren();

    // Con gli eventi di un anno solo, filtrare per anno non filtra niente.
    if (years.length < 2) return;

    for (const year of [ALL_YEARS, ...years]) {
        const chip = document.createElement('button');
        chip.type = 'button';
        chip.className = 'chip';
        chip.dataset.year = year;
        chip.textContent = year === ALL_YEARS ? 'Tutti' : year;
        chip.setAttribute('aria-pressed', 'false');
        chip.addEventListener('click', () => setFilter({ year }));
        el.years.append(chip);
    }
}

/* ==========================================================
   RENDERING
   ========================================================== */

function syncControls() {
    for (const tab of tabs) {
        const selected = tab.dataset.status === filter.status;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        if (selected) el.panel.setAttribute('aria-labelledby', tab.id);
    }

    // Le chip valgono solo sull'archivio: sul futuro non c'e niente da filtrare.
    const chips = [...el.years.querySelectorAll('.chip')];
    el.years.hidden = filter.status !== PAST || chips.length === 0;
    for (const chip of chips) {
        chip.setAttribute('aria-pressed', String(chip.dataset.year === filter.year));
    }
}

function render({ append = false } = {}) {
    const selected = selectEvents(events, filter);
    const page = append ? selected.slice(el.grid.children.length, shown) : selected.slice(0, shown);

    renderEventGrid(el.grid, page, Date.now(), { append });

    el.empty.hidden = selected.length > 0;
    if (selected.length === 0) showEmpty();

    const remaining = selected.length - el.grid.children.length;
    el.more.hidden = remaining <= 0;
    // L'etichetta si scrive solo quando il bottone si vede: "Mostra altri 0"
    // non deve esistere nemmeno per un istante, nemmeno in un lettore di schermo.
    if (remaining > 0) el.more.textContent = `Mostra altri ${Math.min(remaining, PAGE_SIZE)}`;

    syncControls();
}

function syncUrl() {
    history.replaceState(null, '', `${location.pathname}${filterToSearch(filter)}`);
}

function setFilter(patch) {
    filter = { ...filter, ...patch };
    shown = PAGE_SIZE;
    render();
    syncUrl();
}

/* ==========================================================
   COMANDI
   ========================================================== */

for (const tab of tabs) {
    tab.addEventListener('click', () => setFilter({ status: tab.dataset.status }));

    // Frecce fra i due stati, come vuole un tablist.
    tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();

        const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
        next.focus();
        setFilter({ status: next.dataset.status });
    });
}

el.more.addEventListener('click', () => {
    shown += PAGE_SIZE;
    render({ append: true });

    // Il bottone puo essere appena sparito: senza questo il focus tornerebbe
    // in cima alla pagina, e da tastiera si perderebbe il posto.
    if (el.more.hidden) el.panel.focus();
});

/* ==========================================================
   AVVIO
   ========================================================== */

// I contenuti fissi (logo, nome, footer) arrivano da site.json come in home.
// `title: false`: il titolo della scheda qui e quello della pagina.
loadCollection('site')
    .then((payload) => renderSite(document, payload, { title: false }))
    .catch((error) => console.warn('[site] contenuti non disponibili', error));

let payload = null;

try {
    payload = await loadCollection('events');
} catch (error) {
    console.error('[events] caricamento fallito', error);
    // Il messaggio prende il posto di "Carico gli eventi...", e la pagina
    // resta in piedi: testata, footer e un posto dove andare a vederli.
    renderDataError(
        el.status,
        'Non riusciamo a caricare il calendario in questo momento.',
        MEETUP_GROUP_URL,
        'Vedi gli eventi su Meetup'
    );
}

if (payload) {
    events = visibleEvents(payload);

    el.status.hidden = true;
    el.toolbar.hidden = false;
    el.count.textContent = countLabel();

    buildYearChips();
    filter = readFilter(location.search, events);
    render();
}

initNav();
initEmailCopy();
