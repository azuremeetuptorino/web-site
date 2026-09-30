import { escapeHtml, safeUrl } from './dom.js';
import { PLACEHOLDER_AVATAR, PLACEHOLDER_LOGO, PLACEHOLDER_EVENT } from './config.js';

/**
 * Markup della pagina /global-azure/.
 *
 * Funzioni pure: dati dentro, HTML fuori. Lo stato (quale edizione, quale
 * traccia, quale foto e aperta) sta in global-azure-page.js. Come nel resto
 * del sito, ogni valore interpolato passa da escapeHtml e ogni URL da safeUrl:
 * i JSON arrivano da un blob che l'admin modifica.
 */

export const TIMEZONE = 'Europe/Rome';

/** Tenuto allineato a GA_TIERS di api/src/lib/validate.js. L'ordine e quello in pagina. */
export const GA_TIERS = [
    { key: 'organizer', label: 'Organizzato da' },
    { key: 'diamond', label: 'Diamond Partner' },
    { key: 'platinum', label: 'Platinum Partner' },
    { key: 'gold', label: 'Gold Partner' },
    { key: 'silver', label: 'Silver Partner' },
    { key: 'contributor', label: 'Con il prezioso contributo di' }
];

const LANGUAGE = { it: 'Italiano', en: 'English' };

const FULL_WIDTH = new Set(['keynote', 'plenary', 'service']);

/* ==========================================================
   FORMATI
   ========================================================== */

const clock = new Intl.DateTimeFormat('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: TIMEZONE });
const dayKey = new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: TIMEZONE });
const dayLabel = new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TIMEZONE });

export const formatClock = (iso) => clock.format(new Date(iso));

export function formatEditionDate(date) {
    if (!date) return null;
    const parsed = new Date(`${date}T12:00:00Z`);
    if (Number.isNaN(parsed.getTime())) return null;
    return new Intl.DateTimeFormat('it-IT', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', timeZone: 'UTC' })
        .format(parsed);
}

const minutes = (session) => Math.round((Date.parse(session.end) - Date.parse(session.start)) / 60000);

/** Oggi e il giorno dell'edizione, prima, o dopo? Decide il tono della hero. */
export function editionPhase(edition, now = Date.now()) {
    if (!edition?.date) return 'unknown';
    const today = dayKey.format(new Date(now));
    if (edition.date === today) return 'live';
    return edition.date > today ? 'upcoming' : 'past';
}

/**
 * L'inizio della giornata, per il conto alla rovescia. Nel JSON c'e solo il
 * giorno: le edizioni aprono alle 9, e cadono sempre tra aprile e maggio,
 * quindi in ora legale (+02:00).
 */
export function editionStart(edition) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(edition?.date ?? '')) return NaN;
    return Date.parse(`${edition.date}T09:00:00+02:00`);
}

/**
 * Un'edizione "gia fatta" e una di cui conta piu com'e andata di cosa c'era
 * in programma. Vale anche per quelle senza data (2018, 2024): se l'anno e
 * alle spalle, sono passate.
 */
export function isEditionOver(edition, phase = editionPhase(edition), now = Date.now()) {
    if (phase === 'past') return true;
    if (phase !== 'unknown') return false;
    const year = Number(edition?.year ?? edition?.id);
    return Number.isInteger(year) && year < new Date(now).getFullYear();
}

/** Le sezioni che cambiano posto, nell'ordine in cui compaiono prima dello sponsor. */
export const MOVABLE_SECTIONS = ['agenda', 'speaker', 'foto'];

/**
 * Prima dell'evento si viene a vedere il programma; dopo, le foto. Per
 * un'edizione conclusa agenda e speaker scendono sotto la galleria.
 */
export function sectionOrder(edition, phase = editionPhase(edition), now = Date.now()) {
    return isEditionOver(edition, phase, now)
        ? ['foto', 'agenda', 'speaker']
        : [...MOVABLE_SECTIONS];
}

/** Edizioni pubblicate, dalla piu recente. */
export function visibleEditions(index) {
    return (index?.editions ?? [])
        .filter((edition) => edition && edition.published !== false && /^20\d{2}$/.test(edition.id))
        .sort((a, b) => b.id.localeCompare(a.id));
}

export function pickEdition(editions, wanted) {
    return editions.find((edition) => edition.id === wanted)
        ?? editions.find((edition) => edition.current)
        ?? editions[0]
        ?? null;
}

