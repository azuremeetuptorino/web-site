import { safeUrl } from './dom.js';
import {
    renderAgenda, renderTrackFilter, renderSessionDetail, renderSpeakerDetail,
    renderGallery, renderFilmstrip, photoRatio
} from './render-global-azure.js';
import { initReveal } from './reveal.js';

/**
 * Agenda, dettaglio di sessioni e speaker, galleria e lightbox: le parti che
 * la pagina di Global Azure e quella di un evento speciale hanno in comune.
 *
 * Il modulo cabla gli elementi una volta sola; i contenuti li chiede ogni
 * volta a `getContent`, perche su /global-azure/ cambiano con l'edizione
 * senza ricaricare la pagina.
 *
 * Gli elementi attesi: agenda, trackFilter, gallery, galleryMore,
 * gallerySection, dialog, dialogBody, lightbox, lightboxStrip.
 */

export const GALLERY_PAGE = 18;

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/**
 * La prima foto in evidenza apre la galleria a tutta larghezza: la si porta
 * in testa anche nell'elenco, cosi il lightbox scorre nello stesso ordine
 * in cui le foto si vedono.
 */
function spotlightFirst(photos) {
    const index = photos.findIndex((photo) => photo.featured);
    return index > 0 ? [photos[index], ...photos.slice(0, index), ...photos.slice(index + 1)] : photos;
}

export function normalizeContent(data) {
    return {
        tracks: data?.tracks ?? [],
        speakers: data?.speakers ?? [],
        sessions: [...(data?.sessions ?? [])].filter((s) => s.start && s.end).sort((a, b) => a.start.localeCompare(b.start)),
        photos: spotlightFirst(data?.photos ?? []),
        sponsors: data?.sponsors ?? []
    };
}

/**
 * @param {Record<string, HTMLElement>} el
 * @param {() => {tracks: object[], speakers: object[], sessions: object[], photos: object[]}} getContent
 * @returns {{ render: () => void }} `render` riscrive agenda, filtro e galleria dai contenuti correnti
 */
export function initContentSections(el, getContent) {
    const content = getContent;
    let galleryShown = GALLERY_PAGE;

    function renderGalleryPage() {
        el.gallery.innerHTML = renderGallery(content().photos, { limit: galleryShown });
        // Quelle gia in cache non emettono piu `load`.
        for (const image of el.gallery.querySelectorAll('img')) {
            if (image.complete) image.closest('.ga-tile').classList.add('is-loaded');
        }
        const remaining = content().photos.length - galleryShown;
        el.galleryMore.hidden = remaining <= 0;
        if (remaining > 0) el.galleryMore.textContent = `Mostra tutte le ${content().photos.length} foto`;
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
            ? content().sessions.find((session) => session.id === id)
            : content().speakers.find((speaker) => speaker.id === id);
        if (!item) return;

        el.dialogBody.innerHTML = kind === 'session'
            ? renderSessionDetail(item, content())
            : renderSpeakerDetail(item, content());
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
        strip: el.lightboxStrip,
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
        const photo = content().photos[(index + content().photos.length) % content().photos.length];
        if (photo) new Image().src = safeUrl(photo.url, '');
    }

    /**
     * @param {number} index
     * @param {{ direction?: number }} options -1 da sinistra, 1 da destra, 0 senza scorrimento
     */
    function showPhoto(index, { direction = 0 } = {}) {
        const total = content().photos.length;
        lightbox.index = (index + total) % total;
        const photo = content().photos[lightbox.index];
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
        lightbox.strip.innerHTML = renderFilmstrip(content().photos);
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
        else if (event.key === 'End') showPhoto(content().photos.length - 1, { direction: 1 });
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
        if (el.lightbox.open) fitImage(content().photos[lightbox.index]);
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
        galleryShown = content().photos.length;
        renderGalleryPage();
        initReveal(el.gallerySection);
        el.gallery.querySelector(`[data-photo="${first}"]`)?.focus({ preventScroll: true });
    });

    return {
        render() {
            el.agenda.innerHTML = renderAgenda(content());
            el.trackFilter.innerHTML = renderTrackFilter(content().tracks);
            el.agenda.dataset.filter = '';
            galleryShown = GALLERY_PAGE;
            renderGalleryPage();
        }
    };
}
