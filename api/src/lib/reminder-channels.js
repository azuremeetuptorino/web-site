/**
 * I testi dei promemoria, uno per canale social.
 *
 * Stanno nell'API e non nel frontend per un motivo di deploy: le managed
 * functions vengono pubblicate da `api/` e a runtime non vedono `src/`. Se i
 * template stessero nel browser, l'invio su Telegram - che parte dal server -
 * dovrebbe ricostruirseli, e prima o poi le due versioni divergerebbero. Qui
 * invece il testo nasce una volta sola: `/api/reminders` lo restituisce gia
 * pronto, l'admin lo legge e lo copia, la function lo spedisce.
 *
 * OGNI CANALE HA UN LIMITE DIVERSO, ed e il vero motivo per cui questo modulo
 * esiste. Telegram taglia a 1024 caratteri quando il messaggio porta una foto
 * (4096 senza), WhatsApp regge molto ma un promemoria lungo non lo legge
 * nessuno, LinkedIn si ferma a 3000, Instagram a 2200 con al massimo 30
 * hashtag. Lo stesso evento va quindi raccontato in quattro lunghezze, e quando
 * non entra si sacrifica sempre nello stesso ordine: prima la descrizione, poi
 * il titolo, mai il link di iscrizione. Un promemoria senza descrizione resta
 * utile; senza link non serve a niente.
 *
 * L'interfaccia di un canale e volutamente piccola - `limitFor`, `buildText` e
 * un `send` facoltativo - cosi il giorno in cui LinkedIn o Instagram avranno
 * credenziali utilizzabili basta aggiungere il loro `send` senza toccare ne
 * l'API ne la pagina dell'admin.
 */

import { DEFAULT_TIMEZONE } from './validate.js';

/** Quante volte si ricorda un evento, e con quale anticipo. */
export const COUNTDOWN = {
    '14d': 'Mancano due settimane!',
    '7d': 'Manca una settimana!',
    '2d': 'Ci siamo quasi: mancano due giorni!'
};

/** Sotto questa soglia la descrizione non si accorcia, si toglie: due parole monche non dicono niente. */
const MIN_EXCERPT = 40;

/** I blocchi del messaggio sono separati da una riga vuota. */
const SEPARATOR = '\n\n';

const LINKEDIN_HASHTAGS = '#AzureMeetupTorino #Azure #MicrosoftAzure #Cloud #Torino #Community #Meetup';

/**
 * Instagram ne ammette 30: dodici stanno larghi e restano leggibili. Il conteggio
 * e verificato da un test, cosi aggiungerne troppi si vede prima del deploy.
 */
const INSTAGRAM_HASHTAGS = [
    '#AzureMeetupTorino', '#Azure', '#MicrosoftAzure', '#Cloud', '#CloudComputing',
    '#DevOps', '#AI', '#Torino', '#Piemonte', '#TechCommunity', '#Meetup', '#Community'
].join(' ');

/* ==========================================================
   MISURE E TAGLI
   ========================================================== */

/**
 * I limiti dei social si contano in caratteri, non in byte: un'emoji e uno.
 * `String.length` conterebbe 📣 come due (e una coppia surrogata), e un testo
 * pieno di emoji risulterebbe piu lungo di quanto la piattaforma lo consideri.
 */
export const countChars = (value) => [...String(value ?? '')].length;

/** Taglia all'ultima parola intera e chiude con i puntini. */
function clip(value, max) {
    const chars = [...value];
    if (chars.length <= max) return value;
    if (max <= 1) return '…';

    const cut = chars.slice(0, max - 1).join('');
    const lastSpace = cut.lastIndexOf(' ');
    const base = lastSpace > max / 2 ? cut.slice(0, lastSpace) : cut;

    return `${base.replace(/[\s,;:]+$/, '')}…`;
}

/** Blocchi separati da una riga vuota. Quelli senza contenuto non lasciano il buco. */
const stack = (...values) => values.filter(Boolean).join(SEPARATOR);

/** Righe consecutive dentro lo stesso blocco. */
const lines = (...values) => values.filter(Boolean).join('\n');

const assemble = (head, excerpt, tail) => stack(head, excerpt, tail);

/**
 * Compone il messaggio e lo fa entrare nel limite del canale.
 *
 * `head` e una funzione del titolo e non una stringa: per accorciare il titolo
 * bisogna poter ricostruire l'intestazione attorno a quello nuovo, e passare un
 * testo gia montato costringerebbe a cercarci dentro il titolo con una regex.
 *
 * Le parti arrivano gia formattate per il canale: cosi si misura quello che
 * partira davvero, non un'anteprima.
 *
 * @param {{head: (title: string) => string, title: string, excerpt?: string, tail?: string}} parts
 * @returns {{text: string, length: number, limit: number, truncated: boolean, notes: string[]}}
 */
