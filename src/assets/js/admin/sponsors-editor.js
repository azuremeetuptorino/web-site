import { createEditorCore } from './editor-core.js';

/**
 * Editor degli sponsor: la forma dei dati, non la macchina.
 *
 * Il `tier` e l'unico campo che governa dimensione del logo, raggruppamento e
 * ordine delle fasce sul sito. Per questo e un <select> e non testo libero:
 * scriverci dentro "Platinum" non creerebbe una fascia nuova, creerebbe una
 * card senza stile.
 */

const PLACEHOLDER_LOGO = '/assets/img/placeholder-logo.svg';

export const sponsorsEditor = createEditorCore({
    endpoint: '/api/sponsors',

    ids: {
        loading: 'sponsor-loading',
        editor: 'sponsor-editor',
        alert: 'sponsor-alert',
        state: 'sponsor-state',
        save: 'sponsor-save',
        reload: 'sponsor-reload'
    },

    lists: {
        sponsors: {
            label: 'sponsor',
            autoSlug: true,

            /** Partner e la fascia neutra: chi crea la scheda sceglie consapevolmente. */
            blank: () => ({ tier: 'partner', active: true }),

            fill(row, sponsor, { field, setSelect }) {
                field(row, 'name').value = sponsor.name ?? '';
                field(row, 'id').value = sponsor.id ?? '';
                field(row, 'logoUrl').value = sponsor.logoUrl ?? '';
                field(row, 'logoDarkUrl').value = sponsor.logoDarkUrl ?? '';
                field(row, 'websiteUrl').value = sponsor.websiteUrl ?? '';
                field(row, 'description').value = sponsor.description ?? '';
                field(row, 'since').value = sponsor.since ?? '';
                field(row, 'active').checked = sponsor.active !== false;

                setSelect(field(row, 'tier'), sponsor.tier ?? 'partner');
            },

            collect(row, index, { value, field }) {
                return {
                    id: value(row, 'id'),
                    name: value(row, 'name'),
                    tier: value(row, 'tier'),
                    logoUrl: value(row, 'logoUrl'),
                    logoDarkUrl: value(row, 'logoDarkUrl'),
                    websiteUrl: value(row, 'websiteUrl'),
                    description: value(row, 'description'),
                    since: value(row, 'since'),
                    order: (index + 1) * 10,
                    active: field(row, 'active').checked
                };
            },

            preview(row, { field, preview, value }) {
                preview(row, 'name').textContent = value(row, 'name') || 'Nuovo sponsor';

                // L'etichetta della fascia si prende dal <select>: una mappa a
                // parte sarebbe una seconda lista da tenere allineata.
                preview(row, 'tier').textContent = field(row, 'tier').selectedOptions[0]?.text ?? '';

                const thumb = preview(row, 'logo');
                const wanted = value(row, 'logoUrl') || PLACEHOLDER_LOGO;
                if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);

                preview(row, 'hidden').hidden = field(row, 'active').checked;
            }
        }
    },

    fill(data, { setList }) {
        setList('sponsors', data.sponsors ?? []);
    },

    collect({ readList }) {
        return { version: 1, sponsors: readList('sponsors') };
    }
});
