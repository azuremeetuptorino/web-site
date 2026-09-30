/**
 * Riscrittura dei promemoria con GPT-6 Astra, ospitato su Microsoft Foundry.
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
 * La chiamata passa per la Responses API sull'endpoint /openai/v1/, che non
 * vuole api-version. Il JSON si chiede con structured outputs, ma si legge
 * comunque con prudenza: il controllo costa poco e protegge da un deployment
 * che non lo applica.
 */

import OpenAI from 'openai';

import { CHANNELS, COUNTDOWN, countChars, fit, formatWhen, formatWhere } from './reminder-channels.js';

const TIMEOUT_MS = 60_000;

/**
 * Il tetto copre ragionamento e testo insieme. Quattro promemoria stanno in
 * meno di duemila token, ma se il ragionamento si mangia il tetto la risposta
 * torna incompleta e senza testo: meglio lasciare margine.
 */
const MAX_OUTPUT_TOKENS = 16_000;

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
    return new OpenAI({
        apiKey,
        baseURL,
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

/**
 * Cosa cambia quando l'organizzatore chiede modifiche in chat.
 *
 * La regola sui dati si allarga di poco, e in un punto solo: quello che scrive
 * l'organizzatore vale quanto i dati dell'evento. E il motivo per cui la chat
 * esiste - "cita lo sponsor", "la sala e cambiata" - ma resta vietato tutto il
 * resto, compreso completare di fantasia una richiesta vaga.
 */
const CHAT_PROMPT = `${SYSTEM_PROMPT.replace(/\nRispondi soltanto[\s\S]*$/, '')}

In questa conversazione l'organizzatore ti chiede di modificare i testi. Ogni volta ti do i dati dell'evento, i quattro testi come sono adesso e la sua richiesta. Riscrivi i quattro testi applicando la richiesta e lasciando com'e quello che non tocca.

Le informazioni che l'organizzatore scrive nella richiesta valgono quanto i dati dell'evento: puoi usarle, ma riportale come le ha scritte, senza aggiungere dettagli. Tutto il resto della regola sui dati resta valido. I limiti di caratteri dei canali restano validi anche se ti chiede di allungare.

In "reply" scrivi una o due frasi rivolte all'organizzatore: cosa hai cambiato, o perche non hai potuto farlo.

Rispondi soltanto con un oggetto JSON, senza testo prima o dopo e senza blocco di codice, in questa forma:
{"reply": "...", "telegram": "...", "whatsapp": "...", "linkedin": "...", "instagram": "..."}`;

/** Lo stesso oggetto chiesto nel prompt, imposto con structured outputs. */
function formatFor(name, fields) {
    return {
        type: 'json_schema',
        name,
        strict: true,
        schema: {
            type: 'object',
            properties: Object.fromEntries(fields.map((field) => [field, { type: 'string' }])),
            required: fields,
            additionalProperties: false
        }
    };
}

const CHANNEL_FIELDS = CHANNELS.map((channel) => channel.id);
const DRAFTS_FORMAT = formatFor('promemoria', CHANNEL_FIELDS);
const CHAT_FORMAT = formatFor('promemoria_modificati', ['reply', ...CHANNEL_FIELDS]);

/** Quanti scambi precedenti si rimandano al modello: bastano a capire "ancora piu corto". */
export const CHAT_HISTORY_TURNS = 10;

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
        windowId in COUNTDOWN
            ? `Anticipo con cui si sta ricordando: ${COUNTDOWN[windowId]}`
            : 'Tipo di promemoria: libero, fuori dal calendario dei richiami. Non scrivere quanto manca all\'evento.'
    ].join('\n');
}

/** Il messaggio di un giro di chat: i dati, i testi come sono ora, la richiesta. */
export function chatPromptFor(event, windowId, current, message) {
    return [
        promptFor(event, windowId),
        '',
        'I testi come sono adesso:',
        JSON.stringify(current, null, 2),
        '',
        `Richiesta dell'organizzatore: ${message}`
    ].join('\n');
}

/* ==========================================================
   LA RISPOSTA
   ========================================================== */

/** Le parti di contenuto dei messaggi, saltando gli elementi di ragionamento. */
function contentOf(response) {
    return (response?.output ?? [])
        .filter((item) => item?.type === 'message')
        .flatMap((item) => item.content ?? []);
}

