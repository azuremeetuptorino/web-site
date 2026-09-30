import { loadCollection } from './data.js';
import { renderDataError, escapeHtml, safeUrl } from './dom.js';
import { renderSite } from './render-site.js';
import { initNav } from './nav.js';
import { initEmailCopy } from './email-copy.js';
import {
    visibleEditions, pickEdition, editionPhase,
    renderHeroMeta, renderHeroActions, statsFor, renderStats, renderEditionSwitch,
    renderAgenda, renderTrackFilter, renderSpeakers, renderSessionDetail, renderSpeakerDetail,
    renderGallery, renderFilmstrip, photoRatio, renderGaSponsors, renderEditionCards, sectionOrder, editionStart
} from './render-global-azure.js';
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

const GALLERY_PAGE = 18;
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

/**
 * La prima foto in evidenza apre la galleria a tutta larghezza: la si porta
 * in testa anche nell'elenco, cosi il lightbox scorre nello stesso ordine
 * in cui le foto si vedono.
 */
function spotlightFirst(photos) {
    const index = photos.findIndex((photo) => photo.featured);
    return index > 0 ? [photos[index], ...photos.slice(0, index), ...photos.slice(index + 1)] : photos;
}

function normalize(data) {
    return {
        tracks: data?.tracks ?? [],
        speakers: data?.speakers ?? [],
        sessions: [...(data?.sessions ?? [])].filter((s) => s.start && s.end).sort((a, b) => a.start.localeCompare(b.start)),
        photos: spotlightFirst(data?.photos ?? []),
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
    // Le card appena scritte prendono il loro posto nello sfalsamento.
    initReveal();
}

function renderGalleryPage() {
    el.gallery.innerHTML = renderGallery(content.photos, { limit: galleryShown });
    // Quelle gia in cache non emettono piu `load`.
    for (const image of el.gallery.querySelectorAll('img')) {
        if (image.complete) image.closest('.ga-tile').classList.add('is-loaded');
    }
    const remaining = content.photos.length - galleryShown;
    el.galleryMore.hidden = remaining <= 0;
    if (remaining > 0) el.galleryMore.textContent = `Mostra tutte le ${content.photos.length} foto`;
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

const SLIDE_MS = 5000;

const lightbox = {
    index: 0,
    stage: el.lightbox.querySelector('.ga-lightbox-stage'),
    image: el.lightbox.querySelector('.ga-lightbox-image'),
    caption: el.lightbox.querySelector('.ga-lightbox-caption'),
    counter: el.lightbox.querySelector('.ga-lightbox-counter'),
    ambient: el.lightbox.querySelector('.ga-lightbox-ambient'),
    progress: el.lightbox.querySelector('.ga-lightbox-progress'),
    play: el.lightbox.querySelector('[data-lightbox="play"]'),
    strip: $('ga-lightbox-strip'),
    trigger: null,
    token: 0,
    timer: 0,
    playing: false,
    closing: false
};

/** Le animazioni del lightbox, che a chi chiede meno movimento non si fanno. */
const animate = (element, keyframes, options) =>
    reducedMotion.matches || !element.animate ? null : element.animate(keyframes, options);

/**
 * La misura della foto aperta la calcola il JavaScript, non il CSS: serve
 * conoscerla prima che l'immagine grande arrivi, per mostrare subito la
 * miniatura (gia in cache) alla misura giusta e per far partire lo zoom
 * dalla griglia verso il punto esatto in cui la foto si fermera.
 */
function fitImage(photo) {
    const ratio = photoRatio(photo);
    const box = lightbox.stage.getBoundingClientRect();
    const style = getComputedStyle(lightbox.stage);
    const room = {
        width: box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
        height: box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
    };
    // Mai oltre la misura vera: una foto piccola ingrandita si sgrana.
    let width = Math.min(room.width, photo.width || Infinity);
    let height = width / ratio;
    if (height > room.height) {
        height = room.height;
        width = height * ratio;
    }
    lightbox.image.style.width = `${Math.max(0, Math.round(width))}px`;
    lightbox.image.style.height = `${Math.max(0, Math.round(height))}px`;
}

function preload(index) {
    const photo = content.photos[(index + content.photos.length) % content.photos.length];
    if (photo) new Image().src = safeUrl(photo.url, '');
}

/**
 * @param {number} index
 * @param {{ direction?: number }} options -1 da sinistra, 1 da destra, 0 senza scorrimento
 */
function showPhoto(index, { direction = 0 } = {}) {
    const total = content.photos.length;
    lightbox.index = (index + total) % total;
    const photo = content.photos[lightbox.index];
    const token = ++lightbox.token;

    // Prima la miniatura, che la griglia ha gia scaricato: si vede subito,
    // un po' morbida. Quando la versione grande e pronta prende il suo posto.
    const thumb = safeUrl(photo.thumbUrl || photo.url, '');
    const full = safeUrl(photo.url, '');
    lightbox.image.src = thumb || full;
    lightbox.image.alt = photo.caption ?? '';
    fitImage(photo);

    const upgrade = full && full !== thumb;
    el.lightbox.classList.toggle('is-loading', Boolean(upgrade));
    if (upgrade) {
        const loader = new Image();
        loader.onload = loader.onerror = () => {
            if (token !== lightbox.token) return;
            if (loader.naturalWidth) lightbox.image.src = full;
            el.lightbox.classList.remove('is-loading');
        };
        loader.src = full;
    }

    lightbox.ambient.style.backgroundImage = thumb ? `url("${thumb.replace(/"/g, '%22')}")` : 'none';
    lightbox.caption.textContent = photo.caption ?? '';
    lightbox.caption.hidden = !photo.caption;
    lightbox.counter.textContent = `${lightbox.index + 1} / ${total}`;

    if (direction) {
        animate(lightbox.image, [
            { opacity: 0, transform: `translateX(${direction * 70}px) scale(0.97)` },
            { opacity: 1, transform: 'none' }
        ], { duration: 420, easing: 'cubic-bezier(0.16, 1, 0.3, 1)' });
    }

    for (const thumbButton of lightbox.strip.querySelectorAll('[data-strip]')) {
        const current = Number(thumbButton.dataset.strip) === lightbox.index;
        if (current) thumbButton.setAttribute('aria-current', 'true');
        else thumbButton.removeAttribute('aria-current');
    }
    lightbox.strip.querySelector('[aria-current]')?.scrollIntoView({
        inline: 'center', block: 'nearest', behavior: reducedMotion.matches ? 'auto' : 'smooth'
    });

    preload(lightbox.index + 1);
    preload(lightbox.index - 1);
    scheduleNext();
}

const step = (delta) => showPhoto(lightbox.index + delta, { direction: delta });

/**
 * Lo zoom tra la miniatura nella griglia e la foto aperta. Le miniature non
 * sono ritagliate (la griglia e giustificata), quindi basta una scala sola.
 */
function flip(from, opening) {
    const to = lightbox.image.getBoundingClientRect();
    if (!from?.width || !to.width) return null;
    const scale = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const frames = [
        { transform: `translate(${dx}px, ${dy}px) scale(${scale})`, borderRadius: `${12 / scale}px` },
        { transform: 'none', borderRadius: '10px' }
    ];
    return animate(lightbox.image, opening ? frames : frames.reverse(), {
        duration: opening ? 520 : 380,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
        fill: opening ? 'none' : 'forwards'
    });
}

const tileImage = (index) => el.gallery.querySelector(`[data-photo="${index}"] img`);

function openLightbox(index, tile) {
    lightbox.trigger = tile;
    lightbox.closing = false;
    lightbox.strip.innerHTML = renderFilmstrip(content.photos);
    el.lightbox.showModal();
    showPhoto(index);
    flip(tileImage(index)?.getBoundingClientRect(), true);
}

/** Chiudendo, la foto torna al suo posto nella griglia, se quel posto si vede. */
async function closeLightbox() {
    if (lightbox.closing || !el.lightbox.open) return;
    lightbox.closing = true;
    stopSlideshow();

    const rect = tileImage(lightbox.index)?.getBoundingClientRect();
    const onScreen = rect && rect.bottom > 0 && rect.top < window.innerHeight;
    const animation = onScreen ? flip(rect, false) : null;
    if (animation) {
        el.lightbox.classList.add('is-closing');
        await animation.finished.catch(() => {});
    }
    el.lightbox.close();
    el.lightbox.classList.remove('is-closing');
    animation?.cancel();
}

/* ---------- Presentazione ---------- */

function scheduleNext() {
    clearTimeout(lightbox.timer);
    if (!lightbox.playing) return;
    // La barra riparte da zero a ogni foto: rileggere una misura riavvia l'animazione.
    lightbox.progress.classList.remove('is-running');
    void lightbox.progress.offsetWidth;
    lightbox.progress.classList.add('is-running');
    lightbox.timer = setTimeout(() => step(1), SLIDE_MS);
}

function setPlaying(playing) {
    lightbox.playing = playing;
    el.lightbox.classList.toggle('is-playing', playing);
    lightbox.play.setAttribute('aria-pressed', String(playing));
    lightbox.play.setAttribute('aria-label', playing ? 'Metti in pausa la presentazione' : 'Avvia la presentazione');
    lightbox.play.querySelector('i').className = `bi ${playing ? 'bi-pause-fill' : 'bi-play-fill'}`;
    if (!playing) {
        clearTimeout(lightbox.timer);
        lightbox.progress.classList.remove('is-running');
    }
}

function stopSlideshow() { setPlaying(false); }

/* ---------- Eventi ---------- */

el.gallery.addEventListener('click', (event) => {
    const tile = event.target.closest('[data-photo]');
    if (tile) openLightbox(Number(tile.dataset.photo), tile);
});

// Le miniature compaiono sfumando quando sono arrivate, non a strappi.
const markLoaded = (event) => event.target.closest?.('.ga-tile')?.classList.add('is-loaded');
el.gallery.addEventListener('load', markLoaded, true);
el.gallery.addEventListener('error', markLoaded, true);

el.lightbox.addEventListener('click', (event) => {
    const thumb = event.target.closest('[data-strip]');
    if (thumb) {
        const target = Number(thumb.dataset.strip);
        if (target !== lightbox.index) showPhoto(target, { direction: Math.sign(target - lightbox.index) });
        return;
    }
    const action = event.target.closest('[data-lightbox]')?.dataset.lightbox;
    if (action === 'prev') step(-1);
    else if (action === 'next') step(1);
    else if (action === 'play') {
        setPlaying(!lightbox.playing);
        if (lightbox.playing) scheduleNext();
    } else if (action === 'close' || event.target === el.lightbox || event.target === lightbox.stage) {
        closeLightbox();
    }
});

el.lightbox.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowLeft') step(-1);
    else if (event.key === 'ArrowRight') step(1);
    else if (event.key === 'Home') showPhoto(0, { direction: -1 });
    else if (event.key === 'End') showPhoto(content.photos.length - 1, { direction: 1 });
});

// Esc chiude con la stessa animazione del bottone.
el.lightbox.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeLightbox();
});

el.lightbox.addEventListener('close', () => {
    stopSlideshow();
    // La foto chiusa potrebbe essere oltre la pagina mostrata della galleria.
    const tile = el.gallery.querySelector(`[data-photo="${lightbox.index}"]`) ?? lightbox.trigger;
    tile?.focus?.({ preventScroll: true });
});

window.addEventListener('resize', () => {
    if (el.lightbox.open) fitImage(content.photos[lightbox.index]);
});

// Scorrimento col dito: basta un gesto orizzontale deciso.
let swipeStart = null;
lightbox.stage.addEventListener('pointerdown', (event) => {
    if (event.pointerType !== 'mouse') swipeStart = { x: event.clientX, y: event.clientY };
});
lightbox.stage.addEventListener('pointerup', (event) => {
    if (!swipeStart) return;
    const dx = event.clientX - swipeStart.x;
    const dy = event.clientY - swipeStart.y;
    swipeStart = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) step(dx < 0 ? 1 : -1);
});

el.galleryMore.addEventListener('click', () => {
    const first = galleryShown;
    galleryShown = content.photos.length;
    renderGalleryPage();
    initReveal(el.gallerySection);
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
