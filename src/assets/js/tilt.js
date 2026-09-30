/**
 * Inclinazione 3D al passaggio del mouse.
 *
 * Un solo ascoltatore sul documento, delegato: le card vengono renderizzate
 * e riscritte dai dati, e agganciarle una per una vorrebbe dire ricordarsi di
 * farlo a ogni render. Il JavaScript scrive solo `--rx` e `--ry`; la
 * trasformazione vera la decide il CSS (`.tilt` in effects.css).
 *
 * Solo con un puntatore preciso: col dito l'inclinazione arriverebbe dopo il
 * tocco, a pagina gia cambiata.
 */

const MAX_DEGREES = 8;

export function initTilt(selector) {
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)');
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

    let active = null;
    let frame = 0;
    let last = null;

    function reset(card) {
        card?.style.removeProperty('--rx');
        card?.style.removeProperty('--ry');
        card?.classList.remove('is-tilting');
    }

    document.addEventListener('pointermove', (event) => {
        if (!fine.matches || reducedMotion.matches) return;

        const card = event.target.closest?.(selector) ?? null;
        if (card !== active) {
            reset(active);
            active = card;
        }
        if (!card) return;

        last = event;
        if (frame) return;
        frame = requestAnimationFrame(() => {
            frame = 0;
            if (!active || !last) return;
            const rect = active.getBoundingClientRect();
            const x = (last.clientX - rect.left) / rect.width - 0.5;
            const y = (last.clientY - rect.top) / rect.height - 0.5;
            active.classList.add('is-tilting');
            active.style.setProperty('--rx', `${(-y * MAX_DEGREES).toFixed(2)}deg`);
            active.style.setProperty('--ry', `${(x * MAX_DEGREES).toFixed(2)}deg`);
            active.style.setProperty('--mx', `${((x + 0.5) * 100).toFixed(1)}%`);
            active.style.setProperty('--my', `${((y + 0.5) * 100).toFixed(1)}%`);
        });
    }, { passive: true });

    document.addEventListener('pointerleave', () => {
        reset(active);
        active = null;
    });
}
