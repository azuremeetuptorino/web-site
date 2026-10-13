import { loadCollection } from './data.js';
import { renderDataError, escapeHtml, safeUrl } from './dom.js';
import { renderSite } from './render-site.js';
import { initNav } from './nav.js';
import { initEmailCopy } from './email-copy.js';
import {
    visibleEditions, pickEdition, editionPhase,
    renderHeroMeta, renderHeroActions, statsFor, renderStats, renderEditionSwitch,
    renderSpeakers, renderGaSponsors, renderEditionCards, sectionOrder, editionStart
} from './render-global-azure.js';
import { initContentSections, normalizeContent } from './content-sections.js';
import { initHeroNetwork } from './hero-network.js';
import { startCountdown } from './hero.js';
import { initReveal } from './reveal.js';
import { initTilt } from './tilt.js';

/**
 * La pagina /global-azure/: un'edizione per volta, scelta con `?anno=AAAA`
 * (senza, quella segnata come corrente), piu l'archivio delle altre.
 *
 * Due letture dal blob: l'indice (piccolo, tutte le edizioni) e i contenuti
 * dell'anno aperto. Le miniature dell'archivio arrivano dopo, e solo quando
 * l'archivio sta per entrare nello schermo.
 *
 * Cambiare edizione non ricarica la pagina: si riscrivono le sezioni e si
 * aggiunge una voce alla cronologia, cosi "indietro" torna all'anno di prima.
 */

const EMPTY = { tracks: [], speakers: [], sessions: [], photos: [], sponsors: [] };

const $ = (id) => document.getElementById(id);

