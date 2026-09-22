/**
 * Riscrittura dei promemoria con Claude, ospitato su Microsoft Foundry.
 *
 * E facoltativa, e lo resta: i template di reminder-channels.js bastano, non
 * costano niente e non possono sbagliare. Questa e la scorciatoia per quando
 * l'evento merita un testo scritto meglio del riempimento di uno stampo, o
 * semplicemente diverso dall'ultimo promemoria uscito.
 *
 * TRE PRECAUZIONI, perche il testo finisce su un canale pubblico a nome della
 * community:
 *  - il prompt vieta di aggiungere qualunque cosa non sia nei dati dell'evento.
 *    Un relatore inventato o un orario sbagliato su LinkedIn non si corregge
 *    con una modifica, si corregge con una scusa;
 *  - quello che torna passa comunque per `fit`, che lo riporta dentro il limite
 *    del canale. Il modello sa contare i caratteri solo all'incirca, e Telegram
 *    non tratta;
 *  - il risultato non viene pubblicato: diventa una bozza che l'admin legge,
 *    corregge se serve, e solo dopo manda.
 *
 * Su Foundry il modello si chiama con il NOME DEL DEPLOYMENT, non con l'id del
 * modello: sono spesso uguali, ma chi ha creato la risorsa puo averlo cambiato.
 * Structured outputs e ancora in preview qui, quindi il JSON si chiede nel
 * prompt e si legge con prudenza, invece di dipendere da output_config.format.
 */

import AnthropicFoundry from '@anthropic-ai/foundry-sdk';

import { CHANNELS, COUNTDOWN, countChars, fit, formatWhen, formatWhere } from './reminder-channels.js';

const TIMEOUT_MS = 60_000;
const MAX_TOKENS = 4000;

/** La versione dell'API Anthropic parlata da Foundry, come da documentazione Microsoft. */
const API_VERSION = '2023-06-01';

/** Errore previsto: status HTTP e codice che l'admin sa tradurre. */
export class ComposeError extends Error {
    constructor(status, code, extra = {}) {
        super(code);
        this.name = 'ComposeError';
        this.status = status;
        this.code = code;
        this.extra = extra;
    }
}

/**
 * Le impostazioni, lette al momento dell'uso e non all'import.
 *
 * Servono tutte e tre: senza, la scheda non mostra nemmeno il pulsante. I nomi
 * evitano i prefissi che Static Web Apps si riserva (AZUREBLOBSTORAGE_,
 * WEBSITE_, FUNCTIONS_, AzureWeb).
 *
 * @returns {{baseURL: string, apiKey: string, deployment: string} | null}
 */
export function aiConfig(env = process.env) {
    const baseURL = env.FOUNDRY_BASE_URL?.trim();
    const apiKey = env.FOUNDRY_API_KEY?.trim();
    const deployment = env.FOUNDRY_DEPLOYMENT?.trim();

    return baseURL && apiKey && deployment ? { baseURL, apiKey, deployment } : null;
}

/** Il client di Foundry. Costruito su richiesta: senza impostazioni non deve esistere. */
export function createClient({ baseURL, apiKey }, { timeoutMs = TIMEOUT_MS } = {}) {
    return new AnthropicFoundry({
        apiKey,
        baseURL,
        apiVersion: API_VERSION,
        timeout: timeoutMs,
        // Un solo tentativo in piu: oltre, la richiesta dell'admin scade prima.
        maxRetries: 1
    });
}

/* ==========================================================
   IL PROMPT
   ========================================================== */

const SYSTEM_PROMPT = `Scrivi i promemoria social di Azure Meetup Torino, una community tecnica di Torino che organizza incontri gratuiti su Azure, cloud, DevOps e AI.

Ti do i dati di un evento gia in programma e la distanza da cui si sta ricordando. Scrivi quattro versioni dello stesso promemoria, una per canale.

REGOLA PIU IMPORTANTE: usa solo i dati che ti do. Non inventare relatori, sponsor, argomenti delle sessioni, orari, prezzi, posti limitati o scadenze. Se un dato non c'e, non nominarlo. Riporta l'indirizzo web esattamente come te lo do, senza accorciarlo e senza cambiarlo.

Tono: diretto e cordiale, come un organizzatore che scrive alla sua community. Niente superlativi da comunicato stampa, niente "imperdibile", niente "non potete mancare". Dai del voi. Scrivi in italiano.

I quattro canali, con i loro vincoli:
- "telegram": breve, massimo 800 caratteri. Testo semplice, senza HTML e senza markdown. Qualche emoji dove aiuta a leggere. Chiudi con il link di iscrizione.
- "whatsapp": ancora piu breve, massimo 700 caratteri. Testo semplice. Per il grassetto si usano gli asterischi, come *cosi*, e solo sul titolo dell'evento. Chiudi con il link.
- "linkedin": piu disteso e professionale, massimo 2500 caratteri. Racconta in due o tre righe perche vale la pena esserci, restando sui dati che ti ho dato. Niente markdown. Chiudi con il link e poi una riga di hashtag pertinenti, da cinque a otto, sempre incluso #AzureMeetupTorino.
- "instagram": massimo 1800 caratteri, tono piu informale. Su Instagram i link non sono cliccabili: scrivi comunque l'indirizzo e aggiungi che il link e in bio. Chiudi con una riga di hashtag, da dieci a quindici, sempre incluso #AzureMeetupTorino.

Rispondi soltanto con un oggetto JSON, senza testo prima o dopo e senza blocco di codice, in questa forma:
{"telegram": "...", "whatsapp": "...", "linkedin": "...", "instagram": "..."}`;

