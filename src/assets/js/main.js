import { loadCollection } from './data.js';
import { renderDataError } from './dom.js';
import { renderTeam } from './render-team.js';
import { renderSponsors } from './render-sponsors.js';
import { renderSite } from './render-site.js';
import { renderEvents, visibleEvents } from './render-events.js';
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

    const progress = Math.min(scrollY / 200, 1);

    if (header) {
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

    return renderEvents(track, payload, Date.now(), { limit: HOME_EVENTS });
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
    hydrate({
        collection: 'sponsors',
        trackId: 'sponsors-grid',
        sectionId: 'sponsors-wrapper',
        render: renderSponsors,
        errorMessage: 'Non riusciamo a caricare gli sponsor in questo momento.'
    })
]);
