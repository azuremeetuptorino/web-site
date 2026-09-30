import { loadCollection } from './data.js';
import { renderDataError, escapeHtml, safeUrl } from './dom.js';
import { renderSite } from './render-site.js';
import { initNav } from './nav.js';
import { initEmailCopy } from './email-copy.js';
import {
    visibleEditions, pickEdition, editionPhase,
    renderHeroMeta, renderHeroActions, statsFor, renderStats, renderEditionSwitch,
    renderAgenda, renderTrackFilter, renderSpeakers, renderSessionDetail, renderSpeakerDetail,
    renderGallery, renderGaSponsors, renderEditionCards
} from './render-global-azure.js';

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

const GALLERY_PAGE = 18;
const EMPTY = { tracks: [], speakers: [], sessions: [], photos: [], sponsors: [] };

const $ = (id) => document.getElementById(id);

const el = {
    hero: $('ga-hero'),
    kicker: $('ga-kicker'),
    year: $('ga-hero-year'),
    tagline: $('ga-tagline'),
    meta: $('ga-meta'),
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
    lightbox: $('ga-lightbox')
};

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let editions = [];
let edition = null;
let content = EMPTY;
let galleryShown = GALLERY_PAGE;
const cache = new Map();

/* ==========================================================
   DATI
   ========================================================== */

function normalize(data) {
    return {
        tracks: data?.tracks ?? [],
        speakers: data?.speakers ?? [],
        sessions: [...(data?.sessions ?? [])].filter((s) => s.start && s.end).sort((a, b) => a.start.localeCompare(b.start)),
        photos: data?.photos ?? [],
        sponsors: data?.sponsors ?? []
    };
}