/** I dati dell'evento come li legge il modello: etichettati, senza JSON da interpretare. */
export function promptFor(event, windowId) {
    const where = formatWhere(event);

    return [
        `Titolo: ${event.title ?? ''}`,
        `Quando: ${formatWhen(event)}`,
        where ? `Dove: ${where}` : 'Dove: non indicato',
        event.isOnline ? 'Modalita: evento online' : 'Modalita: evento in presenza',
        event.excerpt ? `Descrizione: ${event.excerpt}` : 'Descrizione: non disponibile',
        event.eventUrl ? `Link di iscrizione: ${event.eventUrl}` : 'Link di iscrizione: non disponibile, non inventarlo e non scrivere inviti a iscriversi',
        '',
        `Anticipo con cui si sta ricordando: ${COUNTDOWN[windowId] ?? windowId}`
    ].join('\n');
}

/* ==========================================================
   LA RISPOSTA
   ========================================================== */

/** Il testo della risposta, saltando i blocchi di ragionamento. */
function textOf(message) {
    return (message?.content ?? [])
        .filter((block) => block?.type === 'text')
        .map((block) => block.text)
        .join('')
        .trim();
}

/**
 * Legge il JSON anche se e arrivato vestito.
 *
 * Senza structured outputs il modello puo incartare la risposta in un blocco di
 * codice o premettere una riga di cortesia. Rifiutare per quello sarebbe
 * pedante: si cerca l'oggetto e si legge quello.
 */
export function parseDrafts(raw) {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start === -1 || end <= start) throw new ComposeError(502, 'ai-bad-output');

    let parsed;
    try {
        parsed = JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        throw new ComposeError(502, 'ai-bad-output');
    }

    const missing = CHANNELS
        .map((channel) => channel.id)
        .filter((id) => typeof parsed[id] !== 'string' || parsed[id].trim() === '');
    if (missing.length > 0) throw new ComposeError(502, 'ai-bad-output', { missing });

    return parsed;
}

/**
 * Rimette il testo dentro le regole del canale.
 *
 * Due correzioni, entrambe su cose che il modello sbaglia in modo prevedibile:
 * il conteggio dei caratteri, che stima a occhio, e il link, che ogni tanto
 * dimentica. Il link si riaggiunge invece di rifiutare il testo: e l'unica
 * parte del promemoria che non si puo perdere.
 */
export function tidy(text, channel, event, windowId) {
    let cleaned = String(text).trim();

    if (event.eventUrl && !cleaned.includes(event.eventUrl)) {
        cleaned = `${cleaned}\n\n${event.eventUrl}`;
    }

    const limit = channel.limitFor(event);
    if (countChars(cleaned) <= limit) return { text: cleaned, length: countChars(cleaned), limit, truncated: false };

    // Si taglia con lo stesso criterio dei template: il corpo cede, il link no.
    const tail = event.eventUrl && cleaned.endsWith(event.eventUrl) ? event.eventUrl : undefined;
    const body = tail ? cleaned.slice(0, cleaned.length - tail.length).trim() : cleaned;
    const result = fit({ head: () => '', title: '', excerpt: body, tail }, limit);

    return { text: result.text.trim(), length: countChars(result.text.trim()), limit, truncated: true };
}

/* ==========================================================
   LA CHIAMATA
   ========================================================== */

/** Traduce l'errore dell'SDK senza mai riportare la chiave o la URL della risorsa. */
function translate(error) {
    if (error instanceof ComposeError) return error;

    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        return new ComposeError(504, 'ai-timeout');
    }

    const status = error?.status;
    if (status === 401 || status === 403) return new ComposeError(502, 'ai-unauthorized');
    if (status === 429) return new ComposeError(429, 'ai-rate-limited');
    if (status === 404) return new ComposeError(502, 'ai-failed', { reason: 'deployment-not-found' });

    return new ComposeError(502, 'ai-failed');
}

/**
 * Chiede i quattro testi in una sola chiamata.
 *
 * Una e non quattro perche il modello, vedendoli insieme, non ripete la stessa
 * frase su ogni canale; e perche costa un quarto.
 *
 * @returns {Promise<{channels: Record<string, {text: string, length: number, limit: number, truncated: boolean}>, model: string}>}
 */
export async function composeDrafts(event, windowId, { client, deployment }) {
    let message;
    try {
        message = await client.messages.create({
            model: deployment,
            max_tokens: MAX_TOKENS,
            system: SYSTEM_PROMPT,
            messages: [{ role: 'user', content: promptFor(event, windowId) }],
            // Pensare aiuta a distribuire lo stesso contenuto su quattro
            // lunghezze diverse; "medium" basta per un testo di dieci righe.
            thinking: { type: 'adaptive' },
            output_config: { effort: 'medium' }
        });
    } catch (error) {
        throw translate(error);
    }

    // Un rifiuto arriva come risposta riuscita: senza questo controllo si
    // finirebbe a cercare il JSON dentro una spiegazione del perche no.
    if (message?.stop_reason === 'refusal') {
        throw new ComposeError(502, 'ai-refused', { category: message.stop_details?.category ?? null });
    }

    const drafts = parseDrafts(textOf(message));

    return {
        model: message?.model ?? deployment,
        channels: Object.fromEntries(
            CHANNELS.map((channel) => [channel.id, tidy(drafts[channel.id], channel, event, windowId)])
        )
    };
}
