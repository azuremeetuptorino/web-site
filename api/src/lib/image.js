/**
 * Preparazione dei file caricati dall'admin (avatar e loghi sponsor).
 *
 * Il body e JSON con il contenuto in base64, non multipart: parsare multipart
 * a mano e sbagliato, e tirarsi dentro una libreria per due form e un costo di
 * cold start che non vale. In cambio base64 gonfia del 33%, ed e il motivo per
 * cui il cap sta a 512 KB di file e non di richiesta.
 *
 * TRE CONTROLLI, IN QUEST'ORDINE:
 *
 * 1. Il content-type dichiarato deve stare nell'allowlist.
 * 2. I byte devono confermarlo. Il content-type lo scrive il client, quindi da
 *    solo non dimostra niente: un eseguibile rinominato .png arriverebbe con
 *    `image/png` scritto sopra. Si guardano i magic number e si usa il tipo
 *    riconosciuto, non quello dichiarato.
 * 3. Gli SVG vengono sanificati.
 *
 * Sul punto 3 vale la pena essere onesti: la sanificazione con espressioni
 * regolari NON e una difesa completa, un SVG ostile ha molti modi di
 * nascondersi. La difesa vera e l'header `Content-Disposition: attachment` che
 * mettiamo sul blob: un `<img>` continua a renderizzare l'immagine (per le
 * sottorisorse quell'header e ignorato), ma aprire la URL del blob in una
 * scheda scarica il file invece di eseguirlo. Ed era quello il rischio: il
 * container e pubblico e raggiungibile per URL diretta.
 */

import { createHash } from 'node:crypto';

/** Estensione canonica per tipo. La `jpg` vince su `jpeg` per abitudine. */
const ALLOWED = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/svg+xml': 'svg'
};

export const ALLOWED_TYPES = Object.keys(ALLOWED);

/** 512 KB. Un avatar ragionevole sta in un decimo di questo. */
export const MAX_BYTES = 512 * 1024;

/** Dove finisce il file dentro il container pubblico. */
const FOLDERS = { avatar: 'avatars', sponsor: 'sponsors', site: 'site', event: 'events' };

export const KINDS = Object.keys(FOLDERS);

const fail = (status, body) => ({ ok: false, status, body });

/* ==========================================================
   RICONOSCIMENTO DEL CONTENUTO
   ========================================================== */

const startsWith = (buffer, bytes) =>
    buffer.length >= bytes.length && bytes.every((byte, index) => buffer[index] === byte);

/**
 * @returns {string | null} il content-type dedotto dai byte, non da chi carica.
 */
