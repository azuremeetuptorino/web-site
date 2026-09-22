/**
 * La barra dell'email che si copia con un click.
 *
 * Era dentro main.js, ma il footer c'e su ogni pagina e una barra che non
 * copia niente e peggio di una barra che non c'e. Sta qui per essere chiamata
 * da tutte e due le pagine.
 *
 * Era anche un `onclick` inline: la CSP con `script-src 'self'` lo blocca.
 */
export function initEmailCopy() {
    const bar = document.getElementById('email-copy-bar');
    if (!bar) return;

    bar.addEventListener('click', async () => {
        const email = document.getElementById('email-text')?.textContent?.trim();
        if (!email) return;

        try {
            await navigator.clipboard.writeText(email);
        } catch {
            return; // clipboard negata: si lascia la barra invariata
        }

        const originalHtml = bar.innerHTML;
        bar.innerHTML = '<i class="bi bi-check-lg copy-ok"></i> <span>Copiato negli appunti!</span>';
        setTimeout(() => { bar.innerHTML = originalHtml; }, 2000);
    });
}
