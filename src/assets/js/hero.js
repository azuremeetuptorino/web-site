import { escapeHtml, safeUrl } from './dom.js';
import { visibleEvents, isPast, formatWhen, formatWhere } from './render-events.js';

/**
 * I pezzi animati della hero in home: la parola che si scrive da sola, la card
 * del prossimo evento e il suo conto alla rovescia (riusato anche dal banner
 * e dalla pagina di Global Azure).
 */

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

/* ==========================================================
   MACCHINA DA SCRIVERE
   ========================================================== */

/**
 * Le parole stanno in `data-words`, separate da `|`. La prima e gia scritta
 * nell'HTML: senza JavaScript la frase resta completa e sensata. Chi usa uno
 * screen reader legge l'elenco intero in un testo nascosto, non le lettere che
 * compaiono e spariscono.
 */
export function initTypewriter(root = document) {
    for (const element of root.querySelectorAll('[data-typewriter]')) {
        const words = (element.dataset.words ?? '').split('|').map((word) => word.trim()).filter(Boolean);
        if (words.length < 2 || reducedMotion.matches) continue;

        let word = 0;
        let letters = words[0].length;
        let deleting = true;

        const tick = () => {
            const current = words[word];
            element.textContent = current.slice(0, letters);

            if (deleting) {
                if (letters > 0) {
                    letters -= 1;
                    return setTimeout(tick, 45);
                }
                deleting = false;
                word = (word + 1) % words.length;
                return setTimeout(tick, 250);
            }
            if (letters < words[word].length) {
                letters += 1;
                element.textContent = words[word].slice(0, letters);
                return setTimeout(tick, 85);
            }
            deleting = true;
            return setTimeout(tick, 2200);
        };

        setTimeout(tick, 2600);
    }
}

/* ==========================================================
   CONTO ALLA ROVESCIA
   ========================================================== */

const UNITS = [
    ['days', 'giorni', 86400],
    ['hours', 'ore', 3600],
    ['minutes', 'min', 60],
    ['seconds', 'sec', 1]
];

/** Giorni, ore, minuti e secondi che mancano a `target` (millisecondi). */
export function remaining(target, now = Date.now()) {
    let seconds = Math.max(0, Math.floor((target - now) / 1000));
    const parts = {};
    for (const [key, , size] of UNITS) {
        parts[key] = Math.floor(seconds / size);
        seconds -= parts[key] * size;
    }
    return parts;
}

/**
 * Disegna il conto alla rovescia in `container` e lo aggiorna ogni secondo.
 * Le cifre che cambiano ricevono `.is-tick` per un attimo: l'animazione e
 * nel CSS, e con meno movimento le cifre cambiano e basta.
 *
 * @returns {() => void} ferma il conteggio
 */
export function startCountdown(container, target, { onEnd } = {}) {
    if (!container || !Number.isFinite(target)) return () => {};

    container.classList.add('countdown');
    container.setAttribute('role', 'timer');
    container.innerHTML = UNITS.map(([key, label]) => `
        <span class="countdown-unit" data-unit="${key}">
            <span class="countdown-value">00</span>
            <span class="countdown-label">${label}</span>
        </span>`).join('');

    const values = Object.fromEntries(UNITS.map(([key]) =>
        [key, container.querySelector(`[data-unit="${key}"] .countdown-value`)]));

    let timer = 0;
    const render = () => {
        const parts = remaining(target);
        for (const [key] of UNITS) {
            const text = String(parts[key]).padStart(2, '0');
            const value = values[key];
            if (value.textContent === text) continue;
            value.textContent = text;
            value.classList.remove('is-tick');
            // Rileggere una misura fa ripartire l'animazione dall'inizio.
            void value.offsetWidth;
            value.classList.add('is-tick');
        }
        container.setAttribute('aria-label',
            `Mancano ${parts.days} giorni, ${parts.hours} ore e ${parts.minutes} minuti`);

        if (target <= Date.now()) {
            clearInterval(timer);
            onEnd?.();
        }
    };

    render();
    timer = setInterval(render, 1000);
    return () => clearInterval(timer);
}

/* ==========================================================
   PROSSIMO EVENTO
   ========================================================== */

/**
 * Riempie la card "Prossimo evento" della hero con il primo evento non ancora
 * passato. Senza eventi futuri la card resta nascosta: una hero che annuncia
 * un evento gia fatto dice il contrario di quello che vuole.
 *
 * @returns {boolean} se la card e stata mostrata
 */
export function renderNextEvent(card, payload, now = Date.now()) {
    if (!card) return false;
    const next = visibleEvents(payload, now).find((event) => !isPast(event, now) && event.dateTime);
    if (!next) {
        card.hidden = true;
        return false;
    }

    const url = safeUrl(next.eventUrl, '');
    if (url) {
        card.href = url;
        card.target = '_blank';
        card.rel = 'noopener noreferrer';
    }

    const set = (name, text) => {
        const slot = card.querySelector(`[data-next="${name}"]`);
        if (slot) slot.innerHTML = escapeHtml(text);
    };
    set('title', next.title);
    set('when', formatWhen(next));
    set('where', formatWhere(next));

    const start = Date.parse(next.dateTime);
    const countdown = card.querySelector('[data-next="countdown"]');
    const label = card.querySelector('[data-next="label"]');
    if (start > now) {
        startCountdown(countdown, start, {
            onEnd: () => { if (label) label.textContent = 'In corso ora'; }
        });
    } else {
        // Iniziato e non ancora finito.
        if (label) label.textContent = 'In corso ora';
        if (countdown) countdown.hidden = true;
    }

    card.hidden = false;
    return true;
}