/* ==========================================================
   HERO E NUMERI
   ========================================================== */

export function renderHeroMeta(edition, phase) {
    const items = [];
    const when = formatEditionDate(edition.date);
    if (when) items.push(`<li><i class="bi bi-calendar-event" aria-hidden="true"></i> <span>${escapeHtml(when)}</span></li>`);

    const venue = [edition.venue?.name, edition.venue?.city].filter(Boolean).join(', ');
    if (venue) items.push(`<li><i class="bi bi-geo-alt" aria-hidden="true"></i> <span>${escapeHtml(venue)}</span></li>`);

    const status = {
        live: ['is-live', 'In corso oggi'],
        upcoming: ['is-upcoming', 'Prossima edizione'],
        past: ['is-past', 'Edizione conclusa']
    }[phase];
    if (status) items.push(`<li class="ga-status ${status[0]}"><span class="ga-status-dot" aria-hidden="true"></span> ${status[1]}</li>`);

    return items.join('');
}

export function renderHeroActions(edition, phase, content) {
    const actions = [];
    const registration = safeUrl(edition.registrationUrl, '');
    if (registration && phase !== 'past') {
        actions.push(`<a class="ga-btn ga-btn-primary" href="${escapeHtml(registration)}" target="_blank" rel="noopener noreferrer">
            <i class="bi bi-ticket-perforated" aria-hidden="true"></i> Registrati</a>`);
    }
    // A edizione conclusa le foto vengono prima dell'agenda, come in pagina.
    const agenda = content.sessions.length > 0 ? ['#agenda', 'bi-calendar3-week', 'Agenda'] : null;
    const photos = content.photos.length > 0 ? ['#foto', 'bi-images', `${content.photos.length} foto`] : null;
    const order = isEditionOver(edition, phase) ? [photos, agenda] : [agenda, photos];
    for (const [href, icon, label] of order.filter(Boolean)) {
        actions.push(`<a class="ga-btn ${actions.length ? 'ga-btn-ghost' : 'ga-btn-primary'}" href="${href}">
            <i class="bi ${icon}" aria-hidden="true"></i> ${escapeHtml(label)}</a>`);
    }
    if (registration && phase === 'past') {
        actions.push(`<a class="ga-btn ga-btn-ghost" href="${escapeHtml(registration)}" target="_blank" rel="noopener noreferrer">
            <i class="bi bi-box-arrow-up-right" aria-hidden="true"></i> Pagina dell'evento</a>`);
    }
    return actions.join('');
}

/**
 * I numeri: quelli scritti dall'admin vincono, altrimenti si contano dai
 * contenuti. I partecipanti non si possono contare: o ci sono o no.
 */
export function statsFor(edition, content) {
    const talks = content.sessions.filter((session) => !['service', 'plenary'].includes(session.kind)).length;
    const stats = [
        { key: 'attendees', label: 'Partecipanti', value: edition.stats?.attendees, suffix: '+' },
        { key: 'sessions', label: 'Sessioni', value: edition.stats?.sessions ?? (talks || undefined) },
        { key: 'speakers', label: 'Speaker', value: edition.stats?.speakers ?? (content.speakers.length || undefined) },
        { key: 'tracks', label: 'Tracce', value: edition.stats?.tracks ?? (content.tracks.length || undefined) },
        { key: 'photos', label: 'Foto', value: content.photos.length || undefined }
    ];
    const known = stats.filter((stat) => Number.isInteger(stat.value) && stat.value > 0).slice(0, 4);
    // Un numero da solo in un riquadro largo quanto la pagina sembra un buco, non un dato.
    return known.length >= 2 ? known : [];
}

export function renderStats(stats) {
    return stats.map((stat) => `
        <div class="ga-stat" data-stat="${escapeHtml(stat.key)}">
            <dt>${escapeHtml(stat.label)}</dt>
            <dd><span data-count-to="${stat.value}">${stat.value}</span>${stat.suffix ? `<small>${escapeHtml(stat.suffix)}</small>` : ''}</dd>
        </div>`).join('');
}

export function renderEditionSwitch(editions, activeId) {
    return editions.map((edition) => `
        <a class="ga-year-chip" href="?anno=${escapeHtml(edition.id)}" data-edition="${escapeHtml(edition.id)}"
           ${edition.id === activeId ? 'aria-current="page"' : ''}>${escapeHtml(edition.id)}</a>`).join('');
}

