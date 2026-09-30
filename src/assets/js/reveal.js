/**
 * Entrate allo scorrimento: gli elementi con `data-reveal` ricevono
 * `.is-visible` quando entrano nello schermo, e il CSS di effects.css fa il
 * resto. `data-reveal-stagger` su un contenitore sfalsa i figli diretti con
 * la variabile `--i`.
 *
 * Il nascosto iniziale lo mette il CSS solo sotto `.reveal-ready`, una classe
 * che aggiunge questo file: senza JavaScript, o se qualcosa va storto prima,
 * la pagina resta tutta visibile invece che tutta vuota.
 *
 * Si puo richiamare dopo ogni render: gli elementi gia osservati si saltano.
 */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const seen = new WeakSet();

const observer = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            entry.target.classList.add('is-visible');
            observer.unobserve(entry.target);
        }
    }, { rootMargin: '0px 0px -8% 0px', threshold: 0.08 })
    : null;

export function initReveal(root = document) {
    for (const group of root.querySelectorAll('[data-reveal-stagger]')) {
        [...group.children].forEach((child, index) => child.style.setProperty('--i', String(index)));
    }

    const targets = root.querySelectorAll('[data-reveal], [data-reveal-stagger]');
    if (!observer || reducedMotion.matches) {
        for (const target of targets) target.classList.add('is-visible');
        return;
    }

    document.documentElement.classList.add('reveal-ready');
    for (const target of targets) {
        if (seen.has(target)) continue;
        seen.add(target);
        observer.observe(target);
    }
}

/**
 * Per le sezioni riscritte da capo (la pagina Global Azure cambia edizione
 * senza ricaricare): il contenitore resta lo stesso, i figli no.
 */
export function replay(target) {
    if (!target) return;
    target.classList.remove('is-visible');
    seen.delete(target);
    initReveal(target.parentElement ?? document);
}
