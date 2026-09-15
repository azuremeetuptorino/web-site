import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_LOGO } from './config.js';

/**
 * Il tier e l'unico dato che governa ordine, raggruppamento e dimensione del
 * logo. E la ragione per cui aggiungere uno sponsor non richiede mai di toccare
 * il CSS: la card esce con `data-tier`, e il foglio di stile sa gia cosa farne.
 *
 * L'ordine di questa mappa e l'ordine delle fasce in pagina.
 * Tenuta allineata a TIERS di api/src/lib/validate.js.
 */
export const TIERS = [
    { key: 'gold', label: 'Gold' },
    { key: 'silver', label: 'Silver' },
    { key: 'bronze', label: 'Bronze' },
    { key: 'partner', label: 'Partner' },
    { key: 'venue', label: 'Location' },
    { key: 'media', label: 'Media partner' }
];

/** Peso per l'ordinamento: la posizione nella lista qui sopra. */
export const TIER_WEIGHT = Object.fromEntries(TIERS.map((tier, index) => [tier.key, (index + 1) * 10]));

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

/**
 * Raggruppa mantenendo l'ordine delle fasce e saltando quelle vuote.
 *
 * Uno sponsor con un tier che non conosciamo non sparisce: finisce in fondo tra
 * i Partner. Il sito pubblico non valida niente, e far scomparire in silenzio
 * chi ci sostiene sarebbe il modo peggiore di gestire un dato inatteso.
 */
export function groupByTier(sponsors) {
    const known = new Set(TIERS.map((tier) => tier.key));

    return TIERS
        .map((tier) => ({
            ...tier,
            sponsors: sponsors.filter((sponsor) =>
                sponsor.tier === tier.key || (tier.key === 'partner' && !known.has(sponsor.tier))
            )
        }))
        .filter((group) => group.sponsors.length > 0);
}

function renderSponsor(sponsor, tierKey) {
    const name = escapeHtml(sponsor.name);
    const logo = escapeHtml(safeUrl(sponsor.logoUrl, PLACEHOLDER_LOGO));
    const tier = escapeHtml(tierKey);

    const dark = safeUrl(sponsor.logoDarkUrl, '');
    const image = dark
        // Il logo per fondo scuro serve solo a chi ha il tema scuro attivo.
        ? `<picture>
            <source srcset="${escapeHtml(dark)}" media="(prefers-color-scheme: dark)">
            <img src="${logo}" alt="${name}" loading="lazy">
        </picture>`
        : `<img src="${logo}" alt="${name}" loading="lazy">`;

    const since = sponsor.since ? `<span class="sponsor-since">dal ${escapeHtml(sponsor.since)}</span>` : '';
    const title = sponsor.description ? escapeHtml(sponsor.description) : name;

    // Senza sito lo sponsor resta una card non cliccabile.
    const website = safeUrl(sponsor.websiteUrl, '');
    if (website) {
        return `<a class="sponsor-card" data-tier="${tier}" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer sponsored" title="${title}">${image}${since}</a>`;
    }
    return `<div class="sponsor-card" data-tier="${tier}" title="${title}">${image}${since}</div>`;
}

function renderGroup(group) {
    const cards = group.sponsors.map((sponsor) => renderSponsor(sponsor, group.key)).join('\n');
    return `<section class="sponsor-tier" data-tier="${escapeHtml(group.key)}">
    <h3 class="sponsor-tier-title">${escapeHtml(group.label)}</h3>
    <div class="sponsors-grid">${cards}</div>
</section>`;
}

/**
 * Riempie la sezione sponsor, una fascia per gruppo.
 * @returns {number} quante card sono state renderizzate
 */
export function renderSponsors(container, payload) {
    const sponsors = sortSponsors(payload?.sponsors ?? []);
    container.innerHTML = groupByTier(sponsors).map(renderGroup).join('\n');
    return sponsors.length;
}