export function fit({ head, title, excerpt, tail }, limit) {
    const notes = [];
    let usedTitle = title;
    let usedExcerpt = excerpt;

    let text = assemble(head(usedTitle), usedExcerpt, tail);
    if (countChars(text) <= limit) {
        return { text, length: countChars(text), limit, truncated: false, notes };
    }

    // 1. La descrizione: e la parte che si puo perdere senza perdere l'invito.
    if (usedExcerpt) {
        const room = limit - countChars(assemble(head(usedTitle), undefined, tail)) - SEPARATOR.length;

        if (room < MIN_EXCERPT) {
            usedExcerpt = undefined;
            notes.push('Descrizione tolta: non entrava nel limite di questo canale.');
        } else {
            usedExcerpt = clip(usedExcerpt, room);
            notes.push('Descrizione accorciata per stare nel limite di questo canale.');
        }

        text = assemble(head(usedTitle), usedExcerpt, tail);
    }

    // 2. Il titolo, solo se la descrizione non e bastata.
    if (countChars(text) > limit) {
        const room = limit - countChars(assemble(head(''), usedExcerpt, tail));
        if (room > 1) {
            usedTitle = clip(usedTitle, room);
            notes.push('Titolo accorciato per stare nel limite di questo canale.');
            text = assemble(head(usedTitle), usedExcerpt, tail);
        }
    }

    // 3. Il link non si tocca mai. Se anche cosi non ci sta, lo si dice: il
    //    testo torna comunque, ma l'invio verra rifiutato prima di partire.
    if (countChars(text) > limit) {
        notes.push(`Il testo supera i ${limit} caratteri di questo canale anche dopo i tagli: accorcia il titolo dell'evento.`);
    }

    return { text, length: countChars(text), limit, truncated: true, notes };
}

/* ==========================================================
   DATI DELL'EVENTO, IN ITALIANO
   ========================================================== */

/**
 * "Giovedi 16 ottobre 2026, ore 15:00", sempre nell'ora del posto.
 *
 * Le date sul blob sono in UTC. Senza il fuso dell'evento il server scriverebbe
 * l'ora della region di Azure, che non e quella a cui presentarsi.
 */
