import { loadCollection } from './data.js';
import { renderDataError, safeUrl } from './dom.js';
import { renderSite } from './render-site.js';
import { initNav } from './nav.js';
import { initEmailCopy } from './email-copy.js';
import { eventPhase, findFeatured, renderEventHeroMeta, renderEventHeroActions } from './render-featured.js';
import { initContentSections, normalizeContent } from './content-sections.js';
import { initHeroNetwork } from './hero-network.js';
import { startCountdown } from './hero.js';
import { initReveal } from './reveal.js';

/**
 * La pagina /evento/?id=<id>: un evento speciale di events.json con le sue
 * sessioni e le sue foto (event-pages/<id>.json). Come /global-azure/, ma un
 * evento solo e niente edizioni, speaker a parte o sponsor.
 *
 * Due letture: events.json, per titolo, data, luogo e link di iscrizione, e i
 * contenuti. Senza contenuti la pagina c'e lo stesso, con la sola hero.
 */

const EMPTY = { tracks: [], speakers: [], sessions: [], photos: [] };

const $ = (id) => document.getElementById(id);

const el = {
    hero: $('ga-hero'),
    name: $('ga-hero-name'),
    tagline: $('ga-tagline'),
    meta: $('ga-meta'),
    countdown: $('ga-countdown'),
    actions: $('ga-actions'),
    subnav: $('ga-subnav'),
    status: $('ga-status'),
    agendaSection: $('agenda'),
    agenda: $('ga-agenda'),
    trackFilter: $('ga-track-filter'),
    gallerySection: $('foto'),
    gallery: $('ga-gallery'),
    galleryMore: $('ga-gallery-more'),
    soon: $('in-arrivo'),
    dialog: $('ga-dialog'),
    dialogBody: $('ga-dialog-body'),
    lightbox: $('ga-lightbox'),
    lightboxStrip: $('ga-lightbox-strip')
};

let content = EMPTY;
const sections = initContentSections(el, () => content);

function show(section, visible) {
    section.hidden = !visible;
    const link = el.subnav.querySelector(`a[href="#${section.id}"]`);
    if (link) link.parentElement.hidden = !visible;
}

/** Prima dell'evento si viene per il programma, dopo per le foto. */
function orderSections(phase) {
    if (phase !== 'past') return;
    el.agendaSection.before(el.gallerySection);
    const photosLink = el.subnav.querySelector('a[href="#foto"]')?.parentElement;
    const agendaLink = el.subnav.querySelector('a[href="#agenda"]')?.parentElement;
    if (photosLink && agendaLink) agendaLink.before(photosLink);
}

function renderHead(event, phase) {
    document.title = `${event.title} | Azure Meetup Torino`;
    const description = event.excerpt || `${event.title}: sessioni, speaker e foto.`;
    document.querySelector('meta[name="description"]')?.setAttribute('content', description);
    document.querySelector('meta[property="og:title"]')?.setAttribute('content', event.title);
    document.querySelector('meta[property="og:description"]')?.setAttribute('content', description);

    el.name.textContent = event.title;
    el.tagline.textContent = event.excerpt ?? '';
    el.tagline.hidden = !event.excerpt;
    el.meta.innerHTML = renderEventHeroMeta(event, phase);
    el.actions.innerHTML = renderEventHeroActions(event, phase, content);
    el.hero.dataset.phase = phase;

    const cover = safeUrl(event.imageUrl, '');
    el.hero.style.setProperty('--ga-cover', cover ? `url("${cover.replace(/"/g, '%22')}")` : 'none');
    el.hero.classList.toggle('has-cover', Boolean(cover));

    const start = Date.parse(event.dateTime);
    if (phase === 'upcoming' && Number.isFinite(start)) {
        el.countdown.hidden = false;
        startCountdown(el.countdown, start, { onEnd: () => { el.countdown.hidden = true; } });
    }
}

/* ==========================================================
   AVVIO
   ========================================================== */

loadCollection('site')
    .then((payload) => renderSite(document, payload, { title: false }))
    .catch((error) => console.warn('[site] contenuti non disponibili', error));

initNav();
initEmailCopy();
initHeroNetwork($('ga-network'));

const id = new URLSearchParams(location.search).get('id') ?? '';

let event = null;
try {
    event = findFeatured(await loadCollection('events'), id);
} catch (error) {
    console.error('[evento] eventi non disponibili', error);
}

if (!event) {
    el.name.textContent = 'Evento non trovato';
    renderDataError(el.status, 'Questo evento non ha una pagina, o non e piu pubblicato.', '/eventi/', 'Vedi tutti gli eventi');
} else {
    try {
        content = normalizeContent(await loadCollection(`event-pages/${id}`));
    } catch (error) {
        // Una pagina senza contenuti e un evento di cui non si sa ancora il programma.
        console.warn(`[evento] contenuti di ${id} non disponibili`, error);
    }

    const phase = eventPhase(event);
    renderHead(event, phase);
    orderSections(phase);
    sections.render();

    const hasSessions = content.sessions.length > 0;
    const hasPhotos = content.photos.length > 0;
    show(el.agendaSection, hasSessions);
    show(el.gallerySection, hasPhotos);
    el.subnav.hidden = !(hasSessions && hasPhotos);
    el.soon.hidden = hasSessions || hasPhotos || phase === 'past';
    el.status.hidden = true;
    document.body.classList.add('ga-ready');
}

initReveal();
