/**
 * Inizializzazione dei caroselli.
 *
 * Gli Swiper vanno creati DOPO che le slide sono nel DOM, altrimenti
 * `loop` clona un wrapper vuoto e la track resta ferma.
 */

const prefersReducedMotion = () =>
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Marquee dei partecipanti: scorrimento continuo, in pausa mentre
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

    let isCardClicked = false;

    document.addEventListener('mousedown', (event) => {
        if (event.target.closest(`${selector} .member-card`)) {
            isCardClicked = true;
            swiper.autoplay.stop();
        } else if (isCardClicked) {
            swiper.autoplay.start();
            isCardClicked = false;
        }
    });

    element.addEventListener('touchstart', () => {
        swiper.autoplay.stop();
    }, { passive: true });

    element.addEventListener('touchend', () => {
        setTimeout(() => {
            if (!isCardClicked) swiper.autoplay.start();
        }, 50);
    }, { passive: true });

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
