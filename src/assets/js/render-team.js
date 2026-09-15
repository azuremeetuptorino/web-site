import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_AVATAR } from './config.js';

/**
 * Tipo di link -> icona Bootstrap Icons + etichetta accessibile.
 * Estendere qui (e nella validazione lato API) per aggiungere un social.
 */
const LINK_TYPES = {
    linkedin:  { icon: 'bi-linkedin',   label: 'LinkedIn' },
    github:    { icon: 'bi-github',     label: 'GitHub' },
    x:         { icon: 'bi-twitter-x',  label: 'X / Twitter' },
    blog:      { icon: 'bi-medium',     label: 'Blog' },
    website:   { icon: 'bi-globe',      label: 'Sito web' },
    instagram: { icon: 'bi-instagram',  label: 'Instagram' },
    youtube:   { icon: 'bi-youtube',    label: 'YouTube' },
    mastodon:  { icon: 'bi-mastodon',   label: 'Mastodon' },
    bluesky:   { icon: 'bi-cloud-fill', label: 'Bluesky' }
};

/** Attivi, ordinati per `order` e a parità di ordine per nome. */
export function sortMembers(members) {
    return members
        .filter((member) => member && member.active !== false)
        .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || String(a.name).localeCompare(String(b.name), 'it'));
}

function renderCornerLink(link) {
    if (!link || !link.url) return '';
    const meta = LINK_TYPES[link.type] ?? LINK_TYPES.website;
    const url = safeUrl(link.url);
    if (url === '#') return '';
    return `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" class="member-corner-link" title="${escapeHtml(meta.label)}"><i class="bi ${meta.icon}"></i></a>`;
}

function renderMember(member) {
    const name = escapeHtml(member.name);
    const avatar = escapeHtml(safeUrl(member.avatarUrl, PLACEHOLDER_AVATAR));
    const nick = member.nick ? `<span class="member-nick">${escapeHtml(member.nick)}</span>` : '';
    const bio = member.bio ? `<p class="member-bio">${escapeHtml(member.bio)}</p>` : '';
    const role = member.role ? `<span class="member-role-tag">${escapeHtml(member.role)}</span>` : '';

    return `<div class="swiper-slide">
    <div class="member-card">
        ${renderCornerLink(member.link)}
        <div class="member-avatar-wrapper">
            <img src="${avatar}" alt="${name}" class="member-avatar" loading="lazy">
        </div>
        ${role}
        <h4 class="member-name">${name}</h4>
        ${nick}
        ${bio}
    </div>
</div>`;
}

/**
 * Riempie la track dello Swiper del team.
 * @returns {number} quante schede sono state renderizzate
 */
export function renderTeam(container, payload) {
    const members = sortMembers(payload?.members ?? []);
    container.innerHTML = members.map(renderMember).join('\n');
    return members.length;
}
