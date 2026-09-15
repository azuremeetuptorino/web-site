import { apiGet, SessionExpiredError } from './api.js';

/* ==========================================================
   SESSIONE
   ========================================================== */
const userSlot = document.getElementById('admin-user');
const noticeSlot = document.getElementById('admin-notice');

function notice(kind, icon, html) {
    noticeSlot.className = `admin-notice admin-notice-${kind}`;
    noticeSlot.innerHTML = `<i class="bi ${icon}" aria-hidden="true"></i><div>${html}</div>`;
    noticeSlot.hidden = false;
}

async function loadSession() {
    try {
        const { payload } = await apiGet('/api/me');
        userSlot.textContent = payload.userDetails ?? payload.userId ?? 'utente';

        if (!payload.isAdmin) {
            // Le route rules non dovrebbero far arrivare fin qui un utente
            // senza ruolo: se succede, e un buco di configurazione da vedere.
            notice(
                'warn',
                'bi-exclamation-triangle',
                'Il tuo account non ha il ruolo <strong>admin</strong>. Puoi vedere questa pagina ma ogni salvataggio verra rifiutato.'
            );
        }
        return payload;
    } catch (error) {
        if (error instanceof SessionExpiredError) {
            location.reload();
            return null;
        }
        userSlot.textContent = 'sconosciuto';
        notice(
            'error',
            'bi-x-octagon',
            'Non riesco a leggere la sessione. Prova a <a href="/.auth/logout">uscire</a> e rientrare.'
        );
        console.error('[admin] /api/me fallita', error);
        return null;
    }
}

/* ==========================================================
   TAB
   ========================================================== */
const tabs = [...document.querySelectorAll('.admin-tab')];
const panels = new Map(tabs.map((tab) => [tab, document.getElementById(tab.getAttribute('aria-controls'))]));

function selectTab(target) {
    for (const tab of tabs) {
        const selected = tab === target;
        tab.setAttribute('aria-selected', String(selected));
        tab.tabIndex = selected ? 0 : -1;
        panels.get(tab).hidden = !selected;
    }
    history.replaceState(null, '', `#${target.dataset.tab}`);
}

for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab));
    tab.addEventListener('keydown', (event) => {
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
        if (!step) return;
        event.preventDefault();
        const next = tabs[(tabs.indexOf(tab) + step + tabs.length) % tabs.length];
        next.focus();
        selectTab(next);
    });
}

const fromHash = tabs.find((tab) => `#${tab.dataset.tab}` === location.hash);
selectTab(fromHash ?? tabs[0]);

/* ==========================================================
   AVVIO
   ========================================================== */
await loadSession();