export function sniffType(buffer) {
    if (startsWith(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
    if (startsWith(buffer, [0xff, 0xd8, 0xff])) return 'image/jpeg';

    // RIFF....WEBP: la dimensione sta nei quattro byte in mezzo.
    if (startsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.length >= 12 &&
        buffer.toString('latin1', 8, 12) === 'WEBP') {
        return 'image/webp';
    }

    // L'SVG e testo: puo aprirsi con BOM, spazi, dichiarazione XML, DOCTYPE o
    // commenti prima del tag vero, quindi si cerca il tag nella prima parte.
    const head = buffer.toString('utf8', 0, Math.min(buffer.length, 2048));
    if (/<svg[\s>]/i.test(head)) return 'image/svg+xml';

    return null;
}

/* ==========================================================
   SANIFICAZIONE SVG
   ========================================================== */

const SVG_RULES = [
    // Elementi che eseguono o incorporano qualcosa.
    [/<\s*(script|foreignObject|iframe|embed|object)\b[\s\S]*?<\s*\/\s*\1\s*>/gi, ''],
    [/<\s*(script|foreignObject|iframe|embed|object)\b[^>]*\/?>/gi, ''],
    // Gestori di evento: on... = "..." | '...' | senza virgolette.
    [/\son[a-z]+\s*=\s*"[^"]*"/gi, ''],
    [/\son[a-z]+\s*=\s*'[^']*'/gi, ''],
    [/\son[a-z]+\s*=\s*(?!["'])[^\s>]+/gi, ''],
    // Riferimenti esterni: si tiene solo il rimando interno (#id).
    //
    // Le tre varianti valgono solo per la forma che nominano: l'ultima deve
    // escludere anche le virgolette, altrimenti su href="#logo" il lookahead
    // vede la virgoletta (che non e un #), la regola scatta e cancella un
    // riferimento interno legittimo, mandando in pezzi il disegno.
    [/\s(?:xlink:)?href\s*=\s*"(?!#)[^"]*"/gi, ''],
    [/\s(?:xlink:)?href\s*=\s*'(?!#)[^']*'/gi, ''],
    [/\s(?:xlink:)?href\s*=\s*(?!["'#])[^\s>]+/gi, '']
];

export function sanitizeSvg(text) {
    let output = text;
    for (const [pattern, replacement] of SVG_RULES) output = output.replace(pattern, replacement);
    return output;
}

/* ==========================================================
   NOME DEL FILE
   ========================================================== */

function slugify(text) {
    return text
        .normalize('NFD').replace(/[̀-ͯ]/g, '')
        .toLowerCase()
        .replace(/\.[a-z0-9]+$/, '')
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40);
}

/**
 * Nome leggibile piu suffisso dal contenuto.
 *
 * Il suffisso non serve a evitare collisioni fra persone diverse: serve a far
 * cambiare URL quando cambia il file. Riusando lo stesso nome, chi ha gia in
 * cache la vecchia foto continuerebbe a vederla per un anno — e la cache di un
 * anno la vogliamo, perche il contenuto di ogni URL e immutabile per
 * costruzione.
 */
export function assetName(filename, buffer, extension) {
    const base = slugify(filename ?? '') || 'immagine';
    const hash = createHash('sha256').update(buffer).digest('hex').slice(0, 8);
    return `${base}-${hash}.${extension}`;
}

/* ==========================================================
   INGRESSO
   ========================================================== */

/**
 * @returns {{ok: true, asset: object} | {ok: false, status: number, body: object}}
 */
export function prepareUpload(input) {
    if (typeof input !== 'object' || input === null) {
        return fail(400, { error: 'validation', message: 'corpo della richiesta mancante' });
    }

    const { kind, filename, contentType, dataBase64 } = input;

    if (!KINDS.includes(kind)) {
        return fail(400, { error: 'validation', message: 'kind non valido', allowed: KINDS });
    }
    if (!ALLOWED_TYPES.includes(contentType)) {
        return fail(415, { error: 'unsupported-type', allowed: ALLOWED_TYPES });
    }
    if (typeof dataBase64 !== 'string' || dataBase64 === '') {
        return fail(400, { error: 'validation', message: 'dataBase64 mancante' });
    }

    // Un base64 malformato non fa esplodere Buffer.from: restituisce i byte che
    // riesce a leggere. Si ri-codifica e si confronta per accorgersene.
    const cleaned = dataBase64.replace(/\s+/g, '');
    const buffer = Buffer.from(cleaned, 'base64');
    if (buffer.length === 0 || buffer.toString('base64').replace(/=+$/, '') !== cleaned.replace(/=+$/, '')) {
        return fail(400, { error: 'validation', message: 'dataBase64 non e base64 valido' });
    }

    if (buffer.length > MAX_BYTES) {
        return fail(413, { error: 'too-large', maxBytes: MAX_BYTES, bytes: buffer.length });
    }

    // Qui casca l'.exe rinominato .png: il tipo dichiarato passa l'allowlist,
    // i byte no.
    const actual = sniffType(buffer);
    if (!actual || actual !== contentType) {
        return fail(415, {
            error: 'unsupported-type',
            message: 'il contenuto del file non corrisponde al tipo dichiarato',
            declared: contentType,
            detected: actual,
            allowed: ALLOWED_TYPES
        });
    }

    const isSvg = actual === 'image/svg+xml';
    const body = isSvg ? Buffer.from(sanitizeSvg(buffer.toString('utf8')), 'utf8') : buffer;

    return {
        ok: true,
        asset: {
            path: `${FOLDERS[kind]}/${assetName(filename, body, ALLOWED[actual])}`,
            body,
            headers: {
                contentType: actual,
                // Il contenuto di questa URL non cambiera mai: il nome contiene
                // l'impronta dei byte.
                cacheControl: 'public, max-age=31536000, immutable',
                // Solo per gli SVG, e per un motivo di sicurezza: vedi in cima.
                contentDisposition: isSvg ? 'attachment' : undefined
            }
        }
    };
}