export function formatWhen(event) {
    if (!event?.dateTime) return '';
    const date = new Date(event.dateTime);
    if (Number.isNaN(date.getTime())) return '';

    const timeZone = event.timezone || DEFAULT_TIMEZONE;
    const withZone = (options) => {
        try {
            return new Intl.DateTimeFormat('it-IT', { ...options, timeZone }).format(date);
        } catch {
            // Un fuso che questo runtime non conosce non deve far sparire la data.
            return new Intl.DateTimeFormat('it-IT', options).format(date);
        }
    };

    const day = withZone({ weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
    const time = withZone({ hour: '2-digit', minute: '2-digit' });

    return `${day.charAt(0).toUpperCase()}${day.slice(1)}, ore ${time}`;
}

/**
 * "Online", "Aula 10 dell'ITS ICT Piemonte - Torino" oppure la sola citta.
 *
 * Ricalca `formatWhere` di src/assets/js/render-events.js. E una duplicazione
 * voluta: l'API non puo importare dal frontend, e sono otto righe stabili.
 */
export function formatWhere(event) {
    if (event?.isOnline) return 'Online';

    const venue = event?.venue;
    if (!venue) return '';

    const place = venue.name ?? venue.address ?? '';
    const city = venue.city ?? '';
    const cityRepeated = city && place.toLowerCase().includes(city.toLowerCase());

    return [place, cityRepeated ? '' : city].filter(Boolean).join(' - ');
}

/**
 * TUTTI I CANALI VOGLIONO TESTO SEMPLICE, e Telegram non fa eccezione.
 *
 * La Bot API saprebbe interpretare l'HTML e il titolo potrebbe uscire in
 * grassetto, ma lo stesso testo si copia anche a mano - sempre, per tre canali
 * su quattro, e su Telegram ogni volta che il bot non e configurato - e l'app
 * di Telegram l'HTML non lo interpreta: chi incolla si ritroverebbe i tag
 * scritti nel messaggio. Un titolo in grassetto non vale un post sbagliato, e
 * cosi sparisce anche tutta la questione dell'escaping.
 */
const plain = (value) => String(value ?? '');

/**
 * I pezzi dell'evento, gia passati per la formattazione del canale.
 * Le righe che non hanno un dato dietro spariscono: meglio niente che "📍 ".
 */
function pieces(event, windowId, escape) {
    return {
        title: escape(event.title ?? 'Evento'),
        countdown: COUNTDOWN[windowId] ?? '',
        when: escape(formatWhen(event)),
        where: escape(formatWhere(event)),
        excerpt: event.excerpt ? escape(event.excerpt) : undefined,
        url: event.eventUrl ? escape(event.eventUrl) : undefined
    };
}

/** Le note che valgono per tutti i canali. */
function commonNotes(event) {
    return event.eventUrl
        ? []
        : ['Manca il link di iscrizione: aggiungilo nella scheda Eventi e rigenera il testo.'];
}

/* ==========================================================
   I CANALI
   ========================================================== */

const telegram = {
    id: 'telegram',
    label: 'Telegram',
    icon: 'bi-telegram',
    mode: 'api',

    /**
     * Con una foto il messaggio diventa una didascalia, e Telegram le concede
     * un quarto dello spazio. E la differenza che decide se la descrizione
     * dell'evento ci sta o no, quindi il limite dipende dall'evento.
     */
    limitFor: (event) => (event.imageUrl ? 1024 : 4096),

    buildText(event, windowId) {
        const { title, countdown, when, where, excerpt, url } = pieces(event, windowId, plain);

        const result = fit({
            head: (heading) => stack(
                lines(`📣 ${heading}`, countdown),
                lines(when && `📅 ${when}`, where && `📍 ${where}`)
            ),
            title,
            excerpt,
            tail: url && `👉 Iscriviti gratis: ${url}`
        }, telegram.limitFor(event));

        return { ...result, notes: [...commonNotes(event), ...result.notes] };
    }
};

const whatsapp = {
    id: 'whatsapp',
    label: 'WhatsApp',
    icon: 'bi-whatsapp',
    mode: 'manual',

    /**
     * WhatsApp regge molto di piu, ma un promemoria che riempie lo schermo in un
     * canale si salta. Mille caratteri sono il punto in cui si legge ancora tutto.
     */
    limitFor: () => 1000,

    buildText(event, windowId) {
        const { title, countdown, when, where, excerpt, url } = pieces(event, windowId, plain);

        const result = fit({
            head: (heading) => stack(
                lines(`📣 *${heading}*`, countdown),
                lines(when && `📅 ${when}`, where && `📍 ${where}`)
            ),
            title,
            excerpt,
            tail: url && `👉 Iscriviti gratis: ${url}`
        }, whatsapp.limitFor());

        return { ...result, notes: [...commonNotes(event), ...result.notes] };
    }
};

const linkedin = {
    id: 'linkedin',
    label: 'LinkedIn',
    icon: 'bi-linkedin',
    mode: 'manual',

    limitFor: () => 3000,

    buildText(event, windowId) {
        const { title, countdown, when, where, excerpt, url } = pieces(event, windowId, plain);

        const result = fit({
            head: (heading) => stack(
                [countdown, `📣 ${heading}`].filter(Boolean).join(' '),
                lines(when && `📅 ${when}`, where && `📍 ${where}`)
            ),
            title,
            excerpt,
            tail: stack(
                url && `Partecipazione gratuita, iscrizione qui 👉 ${url}`,
                LINKEDIN_HASHTAGS
            )
        }, linkedin.limitFor());

        return { ...result, notes: [...commonNotes(event), ...result.notes] };
    }
};

const instagram = {
    id: 'instagram',
    label: 'Instagram',
    icon: 'bi-instagram',
    mode: 'manual',

    limitFor: () => 2200,

    /**
     * Su Instagram i link nella didascalia non sono cliccabili: si scrive
     * comunque l'indirizzo, perche chi legge lo cerchi, e si rimanda alla bio.
     * E l'unico canale dove il post senza immagine non esiste proprio.
     */
    buildText(event, windowId) {
        const { title, countdown, when, where, excerpt, url } = pieces(event, windowId, plain);

        const result = fit({
            head: (heading) => stack(
                [countdown, `📣 ${heading}`].filter(Boolean).join(' '),
                lines(when && `📅 ${when}`, where && `📍 ${where}`)
            ),
            title,
            excerpt,
            tail: stack(
                lines('Iscrizione gratuita: link in bio 👆', url && `(${url})`),
                INSTAGRAM_HASHTAGS
            )
        }, instagram.limitFor());

        const notes = [...commonNotes(event), ...result.notes];
        notes.push(event.imageUrl
            ? 'Instagram richiede un’immagine: scaricala qui accanto e allegala al post.'
            : 'Manca l’immagine e Instagram non accetta post senza: aggiungi imageUrl nella scheda Eventi.');
        notes.push('Ricordati di aggiornare il link in bio.');

        return { ...result, notes, requiresImage: true, imageUrl: event.imageUrl ?? null };
    }
};

/** L'ordine e quello in cui le schede compaiono nell'admin. */
export const CHANNELS = [telegram, whatsapp, linkedin, instagram];

export const CHANNEL_IDS = CHANNELS.map((channel) => channel.id);

export const channelById = (id) => CHANNELS.find((channel) => channel.id === id) ?? null;

/** La parte di canale che serve al browser per disegnare le schede. */
export const channelSummaries = () =>
    CHANNELS.map(({ id, label, icon, mode }) => ({ id, label, icon, mode }));