/* ==========================================================
   AGENDA
   ========================================================== */

function serviceIcon(title) {
    const text = String(title ?? '').toLowerCase();
    if (/check|registraz|accredit/.test(text)) return 'bi-qr-code-scan';
    if (/coffee|caff/.test(text)) return 'bi-cup-hot';
    if (/lunch|pranzo/.test(text)) return 'bi-egg-fried';
    if (/aperitiv|birra|beer|drink/.test(text)) return 'bi-cup-straw';
    if (/saluti|chiusura|closing/.test(text)) return 'bi-stars';
    return 'bi-clock';
}

function avatars(ids, speakersById, max = 3) {
    const people = ids.map((id) => speakersById.get(id)).filter(Boolean);
    if (people.length === 0) return '';
    const faces = people.slice(0, max).map((speaker) =>
        `<img src="${escapeHtml(safeUrl(speaker.photoUrl, PLACEHOLDER_AVATAR))}" alt="" loading="lazy" width="28" height="28">`).join('');
    const more = people.length > max ? `<span class="ga-avatar-more">+${people.length - max}</span>` : '';
    const names = people.length > 3
        ? `${people.slice(0, 2).map((speaker) => speaker.name).join(', ')} e altri ${people.length - 2}`
        : people.map((speaker) => speaker.name).join(', ');
    return `<div class="ga-session-people"><span class="ga-avatars">${faces}${more}</span><span>${escapeHtml(names)}</span></div>`;
}

function sessionCard(session, context, placement) {
    const { tracksById, speakersById, now } = context;
    const track = tracksById.get(session.trackId);
    const wide = FULL_WIDTH.has(session.kind) || !track;
    const live = now >= Date.parse(session.start) && now < Date.parse(session.end);

    const classes = ['ga-session', `ga-kind-${session.kind ?? 'talk'}`];
    if (wide) classes.push('is-wide');
    if (live) classes.push('is-live');

    const style = [
        placement ? `grid-row:${placement.row} / span ${placement.span}` : '',
        placement ? `grid-column:${wide ? '2 / -1' : placement.column}` : '',
        track?.color ? `--track:${track.color}` : ''
    ].filter(Boolean).join(';');

    const time = `${formatClock(session.start)} – ${formatClock(session.end)}`;
    const meta = [
        `<span class="ga-session-time"><i class="bi bi-clock" aria-hidden="true"></i> ${escapeHtml(time)}</span>`,
        track ? `<span class="ga-session-track">${escapeHtml(track.name)}</span>` : '',
        session.language === 'en' ? '<span class="ga-lang" title="In inglese">EN</span>' : '',
        live ? '<span class="ga-live-badge">Ora</span>' : ''
    ].join('');

    if (session.kind === 'service') {
        return `<div class="${classes.join(' ')}" style="${style}" data-track="">
            <i class="bi ${serviceIcon(session.title)} ga-service-icon" aria-hidden="true"></i>
            <span class="ga-service-title">${escapeHtml(session.title)}</span>
            <span class="ga-session-time">${escapeHtml(time)}</span>
        </div>`;
    }

    const eyebrow = session.kind === 'keynote' ? '<span class="ga-eyebrow-chip">Keynote</span>' : '';
    return `<button type="button" class="${classes.join(' ')}" style="${style}"
                data-session="${escapeHtml(session.id)}" data-track="${escapeHtml(wide ? '' : session.trackId ?? '')}">
        <span class="ga-session-meta">${eyebrow}${meta}</span>
        <span class="ga-session-title">${escapeHtml(session.title)}</span>
        ${avatars(session.speakerIds ?? [], speakersById)}
    </button>`;
}

/**
 * La griglia di un giorno: una colonna per traccia, una riga per ogni orario
 * di inizio. Una sessione lunga copre tutte le righe che iniziano prima della
 * sua fine; keynote, plenarie e pause occupano la riga intera.
 *
 * Sotto i 900 px lo stesso DOM diventa una lista cronologica: l'ordine degli
 * elementi e gia quello giusto (orario, poi traccia), il CSS toglie la griglia.
 */
