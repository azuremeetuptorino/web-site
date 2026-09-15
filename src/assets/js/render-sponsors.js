import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_LOGO } from './config.js';

/**
 * Peso dei tier. Governa l'ordine (e, dalla P4, la dimensione del logo),
 * cosi aggiungere uno sponsor non richiede mai di toccare il CSS.
 */
export const TIER_WEIGHT = {
    gold: 10,
    silver: 20,
    bronze: 30,
    partner: 40,
    venue: 50,
    media: 60
};

/** Attivi, ordinati per tier, poi per `order`, poi per nome. */
export function sortSponsors(sponsors) {
    return sponsors
        .filter((sponsor) => sponsor && sponsor.active !== false)
        .sort((a, b) =>
            (TIER_WEIGHT[a.tier] ?? 99) - (TIER_WEIGHT[b.tier] ?? 99) ||
            (a.order ?? 0) - (b.order ?? 0) ||
            String(a.name).localeCompare(String(b.name), 'it')
        );
}

function renderSponsor(sponsor) {
    const name = escapeHtml(sponsor.name);
    const logo = escapeHtml(safeUrl(sponsor.logoUrl, PLACEHOLDER_LOGO));
    const tier = escapeHtml(sponsor.tier ?? 'partner');
    const image = `<img src="${logo}" alt="${name}" loading="lazy">`;

    // Senza sito lo sponsor resta una card non cliccabile.
    const website = safeUrl(sponsor.websiteUrl, '');
    if (website) {
        return `<a class="sponsor-card" data-tier="${tier}" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer sponsored" title="${name}">${image}</a>`;
    }
    return `<div class="sponsor-card" data-tier="${tier}" title="${name}">${image}</div>`;
}

/**
 * Riempie la griglia sponsor.
 * @returns {number} quante card sono state renderizzate
 */
export function renderSponsors(container, payload) {
    const sponsors = sortSponsors(payload?.sponsors ?? []);
    container.innerHTML = sponsors.map(renderSponsor).join('\n');
    return sponsors.length;
}
