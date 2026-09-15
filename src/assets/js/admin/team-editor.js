import { createCollectionEditor } from './collection-editor.js';

/**
 * Editor del team: la forma dei dati, non la macchina.
 *
 * Tutto il comportamento (ETag, 409, riordino, upload, errori per campo) sta in
 * collection-editor.js, condiviso con gli sponsor. Qui ci sono solo i campi.
 */

const PLACEHOLDER_AVATAR = '/assets/img/placeholder-avatar.svg';

export const teamEditor = createCollectionEditor({
    endpoint: '/api/team',
    key: 'members',
    label: 'membro',

    ids: {
        loading: 'team-loading',
        editor: 'team-editor',
        list: 'team-list',
        empty: 'team-empty',
        alert: 'team-alert',
        state: 'team-state',
        save: 'team-save',
        add: 'team-add',
        reload: 'team-reload',
        template: 'member-template'
    },

    /** Un membro nuovo parte da Staff: e il gruppo meno impegnativo da correggere. */
    blank: () => ({ roleKey: 'staff', active: true }),

    fill(row, member, { field, setSelect }) {
        field(row, 'name').value = member.name ?? '';
        field(row, 'id').value = member.id ?? '';
        field(row, 'role').value = member.role ?? '';
        field(row, 'nick').value = member.nick ?? '';
        field(row, 'bio').value = member.bio ?? '';
        field(row, 'avatarUrl').value = member.avatarUrl ?? '';
        field(row, 'link.url').value = member.link?.url ?? '';
        field(row, 'active').checked = member.active !== false;

        setSelect(field(row, 'roleKey'), member.roleKey ?? 'staff');
        setSelect(field(row, 'link.type'), member.link?.type ?? '');
    },

    collect(row, { value, field }) {
        const member = {
            id: value(row, 'id'),
            name: value(row, 'name'),
            nick: value(row, 'nick'),
            role: value(row, 'role'),
            roleKey: value(row, 'roleKey'),
            bio: value(row, 'bio'),
            avatarUrl: value(row, 'avatarUrl'),
            active: field(row, 'active').checked
        };

        // Riga del link lasciata vuota = questo membro non ha un link. A meta
        // la lascia passare comunque: e il server a dire quale pezzo manca.
        const type = value(row, 'link.type');
        const url = value(row, 'link.url');
        if (type || url) member.link = { type, url };

        return member;
    },

    preview(row, { field, preview, value }) {
        preview(row, 'name').textContent = value(row, 'name') || 'Nuovo membro';
        preview(row, 'role').textContent = value(row, 'role');

        const thumb = preview(row, 'avatar');
        const wanted = value(row, 'avatarUrl') || PLACEHOLDER_AVATAR;
        if (thumb.getAttribute('src') !== wanted) thumb.setAttribute('src', wanted);

        preview(row, 'hidden').hidden = field(row, 'active').checked;
    }
});
