import { loadCollection } from './data.js';
import { renderDataError } from './dom.js';
import { renderTeam } from './render-team.js';
import { renderSponsors } from './render-sponsors.js';
import { renderSite } from './render-site.js';
import { renderEvents, visibleEvents } from './render-events.js';
import { renderTeaser, renderTeaserPhotos, visibleEditions, pickEdition, editionStart } from './render-global-azure.js';
import { initHeroNetwork } from './hero-network.js';
import { initTypewriter, renderNextEvent, startCountdown } from './hero.js';
import { initReveal } from './reveal.js';
import { initTilt } from './tilt.js';
import { initTeamSwiper, initEventsSwiper } from './swiper-init.js';
import { MEETUP_GROUP_URL } from './config.js';
import { initNav } from './nav.js';
import { initEmailCopy } from './email-copy.js';

/* ==========================================================
   1. HERO PARALLAX & NAVBAR
   ========================================================== */
const header = document.getElementById('main-header');
const logoImg = document.getElementById('logo-img');
const navContainer = document.getElementById('nav-container');
const heroImg = document.getElementById('hero-img');
const heroContent = document.getElementById('hero-content');

/**
 * Logo e imbottitura della testata si rimpiccioliscono scorrendo, e le misure
 * dipendono dallo schermo: su un telefono un logo da 84 px prende mezza
 * testata. Stanno qui e non nel CSS perche questa funzione scrive stili inline,
 * che avrebbero comunque la meglio su qualunque media query.
 */
const compactScreen = window.matchMedia('(max-width: 900px)');

const metrics = () => (compactScreen.matches
    ? { logo: [52, 34], padY: [0.8, 0.5], padX: '1rem' }
    : { logo: [84, 42], padY: [1.4, 0.8], padX: '2rem' });

function handleScroll() {
    const scrollY = window.scrollY;
    const { logo, padY, padX } = metrics();

    if (heroImg) {
        heroImg.style.transform = `translateY(${scrollY * 0.25}px)`;
        heroImg.style.opacity = Math.max(0, 0.95 - (scrollY / 800));
    }

    // Il contenuto della hero sale e sfuma prima della foto: quando il box
    // "Chi siamo" gli passa sopra, deve essersene gia andato.
    if (heroContent) {
        heroContent.style.transform = `translateY(${scrollY * -0.15}px)`;
        heroContent.style.opacity = Math.max(0, 1 - (scrollY / 420));
        heroContent.style.visibility = scrollY > 460 ? 'hidden' : '';
    }

    const progress = Math.min(scrollY / 200, 1);

    if (header) {
        // Sopra il velo scuro della hero testo bianco, sulla barra ormai
        // bianca testo scuro: il cambio sta a meta dello scorrimento.
        header.classList.toggle('on-hero', progress < 0.5);
        header.style.backgroundColor = `rgba(255, 255, 255, ${progress})`;
        header.style.borderBottomColor = `rgba(237, 235, 233, ${progress})`;
        header.style.boxShadow = `0 4px 15px rgba(0, 0, 0, ${progress * 0.08})`;
    }

    if (logoImg) {
        logoImg.style.height = `${logo[0] - (logo[0] - logo[1]) * progress}px`;
        logoImg.style.boxShadow = `0 6px 20px rgba(0, 0, 0, ${0.16 - (progress * 0.12)})`;
    }

    if (navContainer) {
        const currentPad = padY[0] - (padY[0] - padY[1]) * progress;
        navContainer.style.padding = `${currentPad}rem ${padX}`;
    }
}

window.addEventListener('scroll', handleScroll, { passive: true });

// Ruotando il telefono o cambiando fascia le misure cambiano, ma senza
// scorrere `handleScroll` non verrebbe piu richiamata e resterebbero quelle
// dello schermo di prima.
compactScreen.addEventListener('change', handleScroll);

handleScroll();
initNav();

initHeroNetwork(document.getElementById('hero-network'));
initTypewriter();
initReveal();
initTilt('.sponsor-card, .ga-teaser');

/* ==========================================================
   2. COPIA RAPIDA EMAIL
   ========================================================== */
initEmailCopy();

/* ==========================================================
   2b. EVENTI IN HOME
   ========================================================== */

/**
 * In home ne stanno cinque, il resto sta in /eventi/.
 *
 * Il calendario di una community che dura cresce di un evento al mese: prima o
 * poi il carosello diventa una fila lunghissima in cui bisogna trascinare otto
 * volte per arrivare al 2023, senza vederne mai l'insieme. Cinque card
 * rispondono alla domanda che porta chi arriva in home ("quando e il
 * prossimo?"), e il bottone porta a una pagina dove l'archivio si filtra
 * invece di scorrerlo.
 *
 * Sono i primi cinque dell'ordine di `visibleEvents`: i prossimi in ordine di
 * data e, se il futuro non ne riempie cinque, gli ultimi fatti.
 */
const HOME_EVENTS = 5;