function renderDay(sessions, tracks, context) {
    const starts = [...new Set(sessions.map((session) => session.start))].sort();
    const rowOf = new Map(starts.map((start, index) => [start, index + 1]));
    const columnOf = new Map(tracks.map((track, index) => [track.id, index + 2]));
    const trackOrder = new Map(tracks.map((track, index) => [track.id, index]));

    const ordered = [...sessions].sort((a, b) =>
        a.start.localeCompare(b.start) || (trackOrder.get(a.trackId) ?? -1) - (trackOrder.get(b.trackId) ?? -1));

    const html = [];
    let lastStart = null;
    for (const session of ordered) {
        if (session.start !== lastStart) {
            lastStart = session.start;
            html.push(`<div class="ga-slot" style="grid-row:${rowOf.get(session.start)}"><span>${escapeHtml(formatClock(session.start))}</span></div>`);
        }
        const row = rowOf.get(session.start);
        const span = Math.max(1, starts.filter((start) => start >= session.start && start < session.end).length);
        html.push(sessionCard(session, context, { row, span, column: columnOf.get(session.trackId) ?? '2 / -1' }));
    }

    return `<div class="ga-agenda-grid" style="--tracks:${Math.max(tracks.length, 1)}">
        ${tracks.length > 1 ? `<div class="ga-track-heads" aria-hidden="true"><span></span>${tracks.map((track) =>
            `<span class="ga-track-head" style="${track.color ? `--track:${track.color}` : ''}">${escapeHtml(track.name)}</span>`).join('')}</div>` : ''}
        <div class="ga-agenda-body">${html.join('')}</div>
    </div>`;
}

export function renderAgenda(content, now = Date.now()) {
    const context = {
        tracksById: new Map(content.tracks.map((track) => [track.id, track])),
        speakersById: new Map(content.speakers.map((speaker) => [speaker.id, speaker])),
        now
    };

    const days = new Map();
    for (const session of content.sessions) {
        const key = dayKey.format(new Date(session.start));
        if (!days.has(key)) days.set(key, []);
        days.get(key).push(session);
    }

    return [...days.entries()].map(([key, sessions]) => `
        <div class="ga-day">
            ${days.size > 1 ? `<h3 class="ga-day-title">${escapeHtml(dayLabel.format(new Date(sessions[0].start)))}</h3>` : ''}
            ${renderDay(sessions, content.tracks, context)}
        </div>`).join('');
}

export function renderTrackFilter(tracks) {
    if (tracks.length < 2) return '';
    return [
        '<button type="button" class="ga-chip" data-track-filter="" aria-pressed="true">Tutte le tracce</button>',
        ...tracks.map((track) => `<button type="button" class="ga-chip" data-track-filter="${escapeHtml(track.id)}"
            aria-pressed="false" style="${track.color ? `--track:${track.color}` : ''}"><span class="ga-chip-dot" aria-hidden="true"></span>${escapeHtml(track.name)}</button>`)
    ].join('');
}

/* ==========================================================
   SPEAKER
   ========================================================== */

export function renderSpeakers(content) {
    const busy = new Set(content.sessions.flatMap((session) => session.speakerIds ?? []));
    return [...content.speakers]
        // Chi non ha una sessione (un refuso, o lo staff sul palco dei saluti)
        // resta in fondo: la parete e di chi ha parlato.
        .sort((a, b) => Number(busy.has(b.id)) - Number(busy.has(a.id)) || a.name.localeCompare(b.name, 'it'))
        .map((speaker) => `
        <button type="button" class="ga-speaker" data-speaker="${escapeHtml(speaker.id)}">
            <span class="ga-speaker-photo"><img src="${escapeHtml(safeUrl(speaker.photoUrl, PLACEHOLDER_AVATAR))}"
                 alt="" loading="lazy" width="200" height="200"></span>
            <span class="ga-speaker-name">${escapeHtml(speaker.name)}</span>
            ${speaker.tagline ? `<span class="ga-speaker-tagline">${escapeHtml(speaker.tagline)}</span>` : ''}
            ${(speaker.badges ?? []).length ? `<span class="ga-badges">${speaker.badges.map((badge) =>
                `<span class="ga-badge">${escapeHtml(badge)}</span>`).join('')}</span>` : ''}
        </button>`).join('');
}

/* ==========================================================
   DETTAGLIO (dialog)
   ========================================================== */

const LINK_ICONS = { linkedin: 'bi-linkedin', website: 'bi-globe2', github: 'bi-github', x: 'bi-twitter-x', bluesky: 'bi-bluesky' };
const LINK_LABELS = { linkedin: 'LinkedIn', website: 'Sito', github: 'GitHub', x: 'X', bluesky: 'Bluesky' };

