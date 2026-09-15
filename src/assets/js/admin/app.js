import { apiGet, SessionExpiredError } from './api.js';
import { teamEditor } from './team-editor.js';
import { sponsorsEditor } from './sponsors-editor.js';

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
const session = await loadSession();

// Se /api/me non ha risposto non si deduce niente sui permessi: si lascia
// provare e si sta a quello che dice il server al salvataggio. Il cancello e
// la, non qui.
const canWrite = session?.isAdmin !== false;

// In parallelo: sono due chiamate indipendenti, e aspettare la prima per
// iniziare la seconda raddoppierebbe l'attesa a freddo, quando le function si
// stanno ancora svegliando.
await Promise.allSettled([
    teamEditor.init(canWrite),
    sponsorsEditor.init(canWrite)
]);

// Rete di sicurezza contro la chiusura distratta della scheda. Sta qui e non
// dentro i singoli editor: il browser ne considera comunque uno solo, e la
// domanda da porsi e "c'e qualcosa di non salvato, da qualunque parte".
window.addEventListener('beforeunload', (event) => {
    if (teamEditor.isDirty() || sponsorsEditor.isDirty()) event.preventDefault();
});