const el = {
    hero: $('ga-hero'),
    kicker: $('ga-kicker'),
    year: $('ga-hero-year'),
    tagline: $('ga-tagline'),
    meta: $('ga-meta'),
    countdown: $('ga-countdown'),
    actions: $('ga-actions'),
    switcher: $('ga-edition-switch'),
    statsWrap: $('ga-stats-wrap'),
    stats: $('ga-stats'),
    story: $('ga-story'),
    storyText: $('ga-story-text'),
    subnav: $('ga-subnav'),
    agendaSection: $('agenda'),
    agenda: $('ga-agenda'),
    trackFilter: $('ga-track-filter'),
    speakersSection: $('speaker'),
    speakers: $('ga-speakers'),
    gallerySection: $('foto'),
    gallery: $('ga-gallery'),
    galleryMore: $('ga-gallery-more'),
    sponsorsSection: $('sponsor'),
    sponsors: $('ga-sponsors'),
    editionsSection: $('edizioni'),
    editions: $('ga-editions'),
    status: $('ga-status'),
    dialog: $('ga-dialog'),
    dialogBody: $('ga-dialog-body'),
    lightbox: $('ga-lightbox'),
    lightboxStrip: $('ga-lightbox-strip')
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let editions = [];
let edition = null;
let content = EMPTY;
const cache = new Map();

const sections = initContentSections(el, () => content);

/* ==========================================================
   DATI
   ========================================================== */

/** I contenuti di un anno. Un anno senza documento e un anno senza contenuti, non un errore. */
function contentFor(id) {
    if (!cache.has(id)) {
        cache.set(id, loadCollection(`global-azure/${id}`)
            .then(normalizeContent)
            .catch((error) => {
                console.warn(`[global-azure] contenuti ${id} non disponibili`, error);
                return EMPTY;
            }));
    }
    return cache.get(id);
}

/* ==========================================================
   RENDERING
   ========================================================== */

/**
 * Prima dell'evento si arriva per il programma, dopo per le foto: per
 * un'edizione conclusa la galleria sale sopra agenda e speaker. Si spostano
 * i nodi, non si usa `order` nel CSS, cosi segue anche l'ordine di lettura e
 * di tabulazione; il sotto-menu si riordina allo stesso modo.
 */
function orderSections(phase) {
    const sponsorLink = el.subnav.querySelector('a[href="#sponsor"]')?.parentElement;
    for (const id of sectionOrder(edition, phase)) {
        el.sponsorsSection.before($(id));
        const link = el.subnav.querySelector(`a[href="#${id}"]`)?.parentElement;
        if (link && sponsorLink) sponsorLink.before(link);
    }
}

let stopCountdown = () => {};

function renderCountdown(phase) {
    stopCountdown();
    const start = editionStart(edition);
    const visible = phase === 'upcoming' && Number.isFinite(start);
    el.countdown.hidden = !visible;
    stopCountdown = visible
        ? startCountdown(el.countdown, start, { onEnd: () => { el.countdown.hidden = true; } })
        : () => {};
}

function show(section, visible) {
    section.hidden = !visible;
    const link = el.subnav.querySelector(`a[href="#${section.id}"]`);
    if (link) link.parentElement.hidden = !visible;
}

function renderHead(phase) {
    const title = edition.title || `Global Azure Torino ${edition.id}`;
    document.title = `${title} | Azure Meetup Torino`;
    document.querySelector('meta[name="description"]')
        ?.setAttribute('content', edition.tagline || edition.highlight || `Global Azure Torino ${edition.id}: agenda, speaker e foto.`);

    el.kicker.textContent = title.replace(/\s*\b20\d{2}\b\s*$/, '') || 'Global Azure Torino';
    el.year.textContent = edition.id;
    el.tagline.textContent = edition.tagline ?? '';
    el.tagline.hidden = !edition.tagline;
    el.meta.innerHTML = renderHeroMeta(edition, phase);
    el.actions.innerHTML = renderHeroActions(edition, phase, content);
    el.switcher.innerHTML = editions.length > 1 ? renderEditionSwitch(editions, edition.id) : '';
    el.hero.dataset.phase = phase;

    const cover = safeUrl(edition.coverUrl, '');
    el.hero.style.setProperty('--ga-cover', cover ? `url("${cover.replace(/"/g, '%22')}")` : 'none');
    el.hero.classList.toggle('has-cover', Boolean(cover));
}

function renderAll() {
    const phase = editionPhase(edition);
    renderHead(phase);
    renderCountdown(phase);
    orderSections(phase);

    const stats = statsFor(edition, content);
    el.stats.innerHTML = renderStats(stats);
    el.statsWrap.hidden = stats.length === 0;
    animateCounters();

    el.storyText.textContent = edition.highlight ?? '';
    el.story.hidden = !edition.highlight;

    sections.render();
    show(el.agendaSection, content.sessions.length > 0);

    el.speakers.innerHTML = renderSpeakers(content);
    show(el.speakersSection, content.speakers.length > 0);

    show(el.gallerySection, content.photos.length > 0);

    el.sponsors.innerHTML = renderGaSponsors(content.sponsors);
    show(el.sponsorsSection, content.sponsors.length > 0);

    renderArchive();
    // Le card appena scritte prendono il loro posto nello sfalsamento.
    initReveal();
}


const others = () => editions.filter((entry) => entry.id !== edition.id);

function renderArchive(previews = new Map()) {
    const list = others();
    el.editions.innerHTML = renderEditionCards(list, previews);
    show(el.editionsSection, list.length > 0);
    initReveal(el.editionsSection);
}

/**
 * Le miniature dell'archivio costano una lettura per anno: si fanno solo
 * quando l'archivio sta per comparire.
 */
const archiveObserver = new IntersectionObserver(async (entries) => {
    if (!entries.some((entry) => entry.isIntersecting)) return;
    archiveObserver.disconnect();
    const list = others();
    const loaded = await Promise.all(list.map(async (entry) => [entry.id, await contentFor(entry.id)]));
    if (list.every((entry) => others().includes(entry))) renderArchive(new Map(loaded));
}, { rootMargin: '400px 0px' });

/* ==========================================================
   CONTATORI
   ========================================================== */

let counterObserver = null;

function animateCounters() {
    counterObserver?.disconnect();
    const targets = [...el.stats.querySelectorAll('[data-count-to]')];
    if (reducedMotion.matches || targets.length === 0) return;

    for (const target of targets) target.textContent = '0';

    counterObserver = new IntersectionObserver((entries) => {
        if (!entries.some((entry) => entry.isIntersecting)) return;
        counterObserver.disconnect();

        const started = performance.now();
        const duration = 1400;
        const tick = (now) => {
            const progress = Math.min(1, (now - started) / duration);
            const eased = 1 - (1 - progress) ** 3;
            for (const target of targets) {
                target.textContent = String(Math.round(Number(target.dataset.countTo) * eased));
            }
            if (progress < 1) requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }, { threshold: 0.4 });
    counterObserver.observe(el.stats);
}


/* ==========================================================
   CAMBIO DI EDIZIONE
   ========================================================== */

async function openEdition(id, { push = true } = {}) {
    const next = pickEdition(editions, id);
    if (!next) return;

    document.body.classList.add('ga-switching');
    edition = next;
    content = await contentFor(edition.id);
    renderAll();
    document.body.classList.remove('ga-switching');

    const search = edition.current ? '' : `?anno=${edition.id}`;
    if (push) history.pushState({ anno: edition.id }, '', `${location.pathname}${search}`);

    archiveObserver.disconnect();
    archiveObserver.observe(el.editionsSection);
}

document.addEventListener('click', (event) => {
    const link = event.target.closest('a[data-edition]');
    if (!link || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
    event.preventDefault();
    if (link.dataset.edition === edition?.id) return;
    openEdition(link.dataset.edition).then(() => {
        window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
    });
});

window.addEventListener('popstate', () => {
    openEdition(new URLSearchParams(location.search).get('anno'), { push: false });
});

/* ==========================================================
   AVVIO
   ========================================================== */

loadCollection('site')
    .then((payload) => renderSite(document, payload, { title: false }))
    .catch((error) => console.warn('[site] contenuti non disponibili', error));

initNav();
initEmailCopy();
initHeroNetwork($('ga-network'));
initTilt('.sponsor-card, .ga-speaker');
initReveal();


try {
    const index = await loadCollection('global-azure');
    editions = visibleEditions(index);
} catch (error) {
    console.error('[global-azure] indice non disponibile', error);
}

if (editions.length === 0) {
    renderDataError(el.status, 'Non riusciamo a caricare le edizioni di Global Azure in questo momento.');
    el.status.hidden = false;
} else {
    const wanted = new URLSearchParams(location.search).get('anno');
    await openEdition(wanted, { push: false });
    // Un `?anno=` che non esiste si corregge nell'indirizzo, invece di restare
    // a dire una cosa e mostrarne un'altra.
    if (wanted && wanted !== edition.id) history.replaceState(null, '', `${location.pathname}?anno=${escapeHtml(edition.id)}`);
    el.status.hidden = true;
    document.body.classList.add('ga-ready');
}