function paragraphs(text) {
    return String(text ?? '')
        .split(/\n{2,}/)
        .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br>')}</p>`)
        .join('');
}

export function renderSessionDetail(session, content) {
    const track = content.tracks.find((entry) => entry.id === session.trackId);
    const speakers = (session.speakerIds ?? []).map((id) => content.speakers.find((entry) => entry.id === id)).filter(Boolean);
    const when = `${dayLabel.format(new Date(session.start))}, ${formatClock(session.start)} – ${formatClock(session.end)}`;

    return `
        <div class="ga-detail-header" style="${track?.color ? `--track:${track.color}` : ''}">
            <div class="ga-detail-tags">
                ${session.kind === 'keynote' ? '<span class="ga-eyebrow-chip">Keynote</span>' : ''}
                ${track ? `<span class="ga-session-track">${escapeHtml(track.name)}</span>` : ''}
                ${session.language ? `<span class="ga-lang">${escapeHtml(LANGUAGE[session.language] ?? session.language)}</span>` : ''}
            </div>
            <h2 class="ga-detail-title" id="ga-dialog-title">${escapeHtml(session.title)}</h2>
            <p class="ga-detail-when"><i class="bi bi-clock" aria-hidden="true"></i> ${escapeHtml(when)} · ${minutes(session)} min</p>
        </div>
        ${session.description ? `<div class="ga-detail-body">${paragraphs(session.description)}</div>` : ''}
        ${speakers.length ? `<div class="ga-detail-people">
            ${speakers.map((speaker) => `
                <button type="button" class="ga-person" data-speaker="${escapeHtml(speaker.id)}">
                    <img src="${escapeHtml(safeUrl(speaker.photoUrl, PLACEHOLDER_AVATAR))}" alt="" width="52" height="52" loading="lazy">
                    <span><strong>${escapeHtml(speaker.name)}</strong>${speaker.tagline ? `<small>${escapeHtml(speaker.tagline)}</small>` : ''}</span>
                    <i class="bi bi-chevron-right" aria-hidden="true"></i>
                </button>`).join('')}
        </div>` : ''}`;
}

export function renderSpeakerDetail(speaker, content) {
    const sessions = content.sessions.filter((session) => (session.speakerIds ?? []).includes(speaker.id));
    const links = Object.entries(speaker.links ?? {})
        .map(([type, url]) => [type, safeUrl(url, '')])
        .filter(([, url]) => url);

    return `
        <div class="ga-detail-header ga-detail-speaker">
            <img class="ga-detail-photo" src="${escapeHtml(safeUrl(speaker.photoUrl, PLACEHOLDER_AVATAR))}" alt="" width="120" height="120">
            <div>
                <h2 class="ga-detail-title" id="ga-dialog-title">${escapeHtml(speaker.name)}</h2>
                ${speaker.tagline ? `<p class="ga-detail-when">${escapeHtml(speaker.tagline)}</p>` : ''}
                ${(speaker.badges ?? []).length ? `<p class="ga-badges">${speaker.badges.map((badge) =>
                    `<span class="ga-badge">${escapeHtml(badge)}</span>`).join('')}</p>` : ''}
                ${links.length ? `<p class="ga-detail-links">${links.map(([type, url]) =>
                    `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer" aria-label="${escapeHtml(LINK_LABELS[type] ?? type)}">
                        <i class="bi ${LINK_ICONS[type] ?? 'bi-link-45deg'}" aria-hidden="true"></i></a>`).join('')}</p>` : ''}
            </div>
        </div>
        ${speaker.bio ? `<div class="ga-detail-body">${paragraphs(speaker.bio)}</div>` : ''}
        ${sessions.length ? `<div class="ga-detail-sessions">
            <h3>${sessions.length === 1 ? 'La sessione' : 'Le sessioni'}</h3>
            ${sessions.map((session) => `
                <button type="button" class="ga-person" data-session="${escapeHtml(session.id)}">
                    <span class="ga-mini-time">${escapeHtml(formatClock(session.start))}</span>
                    <span><strong>${escapeHtml(session.title)}</strong></span>
                    <i class="bi bi-chevron-right" aria-hidden="true"></i>
                </button>`).join('')}
        </div>` : ''}`;
}

/* ==========================================================
   GALLERIA
   ========================================================== */