function renderHomeEvents(track, payload) {
    // Il totale sul bottone dice quanto vale il click: l'archivio e il
    // capitale sociale della community, non un ripostiglio.
    const total = visibleEvents(payload).length;
    const badge = document.querySelector('[data-events-total]');
    if (badge && total > 0) {
        badge.textContent = `(${total})`;
        badge.hidden = false;
    }

    // La card della hero legge lo stesso documento: niente seconda richiesta.
    renderNextEvent(document.getElementById('hero-next-event'), payload);

    return renderEvents(track, payload, Date.now(), { limit: HOME_EVENTS });
}

/* ==========================================================
   2c. BANNER GLOBAL AZURE
   ========================================================== */

/**
 * Il banner nasce da renderTeaser; qui si accende quello che gli serve in
 * piu: il conto alla rovescia per un'edizione in arrivo, le foto per una gia
 * fatta. Le foto costano un documento in piu, quindi arrivano solo quando il
 * banner sta per entrare nello schermo.
 */
function renderHomeTeaser(container, index) {
    const shown = renderTeaser(container, index);
    if (!shown) return 0;

    const edition = pickEdition(visibleEditions(index), null);
    startCountdown(container.querySelector('[data-teaser-countdown]'), editionStart(edition));

    const strip = container.querySelector('[data-teaser-photos]');
    if (strip) {
        const observer = new IntersectionObserver(async (entries) => {
            if (!entries.some((entry) => entry.isIntersecting)) return;
            observer.disconnect();
            try {
                const content = await loadCollection(`global-azure/${strip.dataset.teaserPhotos}`);
                const photos = content?.photos ?? [];
                if (photos.length < 3) return;
                strip.innerHTML = renderTeaserPhotos(photos);
                strip.hidden = false;
            } catch (error) {
                // Senza foto il banner resta com'era: non e un errore da mostrare.
                console.warn('[global-azure] foto del banner non disponibili', error);
            }
        }, { rootMargin: '300px 0px' });
        observer.observe(container);
    }
    return shown;
}

/* ==========================================================
   3. CARICAMENTO DATI E RENDERING
   Ogni sezione fallisce per conto suo: un JSON mancante non
   deve portarsi dietro il resto della pagina.
   ========================================================== */
async function hydrate({ collection, trackId, sectionId, render, onSuccess, errorMessage, errorLink }) {
    const track = document.getElementById(trackId);
    const section = document.getElementById(sectionId) ?? track;
    if (!track) return;

    const fail = (error) => {
        if (error) console.error(`[${collection}] caricamento fallito`, error);
        // Senza messaggio non si tocca la pagina: e il caso di chi ha gia un
        // contenuto di riserva nell'HTML.
        if (errorMessage) renderDataError(section, errorMessage, errorLink?.url, errorLink?.label);
    };

    try {
        const payload = await loadCollection(collection);
        if (render(track, payload) > 0) {
            onSuccess?.();
        } else {
            fail();
        }
    } catch (error) {
        fail(error);
    }
}

await Promise.allSettled([
    // I contenuti fissi della pagina. Se non arrivano non c'e niente da
    // segnalare: l'HTML contiene gia i testi, e restano quelli. Per questo e
    // l'unica sezione senza messaggio di errore.
    hydrate({
        collection: 'site',
        trackId: 'main-content',
        sectionId: 'main-content',
        render: (_, payload) => renderSite(document, payload),
        errorMessage: null
    }),
    hydrate({
        collection: 'team',
        trackId: 'team-track',
        sectionId: 'team-carousel',
        render: renderTeam,
        onSuccess: () => initTeamSwiper(),
        errorMessage: 'Non riusciamo a caricare il team in questo momento.',
        errorLink: { url: 'https://it.linkedin.com/company/azure-meetup-torino', label: 'Seguici su LinkedIn' }
    }),
    hydrate({
        collection: 'events',
        trackId: 'events-track',
        sectionId: 'events-carousel',
        render: renderHomeEvents,
        onSuccess: () => initEventsSwiper(),
        errorMessage: 'Non riusciamo a caricare il calendario in questo momento.',
        errorLink: { url: MEETUP_GROUP_URL, label: 'Vedi gli eventi su Meetup' }
    }),
    // Nessun messaggio d'errore: senza edizioni il banner semplicemente non c'e.
    hydrate({
        collection: 'global-azure',
        trackId: 'ga-teaser',
        sectionId: 'global-azure-teaser',
        render: renderHomeTeaser,
        onSuccess: () => { document.getElementById('global-azure-teaser').hidden = false; },
        errorMessage: null
    }),
    hydrate({
        collection: 'sponsors',
        trackId: 'sponsors-grid',
        sectionId: 'sponsors-wrapper',
        render: renderSponsors,
        // Le card di ogni fascia entrano una dopo l'altra.
        onSuccess: () => {
            for (const grid of document.querySelectorAll('#sponsors-grid .sponsors-grid')) {
                grid.setAttribute('data-reveal-stagger', '');
            }
            initReveal(document.getElementById('sponsors-grid'));
        },
        errorMessage: 'Non riusciamo a caricare gli sponsor in questo momento.'
    })
]);

// I social del footer li riscrive render-site.js: lo sfalsamento va
// ricalcolato sui figli nuovi.
initReveal();
