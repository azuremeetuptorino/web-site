/**
 * Inizializzazione dei caroselli.
 *
 * Gli Swiper vanno creati DOPO che le slide sono nel DOM, altrimenti
 * `loop` clona un wrapper vuoto e la track resta ferma.
 */

const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Marquee dello staff: scorrimento continuo, in pausa mentre
 * l'utente tiene premuto su una card.
 */
export function initTeamSwiper(selector = '.swiper-team') {
    const element = document.querySelector(selector);
    if (!element || !element.querySelector('.swiper-slide')) return null;

    const reduced = prefersReducedMotion();

    const swiper = new Swiper(selector, {
        slidesPerView: 'auto',
        spaceBetween: 16,
        loop: true,
        speed: reduced ? 300 : 4000,
        allowTouchMove: true,
        // Con prefers-reduced-motion lo scorrimento infinito va spento:
        // resta un carosello trascinabile a mano.
        autoplay: reduced
            ? false
            : {
                  delay: 0,
                  disableOnInteraction: false,
                  pauseOnMouseEnter: false
              },
        freeMode: {
            enabled: !reduced,
            momentum: false
        }
    });

    if (reduced) return swiper;

    // Swiper mette in pausa l'autoplay al touchstart ma, in freeMode, non
    // sempre lo fa ripartire al rilascio: con una pressione senza trascinamento,
    // o trascinando verso destra, la track restava ferma. Il touchstart ferma
    // la transizione senza che scatti transitionend, e `animating` resta true:
    // slideNext viene ignorato per sempre. Al rilascio lo azzeriamo e facciamo
    // ripartire l'autoplay noi, ovunque sia finito il puntatore.
    let pressed = false;

    element.addEventListener('pointerdown', () => {
        pressed = true;
    });

    const resume = () => {
        if (!pressed) return;
        pressed = false;
        setTimeout(() => {
            if (swiper.destroyed) return;
            swiper.animating = false;
            swiper.autoplay.stop();
            swiper.autoplay.start();
        }, 0);
    };

    window.addEventListener('pointerup', resume);
    window.addEventListener('pointercancel', resume);

    return swiper;
}

/** Carosello del calendario eventi. */
export function initEventsSwiper(selector = '.swiper-events') {
    const element = document.querySelector(selector);
    if (!element || !element.querySelector('.swiper-slide')) return null;

    return new Swiper(selector, {
        slidesPerView: 1.25,
        spaceBetween: 16,
        grabCursor: true,
        observer: true,
        observeParents: true,
        mousewheel: {
            forceToAxis: true,
            releaseOnEdges: true
        },
        breakpoints: {
            576: { slidesPerView: 2.2, spaceBetween: 18 },
            768: { slidesPerView: 3.2, spaceBetween: 20 },
            1024: { slidesPerView: 4, spaceBetween: 24 }
        },
        navigation: {
            nextEl: '.swiper-button-next-events',
            prevEl: '.swiper-button-prev-events'
        }
    });
}
