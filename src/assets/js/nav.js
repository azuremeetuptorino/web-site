/**
 * Menu di navigazione su schermo stretto.
 *
 * Sotto i 900 px i cinque link non ci stanno accanto al logo: finivano fuori
 * dallo schermo, e `overflow-x: hidden` sul body nascondeva il fatto che
 * fossero irraggiungibili invece di segnalarlo. Da li in giu diventano un
 * pannello che si apre dal bottone.
 *
 * Il pannello si chiude da solo quando serve: dopo aver scelto una voce (sono
 * ancore sulla stessa pagina, restare aperti coprirebbe proprio la sezione
 * appena raggiunta), con Esc, toccando fuori, e tornando a schermo largo — dove
 * il menu torna una barra e un pannello aperto sarebbe un fantasma.
 */

const COMPACT = '(max-width: 900px)';

export function initNav() {
    const header = document.getElementById('main-header');
    const toggle = document.getElementById('nav-toggle');
    const nav = document.getElementById('primary-nav');
    if (!header || !toggle || !nav) return;

    const compact = window.matchMedia(COMPACT);

    function setOpen(open) {
        nav.dataset.open = String(open);
        toggle.setAttribute('aria-expanded', String(open));
        toggle.setAttribute('aria-label', open ? 'Chiudi il menu' : 'Apri il menu');

        // In cima alla pagina la testata e trasparente sopra la foto: con il
        // pannello aperto va resa opaca, altrimenti il menu galleggia su
        // un'immagine e non si legge. Lo stato di scorrimento lo scrive
        // main.js come stile inline, quindi qui serve una classe con
        // !important nel CSS per avere la meglio.
        header.classList.toggle('nav-open', open);
    }

    const isOpen = () => nav.dataset.open === 'true';

    toggle.addEventListener('click', () => setOpen(!isOpen()));

    nav.addEventListener('click', (event) => {
        if (event.target.closest('a')) setOpen(false);
    });

    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && isOpen()) {
            setOpen(false);
            toggle.focus();
        }
    });

    document.addEventListener('click', (event) => {
        if (!isOpen()) return;
        if (event.target.closest('#primary-nav') || event.target.closest('#nav-toggle')) return;
        setOpen(false);
    });

    compact.addEventListener('change', (event) => {
        if (!event.matches) setOpen(false);
    });

    setOpen(false);
}
