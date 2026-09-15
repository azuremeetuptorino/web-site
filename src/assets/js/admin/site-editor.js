import { createEditorCore } from './editor-core.js';

/**
 * Editor dei contenuti della home: foto principale, logo, "Chi siamo",
 * statistiche e footer.
 *
 * A differenza di team e sponsor qui non c'e una lista sola ma un modulo con
 * dentro tre listine. Il nucleo non fa differenza: le liste si dichiarano col
 * nome che hanno nel documento, cosi un errore su `footer.channels[0].url`
 * trova da solo la sua riga.
 *
 * TUTTI I CAMPI SONO FACOLTATIVI, per una ragione che sta nel rendering: i
 * testi attuali restano scritti nell'HTML e il sito sovrascrive solo quello che
 * riceve. La pagina funziona senza JavaScript e non si svuota se il blob tace.
 * Il rovescio, da dire a chi la usa: svuotare un campo qui non cancella il
 * testo dal sito, lo riporta a quello di partenza.
 */

const PLACEHOLDER_LOGO = '/assets/img/placeholder-logo.svg';

/** Campi semplici: il percorso nel documento e anche il nome del campo. */
const FIELDS = [
    'brand.name',
    'brand.tagline',
    'brand.logoUrl',
    'brand.heroImageUrl',
    'brand.heroImageAlt',
    'about.title',
    'about.lead',
    'about.text',
    'footer.intro',
    'footer.email',
    'footer.legal'
];

const at = (document_, path) =>
    path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), document_);

/** Costruisce { brand: { name: ... } } da { 'brand.name': ... }, saltando i vuoti. */
function nest(entries) {
    const output = {};
    for (const [path, value] of entries) {
        if (value === '') continue;
        const keys = path.split('.');
        const last = keys.pop();
        let node = output;
        for (const key of keys) node = node[key] ??= {};
        node[last] = value;
    }
    return output;
}

/** Aggiunge una lista dentro l'oggetto annidato, anche se il ramo non esiste. */
function put(target, path, value) {
    const keys = path.split('.');
    const last = keys.pop();
    let node = target;
    for (const key of keys) node = node[key] ??= {};
    node[last] = value;
}

export const siteEditor = createEditorCore({
    endpoint: '/api/site',

    ids: {
        loading: 'home-loading',
        editor: 'home-editor',
        alert: 'home-alert',
        state: 'home-state',
        save: 'home-save',
        reload: 'home-reload'
    },

    lists: {
        stats: {
            label: 'statistica',
            blank: () => ({}),
            fill(row, stat, { field }) {
                field(row, 'value').value = stat.value ?? '';
                field(row, 'label').value = stat.label ?? '';
            },
            collect(row, index, { value }) {
                return { value: value(row, 'value'), label: value(row, 'label') };
            }
        },

        'footer.channels': {
            label: 'canale',
            blank: () => ({ type: 'telegram' }),
            fill(row, channel, { field, setSelect }) {
                field(row, 'label').value = channel.label ?? '';
                field(row, 'url').value = channel.url ?? '';
                setSelect(field(row, 'type'), channel.type ?? 'telegram');
            },
            collect(row, index, { value }) {
                return {
                    type: value(row, 'type'),
                    label: value(row, 'label'),
                    url: value(row, 'url')
                };
            }
        },

        'footer.social': {
            label: 'profilo',
            blank: () => ({ type: 'linkedin' }),
            fill(row, social, { field, setSelect }) {
                field(row, 'url').value = social.url ?? '';
                setSelect(field(row, 'type'), social.type ?? 'linkedin');
            },
            collect(row, index, { value }) {
                return { type: value(row, 'type'), url: value(row, 'url') };
            }
        }
    },

    fill(data, { field, setList, form }) {
        for (const path of FIELDS) {
            field(form(), path).value = at(data, path) ?? '';
        }

        setList('stats', data.stats ?? []);
        setList('footer.channels', data.footer?.channels ?? []);
        setList('footer.social', data.footer?.social ?? []);

        refreshImages(form(), field);
    },

    collect({ value, form, readList }) {
        const document_ = nest(FIELDS.map((path) => [path, value(form(), path)]));

        document_.version = 1;
        put(document_, 'stats', readList('stats'));
        put(document_, 'footer.channels', readList('footer.channels'));
        put(document_, 'footer.social', readList('footer.social'));

        return document_;
    },

    /** Le due anteprime in cima al modulo seguono i campi mentre si scrive. */
    onEdit(_, { field, form }) {
        refreshImages(form(), field);
    },

    onUpload(_, { field, form }) {
        refreshImages(form(), field);
    }
});

function refreshImages(form, field) {
    for (const [path, fallback] of [['brand.logoUrl', PLACEHOLDER_LOGO], ['brand.heroImageUrl', '']]) {
        const thumb = form.querySelector(`[data-preview="${path}"]`);
        if (!thumb) continue;

        const wanted = field(form, path).value.trim() || fallback;
        if (!wanted) {
            thumb.hidden = true;
            continue;
        }
        thumb.hidden = false;
        if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);
    }
}
