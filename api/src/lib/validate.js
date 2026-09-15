/**
 * Validazione dei documenti che l'admin salva.
 *
 * Scritta a mano di proposito: `ajv` sarebbe una dipendenza e un costo di cold
 * start (le managed functions sono su Consumption) per tre tipi di oggetto.
 *
 * Due cose che il validatore fa oltre a dire si o no:
 *  - RACCOGLIE TUTTI GLI ERRORI, non si ferma al primo. L'editor dell'admin li
 *    mostra tutti insieme accanto al campo giusto: correggerne uno per volta,
 *    con un salvataggio di rete in mezzo, sarebbe sfiancante.
 *  - RESTITUISCE UN VALORE RIPULITO. Si scrive sul blob quello che torna di qui,
 *    mai il body del client: campi sconosciuti scartati, stringhe trimmate,
 *    default applicati. Cosi il documento sul blob resta prevedibile per il
 *    rendering del sito pubblico, che non valida niente.
 */

/** Governa raggruppamento e ordinamento sul sito, `role` e solo l'etichetta. */
export const ROLE_KEYS = ['co-founder', 'organizer', 'core-team', 'speaker', 'staff'];

/** Tenuto allineato a LINK_TYPES di src/assets/js/render-team.js: la aggiunge qui e la mappa li. */
export const LINK_TYPES = [
    'linkedin', 'github', 'x', 'blog', 'website',
    'instagram', 'youtube', 'mastodon', 'bluesky'
];

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;
const MAX_MEMBERS = 200;

const LIMITS = {
    name: 80,
    nick: 40,
    role: 60,
    bio: 240,
    url: 2048
};

/* ==========================================================
   PRIMITIVE
   ========================================================== */

function add(issues, path, message) {
    issues.push({ path, message });
    return undefined;
}

function text(issues, path, value, { required = false, max = 200 } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? add(issues, path, 'obbligatorio') : undefined;
    }
    if (typeof value !== 'string') return add(issues, path, 'deve essere testo');

    const trimmed = value.trim();
    if (required && trimmed === '') return add(issues, path, 'obbligatorio');
    if (trimmed.length > max) return add(issues, path, `troppo lungo, massimo ${max} caratteri`);

    return trimmed === '' ? undefined : trimmed;
}

function oneOf(issues, path, value, allowed, { required = false } = {}) {
    if (value === undefined || value === null || value === '') {
        return required ? add(issues, path, 'obbligatorio') : undefined;
    }
    if (!allowed.includes(value)) {
        return add(issues, path, `valore non ammesso, usa uno tra: ${allowed.join(', ')}`);
    }
    return value;
}

/**
 * Solo https, con un'eccezione per l'host locale.
 *
 * L'eccezione serve allo sviluppo: con Azurite gli avatar caricati stanno su
 * http://127.0.0.1:10000, e senza questo scarto l'editor rifiuterebbe in locale
 * esattamente i dati che in produzione sono validi.
 */
function isAllowedOrigin(url) {
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

function httpsUrl(issues, path, value, { required = false } = {}) {
    const raw = text(issues, path, value, { required, max: LIMITS.url });
    if (raw === undefined) return undefined;

    let url;
    try {
        url = new URL(raw);
    } catch {
        return add(issues, path, 'non e un indirizzo valido');
    }
    if (!isAllowedOrigin(url)) return add(issues, path, 'deve iniziare con https://');

    return url.toString();
}

function integer(issues, path, value, { fallback = 0, min = 0, max = 100000 } = {}) {
    if (value === undefined || value === null || value === '') return fallback;

    const number = typeof value === 'string' ? Number(value.trim()) : value;
    if (typeof number !== 'number' || !Number.isFinite(number)) {
        return add(issues, path, 'deve essere un numero');
    }
    if (!Number.isInteger(number)) return add(issues, path, 'deve essere un numero intero');
    if (number < min || number > max) return add(issues, path, `deve stare tra ${min} e ${max}`);

    return number;
}

function flag(issues, path, value, fallback = true) {
    if (value === undefined || value === null) return fallback;
    if (typeof value !== 'boolean') return add(issues, path, 'deve essere vero o falso');
    return value;
}

/* ==========================================================
   TEAM
   ========================================================== */

function validateLink(issues, path, value) {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== 'object' || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto con tipo e indirizzo');
    }

    // Una riga lasciata completamente vuota nell'editor non e un errore:
    // significa "questo membro non ha un link".
    const empty = !value.type && !value.url;
    if (empty) return undefined;

    const type = oneOf(issues, `${path}.type`, value.type, LINK_TYPES, { required: true });
    const url = httpsUrl(issues, `${path}.url`, value.url, { required: true });

    return type && url ? { type, url } : undefined;
}

function validateMember(issues, path, value, seenIds) {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
        return add(issues, path, 'deve essere un oggetto');
    }

    const id = text(issues, `${path}.id`, value.id, { required: true, max: 49 });
    if (id !== undefined) {
        if (!ID_PATTERN.test(id)) {
            add(issues, `${path}.id`, 'ammessi solo minuscole, cifre e trattini, da 2 a 49 caratteri');
        } else if (seenIds.has(id)) {
            add(issues, `${path}.id`, `gia usato da un altro membro: ${id}`);
        } else {
            seenIds.add(id);
        }
    }

    const member = {
        id,
        name: text(issues, `${path}.name`, value.name, { required: true, max: LIMITS.name }),
        nick: text(issues, `${path}.nick`, value.nick, { max: LIMITS.nick }),
        role: text(issues, `${path}.role`, value.role, { max: LIMITS.role }),
        roleKey: oneOf(issues, `${path}.roleKey`, value.roleKey, ROLE_KEYS, { required: true }),
        bio: text(issues, `${path}.bio`, value.bio, { max: LIMITS.bio }),
        avatarUrl: httpsUrl(issues, `${path}.avatarUrl`, value.avatarUrl),
        link: validateLink(issues, `${path}.link`, value.link),
        order: integer(issues, `${path}.order`, value.order),
        active: flag(issues, `${path}.active`, value.active)
    };

    // I campi opzionali assenti si omettono invece di scriverli `undefined`:
    // JSON.stringify li toglierebbe comunque, ma cosi il confronto fra la copia
    // locale e quella del server nell'editor non inciampa su chiavi fantasma.
    for (const [key, entry] of Object.entries(member)) {
        if (entry === undefined) delete member[key];
    }
    return member;
}

/**
 * Valida il documento del team.
 *
 * `updatedAt` e `updatedBy` non si leggono dall'input: li mette il server, sono
 * traccia di chi ha salvato e non un campo modificabile dal client.
 *
 * @returns {{ok: true, value: object} | {ok: false, issues: {path: string, message: string}[]}}
 */
export function validateTeam(input) {
    const issues = [];

    if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return { ok: false, issues: [{ path: '', message: 'il documento deve essere un oggetto' }] };
    }
    if (!Array.isArray(input.members)) {
        return { ok: false, issues: [{ path: 'members', message: 'deve essere una lista di membri' }] };
    }
    if (input.members.length > MAX_MEMBERS) {
        return { ok: false, issues: [{ path: 'members', message: `troppi membri, massimo ${MAX_MEMBERS}` }] };
    }

    const seenIds = new Set();
    const members = input.members.map((member, index) =>
        validateMember(issues, `members[${index}]`, member, seenIds)
    );

    if (issues.length > 0) return { ok: false, issues };

    return { ok: true, value: { version: 1, members } };
}