/** I contenuti di un anno. Un anno senza documento e un anno senza contenuti, non un errore. */
function contentFor(id) {
    if (!cache.has(id)) {
        cache.set(id, loadCollection(`global-azure/${id}`)
            .then(normalize)
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

    const stats = statsFor(edition, content);
    el.stats.innerHTML = renderStats(stats);
    el.statsWrap.hidden = stats.length === 0;
    animateCounters();

    el.storyText.textContent = edition.highlight ?? '';
    el.story.hidden = !edition.highlight;

    el.agenda.innerHTML = renderAgenda(content);
    el.trackFilter.innerHTML = renderTrackFilter(content.tracks);
    el.agenda.dataset.filter = '';
    show(el.agendaSection, content.sessions.length > 0);

    el.speakers.innerHTML = renderSpeakers(content);
    show(el.speakersSection, content.speakers.length > 0);

    galleryShown = GALLERY_PAGE;
    renderGalleryPage();
    show(el.gallerySection, content.photos.length > 0);

    el.sponsors.innerHTML = renderGaSponsors(content.sponsors);
    show(el.sponsorsSection, content.sponsors.length > 0);

    renderArchive();
}

function renderGalleryPage() {
    el.gallery.innerHTML = renderGallery(content.photos, { limit: galleryShown });
    const remaining = content.photos.length - galleryShown;
    el.galleryMore.hidden = remaining <= 0;
    if (remaining > 0) el.galleryMore.textContent = `Mostra tutte le ${content.photos.length} foto`;
}

const others = () => editions.filter((entry) => entry.id !== edition.id);

function renderArchive(previews = new Map()) {
    const list = others();
    el.editions.innerHTML = renderEditionCards(list, previews);
    show(el.editionsSection, list.length > 0);
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
   FILTRO PER TRACCIA
   ========================================================== */

el.trackFilter.addEventListener('click', (event) => {
    const chip = event.target.closest('[data-track-filter]');
    if (!chip) return;

    const wanted = chip.dataset.trackFilter;
    el.agenda.dataset.filter = wanted;
    for (const other of el.trackFilter.querySelectorAll('[data-track-filter]')) {
        other.setAttribute('aria-pressed', String(other === chip));
    }
    for (const session of el.agenda.querySelectorAll('.ga-session')) {
        // Le sessioni a tutta riga (keynote, pause) valgono per tutte le tracce.
        const own = session.dataset.track;
        session.classList.toggle('is-filtered', wanted !== '' && own !== '' && own !== wanted);
    }
});

/* ==========================================================
   DETTAGLIO DI SESSIONI E SPEAKER
   ========================================================== */

let lastTrigger = null;

function openDetail(kind, id, trigger) {
    const item = kind === 'session'
        ? content.sessions.find((session) => session.id === id)
        : content.speakers.find((speaker) => speaker.id === id);
    if (!item) return;

    el.dialogBody.innerHTML = kind === 'session'
        ? renderSessionDetail(item, content)
        : renderSpeakerDetail(item, content);
    el.dialog.dataset.kind = kind;

    if (!el.dialog.open) {
        lastTrigger = trigger ?? document.activeElement;
        el.dialog.showModal();
    }
    el.dialogBody.scrollTop = 0;
    el.dialog.querySelector('.ga-dialog-close').focus();
}

document.addEventListener('click', (event) => {
    const session = event.target.closest('[data-session]');
    if (session) {
        openDetail('session', session.dataset.session, session);
        return;
    }
    const speaker = event.target.closest('[data-speaker]');
    if (speaker) openDetail('speaker', speaker.dataset.speaker, speaker);
});

el.dialog.addEventListener('click', (event) => {
    // Un clic sullo sfondo (fuori dal riquadro) chiude.
    if (event.target === el.dialog) el.dialog.close();
});
el.dialog.querySelector('.ga-dialog-close').addEventListener('click', () => el.dialog.close());
el.dialog.addEventListener('close', () => lastTrigger?.focus?.());

/* ==========================================================
   LIGHTBOX
   ========================================================== */

const lightbox = {
    index: 0,
    image: el.lightbox.querySelector('.ga-lightbox-image'),
    caption: el.lightbox.querySelector('.ga-lightbox-caption'),
    counter: el.lightbox.querySelector('.ga-lightbox-counter'),
    trigger: null
};

function preload(index) {
    const photo = content.photos[index];
    if (photo) new Image().src = safeUrl(photo.url, '');
}

function showPhoto(index) {
    const total = content.photos.length;
    lightbox.index = (index + total) % total;
    const photo = content.photos[lightbox.index];

    lightbox.image.classList.add('is-loading');
    lightbox.image.onload = () => lightbox.image.classList.remove('is-loading');
    lightbox.image.src = safeUrl(photo.url, '');
    lightbox.image.alt = photo.caption ?? '';
    if (photo.width && photo.height) {
        lightbox.image.width = photo.width;
        lightbox.image.height = photo.height;
    }
    lightbox.caption.textContent = photo.caption ?? '';
    lightbox.caption.hidden = !photo.caption;
    lightbox.counter.textContent = `${lightbox.index + 1} / ${total}`;

    preload(lightbox.index + 1);
    preload(lightbox.index - 1);
}

el.gallery.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-photo]');
    if (!tile) return;
    lightbox.trigger = tile;
    showPhoto(Number(tile.dataset.photo));
    el.lightbox.showModal();
});

el.lightbox.addEventListener('click', (event) => {
    const action = event.target.closest('[data-lightbox]')?.dataset.lightbox;
    if (action === 'prev') showPhoto(lightbox.index - 1);
    else if (action === 'next') showPhoto(lightbox.index + 1);
    else if (action === 'close' || event.target === el.lightbox || event.target.classList.contains('ga-lightbox-stage')) {
        el.lightbox.close();
    }
});

el.lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') showPhoto(lightbox.index - 1);
    if (event.key === 'ArrowRight') showPhoto(lightbox.index + 1);
});

el.lightbox.addEventListener('close', () => {
    // La foto chiusa potrebbe essere oltre la pagina mostrata della galleria.
    const tile = el.gallery.querySelector(`[data-photo="${lightbox.index}"]`) ?? lightbox.trigger;
    tile?.focus?.({ preventScroll: false });
});

// Scorrimento col dito: basta un gesto orizzontale deciso.
let swipeStart = null;
el.lightbox.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') swipeStart = { x: event.clientX, y: event.clientY };
});
el.lightbox.addEventListener('pointerup', (event) => {
    if (!swipeStart) return;
    const dx = event.clientX - swipeStart.x;
    const dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) showPhoto(lightbox.index + (dx < 0 ? 1 : -1));
});

el.galleryMore.addEventListener('click', () => {
    const first = galleryShown;
    galleryShown = content.photos.length;
    renderGalleryPage();
    el.gallery.querySelector(`[data-photo="${first}"]`)?.focus({ preventScroll: true });
});

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