/**
 * Griglia "giustificata", come negli album fotografici: ogni riga ha la
 * stessa altezza e ogni foto la larghezza che le spetta dalle sue
 * proporzioni, quindi niente ritagli. Le proporzioni arrivano al CSS in
 * `--ar`; le misure scritte nel JSON servono proprio a questo, e a riservare
 * lo spazio prima che l'immagine arrivi, senza salti di layout.
 *
 * La prima foto in evidenza apre la galleria a tutta larghezza, e per
 * questo usa la versione grande: la miniatura, stirata a 1300 px, si sgrana.
 */
export const photoRatio = (photo) =>
    photo.width > 0 && photo.height > 0 ? Math.round((photo.width / photo.height) * 1000) / 1000 : 1.5;

export function renderGallery(photos, { limit = Infinity } = {}) {
    const spotlight = photos.findIndex((photo) => photo.featured);
    return photos.slice(0, limit).map((photo, index) => `
        <button type="button" class="ga-tile${index === spotlight ? ' is-spotlight' : ''}" data-photo="${index}"
                style="--ar:${photoRatio(photo)}"
                aria-label="${escapeHtml(photo.caption || `Foto ${index + 1} di ${photos.length}`)}">
            <img src="${escapeHtml(safeUrl(index === spotlight ? photo.url : photo.thumbUrl || photo.url, PLACEHOLDER_EVENT))}" alt="${escapeHtml(photo.caption ?? '')}"
                 loading="${index < 8 ? 'eager' : 'lazy'}" decoding="async"
                 ${photo.width && photo.height ? `width="${photo.width}" height="${photo.height}"` : ''}>
            ${photo.caption ? `<span class="ga-tile-caption">${escapeHtml(photo.caption)}</span>` : ''}
        </button>`).join('');
}

/** La striscia di miniature sotto la foto aperta. */
export function renderFilmstrip(photos) {
    return photos.map((photo, index) => `
        <button type="button" class="ga-strip-thumb" data-strip="${index}" style="--ar:${photoRatio(photo)}"
                aria-label="Foto ${index + 1} di ${photos.length}">
            <img src="${escapeHtml(safeUrl(photo.thumbUrl || photo.url, PLACEHOLDER_EVENT))}" alt="" loading="lazy" decoding="async">
        </button>`).join('');
}

/* ==========================================================
   SPONSOR
   ========================================================== */

export function renderGaSponsors(sponsors) {
    const known = new Set(GA_TIERS.map((tier) => tier.key));
    return GA_TIERS
        .map((tier) => ({
            ...tier,
            sponsors: sponsors.filter((sponsor) =>
                sponsor.tier === tier.key || (tier.key === 'contributor' && !known.has(sponsor.tier)))
        }))
        .filter((group) => group.sponsors.length > 0)
        .map((group) => `
            <section class="sponsor-tier ga-tier" data-tier="${escapeHtml(group.key)}">
                <h3 class="sponsor-tier-title">${escapeHtml(group.label)}</h3>
                <div class="sponsors-grid">
                    ${group.sponsors.map((sponsor) => {
                        const image = `<img src="${escapeHtml(safeUrl(sponsor.logoUrl, PLACEHOLDER_LOGO))}" alt="${escapeHtml(sponsor.name)}" loading="lazy">`;
                        const website = safeUrl(sponsor.websiteUrl, '');
                        return website
                            ? `<a class="sponsor-card" data-tier="${escapeHtml(group.key)}" href="${escapeHtml(website)}" target="_blank" rel="noopener noreferrer sponsored" title="${escapeHtml(sponsor.name)}">${image}</a>`
                            : `<div class="sponsor-card" data-tier="${escapeHtml(group.key)}" title="${escapeHtml(sponsor.name)}">${image}</div>`;
                    }).join('')}
                </div>
            </section>`).join('');
}

/* ==========================================================
   ARCHIVIO DELLE EDIZIONI
   ========================================================== */

/**
 * @param {object[]} editions tutte, tranne quella aperta
 * @param {Map<string, object>} previews contenuti gia scaricati, per le miniature
 */