/** Il testo della risposta. */
function textOf(response) {
    return contentOf(response)
        .filter((part) => part?.type === 'output_text')
        .map((part) => part.text)
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

    if (['APIConnectionTimeoutError', 'TimeoutError', 'AbortError'].includes(error?.name)) {
        return new ComposeError(504, 'ai-timeout');
    }

    const status = error?.status;
    if (status === 401 || status === 403) return new ComposeError(502, 'ai-unauthorized');
    if (status === 429) return new ComposeError(429, 'ai-rate-limited');
    if (status === 404) return new ComposeError(502, 'ai-failed', { reason: 'deployment-not-found' });

    return new ComposeError(502, 'ai-failed');
}

/**
 * Una chiamata al modello, con i controlli che valgono per tutte.
 *
 * @returns {Promise<{drafts: Record<string, string>, model: string}>}
 */
async function requestDrafts({ client, deployment, instructions, input, format }) {
    let response;
    try {
        response = await client.responses.create({
            model: deployment,
            max_output_tokens: MAX_OUTPUT_TOKENS,
            instructions,
            input,
            // Ragionare aiuta a distribuire lo stesso contenuto su quattro
            // lunghezze diverse; "medium" basta per un testo di dieci righe.
            reasoning: { effort: 'medium' },
            text: { format },
            // I promemoria non servono a Foundry dopo la risposta.
            store: false
        });
    } catch (error) {
        throw translate(error);
    }

    // Un rifiuto arriva come risposta riuscita: senza questo controllo si
    // finirebbe a cercare il JSON dentro una spiegazione del perche no.
    if (contentOf(response).some((part) => part?.type === 'refusal')) {
        throw new ComposeError(502, 'ai-refused');
    }

    // Finito il tetto di token la risposta torna troncata, a volte vuota.
    if (response?.status === 'incomplete') {
        throw new ComposeError(502, 'ai-failed', { reason: response.incomplete_details?.reason ?? 'incomplete' });
    }

    return { drafts: parseDrafts(textOf(response)), model: response?.model ?? deployment };
}

const tidyAll = (drafts, event, windowId) => Object.fromEntries(
    CHANNELS.map((channel) => [channel.id, tidy(drafts[channel.id], channel, event, windowId)])
);

/**
 * Chiede i quattro testi in una sola chiamata.
 *
 * Una e non quattro perche il modello, vedendoli insieme, non ripete la stessa
 * frase su ogni canale; e perche costa un quarto.
 *
 * @returns {Promise<{channels: Record<string, {text: string, length: number, limit: number, truncated: boolean}>, model: string}>}
 */
export async function composeDrafts(event, windowId, { client, deployment }) {
    const { drafts, model } = await requestDrafts({
        client,
        deployment,
        instructions: SYSTEM_PROMPT,
        input: promptFor(event, windowId),
        format: DRAFTS_FORMAT
    });

    return { model, channels: tidyAll(drafts, event, windowId) };
}

/**
 * Un giro di chat: riscrive i quattro testi secondo la richiesta.
 *
 * Lo storico si rimanda come conversazione, ma i testi attuali stanno
 * nell'ultimo messaggio: possono essere stati corretti a mano fra un giro e
 * l'altro, e il modello deve partire da quelli e non da quello che ricorda.
 *
 * @param {Record<string, string>} current  i testi di adesso, per canale
 * @param {{role: 'user' | 'assistant', text: string}[]} history
 * @returns {Promise<{reply: string, channels: Record<string, {text: string, length: number, limit: number, truncated: boolean}>, model: string}>}
 */
export async function chatDrafts(event, windowId, { current, history = [], message }, { client, deployment }) {
    const previous = history
        .slice(-CHAT_HISTORY_TURNS * 2)
        .map((entry) => ({ role: entry.role === 'assistant' ? 'assistant' : 'user', content: entry.text }));

    const { drafts, model } = await requestDrafts({
        client,
        deployment,
        instructions: CHAT_PROMPT,
        input: [...previous, { role: 'user', content: chatPromptFor(event, windowId, current, message) }],
        format: CHAT_FORMAT
    });

    const reply = typeof drafts.reply === 'string' && drafts.reply.trim() !== '' ? drafts.reply.trim() : 'Testi aggiornati.';

    return { model, reply, channels: tidyAll(drafts, event, windowId) };
}
