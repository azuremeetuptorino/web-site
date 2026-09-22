/**
 * Pubblicazione di un promemoria sul canale Telegram della community.
 *
 * E l'unico dei quattro social su cui si puo pubblicare davvero da qui. Le API
 * dei canali WhatsApp non esistono; LinkedIn e Instagram richiedono un'app
 * approvata, token che scadono e - per Instagram - un account Business con
 * l'immagine obbligatoria. Telegram invece chiede solo un bot creato con
 * @BotFather e promosso amministratore del canale: due minuti, nessuna review.
 *
 * DUE MODI DI PUBBLICARE. Se l'evento ha una copertina si usa `sendPhoto`, che
 * mostra l'immagine e scrive il testo come didascalia; senza copertina si usa
 * `sendMessage`, e l'anteprima del link ci mette comunque la card di Luma o
 * Meetup. La differenza non e estetica: la didascalia si ferma a 1024 caratteri
 * contro i 4096 del messaggio, ed e per questo che il limite del canale
 * dipende dall'evento (vedi reminder-channels.js).
 *
 * Il token non compare mai negli errori ne nei log: sta nella URL della
 * richiesta, che percio non viene mai riportata a chi chiama.
 */

const API_BASE = 'https://api.telegram.org';
const TIMEOUT_MS = 10_000;

/** Errore previsto: ha uno status HTTP e un codice che l'admin sa tradurre. */
export class TelegramError extends Error {
    constructor(status, code, extra = {}) {
        super(code);
        this.name = 'TelegramError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

/**
 * Le credenziali, lette al momento dell'uso.
 *
 * Non all'import, come per lo storage: i test importano il modulo senza avere
 * nessuna app setting, e la scheda dei promemoria deve funzionare in modalita
 * manuale anche su un deploy dove Telegram non e stato configurato.
 *
 * I nomi non iniziano con AZUREBLOBSTORAGE_, WEBSITE_, FUNCTIONS_ o AzureWeb:
 * sono prefissi che Static Web Apps si riserva.
 *
 * @returns {{token: string, chatId: string} | null}
 */
export function telegramConfig(env = process.env) {
    const token = env.TELEGRAM_BOT_TOKEN?.trim();
    const chatId = env.TELEGRAM_CHAT_ID?.trim();
    return token && chatId ? { token, chatId } : null;
}

/**
 * Una chiamata alla Bot API.
 *
 * Telegram risponde 200 anche quando rifiuta: l'esito vero e `ok` nel corpo.
 * Per questo non basta guardare lo status.
 */
async function call(token, method, payload, { fetchImpl, timeoutMs }) {
    let response;
    try {
        response = await fetchImpl(`${API_BASE}/bot${token}/${method}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(timeoutMs)
        });
    } catch (error) {
        if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
            throw new TelegramError(504, 'telegram-timeout');
        }
        throw new TelegramError(502, 'telegram-unreachable');
    }

    let body;
    try {
        body = await response.json();
    } catch {
        body = null;
    }

    if (response.ok && body?.ok) return body.result;

    // 401 e un token sbagliato o revocato: e un problema di configurazione del
    // deploy, non della richiesta, e va detto con parole diverse.
    if (response.status === 401) throw new TelegramError(502, 'telegram-unauthorized');

    if (response.status === 429) {
        // Telegram dice lui quanto aspettare: riproporlo e piu utile di un retry
        // automatico, che allungherebbe la richiesta e nasconderebbe il limite.
        throw new TelegramError(429, 'telegram-rate-limited', {
            retryAfter: body?.parameters?.retry_after ?? null
        });
    }

    throw new TelegramError(502, 'telegram-rejected', {
        description: body?.description ?? `HTTP ${response.status}`,
        status: response.status
    });
}

/**
 * Pubblica il promemoria sul canale.
 *
 * `parseMode` va passato solo per i testi che contengono davvero markup: i
 * template di Telegram usano <b> sul titolo, i testi riscritti dall'AI sono
 * piani e un parse_mode acceso su di loro trasformerebbe un < qualunque in un
 * errore di markup.
 *
 * IL RIPIEGO SULLA FOTO. Telegram scarica lui l'immagine dalla URL, e capita
 * che non ci riesca: le copertine di Luma sono spesso WebP dietro una CDN che
 * risponde male ai suoi bot. In quel caso risponde 400 e qui invece di dare
 * l'errore all'admin si rimanda lo stesso testo come messaggio semplice - che
 * ci sta di sicuro, visto che era stato scritto per il limite piu stretto.
 *
 * @returns {Promise<{messageId: number, method: 'sendPhoto' | 'sendMessage', fellBack: boolean}>}
 */
export async function sendReminder(
    { token, chatId, text, imageUrl, parseMode },
    { fetchImpl = fetch, timeoutMs = TIMEOUT_MS } = {}
) {
    if (!token || !chatId) throw new TelegramError(503, 'telegram-not-configured');

    const options = { fetchImpl, timeoutMs };
    const formatting = parseMode ? { parse_mode: parseMode } : {};

    if (imageUrl) {
        try {
            const result = await call(token, 'sendPhoto', {
                chat_id: chatId,
                photo: imageUrl,
                caption: text,
                ...formatting
            }, options);
            return { messageId: result?.message_id ?? null, method: 'sendPhoto', fellBack: false };
        } catch (error) {
            const imageRefused = error instanceof TelegramError
                && error.code === 'telegram-rejected'
                && error.extra.status === 400;
            if (!imageRefused) throw error;
        }
    }

    const result = await call(token, 'sendMessage', {
        chat_id: chatId,
        text,
        ...formatting
    }, options);

    return {
        messageId: result?.message_id ?? null,
        method: 'sendMessage',
        fellBack: Boolean(imageUrl)
    };
}