export function renderEditionCards(editions, previews = new Map()) {
    return editions.map((edition) => {
        const content = previews.get(edition.id);
        const featured = (content?.photos ?? []).filter((photo) => photo.featured);
        const strip = (featured.length ? featured : content?.photos ?? []).slice(0, 3);
        const cover = safeUrl(edition.coverUrl || strip[0]?.url, '');
        const when = formatEditionDate(edition.date);
        const numbers = [
            edition.stats?.attendees ? `${edition.stats.attendees}+ partecipanti` : null,
            edition.stats?.sessions ? `${edition.stats.sessions} sessioni` : null,
            content?.photos?.length ? `${content.photos.length} foto` : null
        ].filter(Boolean);

        return `
        <a class="ga-edition" href="?anno=${escapeHtml(edition.id)}" data-edition="${escapeHtml(edition.id)}">
            <span class="ga-edition-media">
                ${cover ? `<img src="${escapeHtml(cover)}" alt="" loading="lazy">` : '<span class="ga-edition-placeholder" aria-hidden="true"></span>'}
                <span class="ga-edition-year">${escapeHtml(edition.id)}</span>
            </span>
            <span class="ga-edition-body">
                <strong>${escapeHtml(edition.title || `Global Azure ${edition.id}`)}</strong>
                ${when ? `<span class="ga-edition-date">${escapeHtml(when)}</span>` : ''}
                ${edition.tagline ? `<span class="ga-edition-tagline">${escapeHtml(edition.tagline)}</span>` : ''}
                ${numbers.length ? `<span class="ga-edition-numbers">${numbers.map((item) => `<span>${escapeHtml(item)}</span>`).join('')}</span>` : ''}
                ${strip.length > 1 ? `<span class="ga-edition-strip">${strip.map((photo) =>
                    `<img src="${escapeHtml(safeUrl(photo.thumbUrl || photo.url, ''))}" alt="" loading="lazy">`).join('')}</span>` : ''}
            </span>
        </a>`;
    }).join('');
}

/* ==========================================================
   TEASER IN HOME
   ========================================================== */

/**
 * Il banner della home verso /global-azure/, sull'edizione corrente.
 * @returns {number} 1 se c'e qualcosa da mostrare, 0 altrimenti
 */
export function renderTeaser(container, index, now = Date.now()) {
    const edition = pickEdition(visibleEditions(index), null);
    if (!edition) return 0;

    const phase = editionPhase(edition, now);
    const when = formatEditionDate(edition.date);
    const cta = {
        live: 'Segui la giornata',
        upcoming: 'Scopri il programma',
        past: 'Rivivi l’edizione: agenda e foto'
    }[phase] ?? 'Scopri Global Azure Torino';

    // I due contenitori li riempie main.js: il conto alla rovescia se
    // l'edizione deve ancora arrivare, le foto (caricate solo quando il banner
    // entra nello schermo) se e gia passata.
    const extra = phase === 'upcoming' && Number.isFinite(editionStart(edition))
        ? '<span class="ga-teaser-countdown" data-teaser-countdown></span>'
        : isEditionOver(edition, phase, now)
            ? `<span class="ga-teaser-photos" data-teaser-photos="${escapeHtml(edition.id)}" hidden></span>`
            : '';

    container.dataset.phase = phase;
    container.innerHTML = `
        <span class="ga-teaser-year" aria-hidden="true">${escapeHtml(edition.id)}</span>
        <span class="ga-teaser-body">
            <span class="ga-teaser-eyebrow">${phase === 'upcoming' ? 'Il grande evento dell’anno' : 'Global Azure Torino'}</span>
            <strong>${escapeHtml(edition.title || `Global Azure Torino ${edition.id}`)}</strong>
            ${edition.tagline || when ? `<span class="ga-teaser-text">${escapeHtml([when, edition.tagline].filter(Boolean).join(' — '))}</span>` : ''}
        </span>
        <span class="ga-teaser-cta">${escapeHtml(cta)} <i class="bi bi-arrow-right" aria-hidden="true"></i></span>
        ${extra}`;
    return 1;
}

/** Le foto del banner: prima quelle in evidenza, poi le altre, fino a `limit`. */
export function renderTeaserPhotos(photos, limit = 5) {
    const featured = photos.filter((photo) => photo.featured);
    const rest = photos.filter((photo) => !photo.featured);
    return [...featured, ...rest].slice(0, limit).map((photo, index) => `
        <span class="ga-teaser-photo" style="--i:${index}">
            <img src="${escapeHtml(safeUrl(photo.thumbUrl || photo.url, PLACEHOLDER_EVENT))}" alt="" loading="lazy" decoding="async">
        </span>`).join('');
}
