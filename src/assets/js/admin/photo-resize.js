/**
 * Ridimensionamento delle foto nel browser, prima del caricamento.
 *
 * Le foto di un evento escono dalla macchina a 6000 px e 8 MB: mandarle cosi
 * alla function vorrebbe dire alzare il limite di richiesta e pagare banda per
 * pixel che nessuno schermo mostra. Qui se ne fanno due versioni:
 *
 *  - grande, 2000 px sul lato lungo: e quella del lightbox;
 *  - miniatura, 640 px: e quella della griglia, che ne mostra decine insieme.
 *
 * WebP dove il browser lo sa scrivere, JPEG altrove (Safari fino a poco fa
 * restituiva PNG chiedendo WebP: si controlla il tipo del risultato invece di
 * fidarsi della richiesta).
 */

export const LARGE_EDGE = 2000;
export const THUMB_EDGE = 640;

function canvasFor(width, height) {
    if (typeof OffscreenCanvas !== 'undefined') return new OffscreenCanvas(width, height);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
}

function toBlob(canvas, type, quality) {
    if (canvas.convertToBlob) return canvas.convertToBlob({ type, quality });
    return new Promise((resolve, reject) => {
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('encode failed'))), type, quality);
    });
}

async function encode(bitmap, edge) {
    const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = canvasFor(width, height);
    const context = canvas.getContext('2d');
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    let blob = await toBlob(canvas, 'image/webp', 0.82);
    if (blob.type !== 'image/webp') blob = await toBlob(canvas, 'image/jpeg', 0.85);

    return { blob, width, height };
}

/**
 * @param {File} file
 * @returns {Promise<{large: {blob: Blob, width: number, height: number}, thumb: {blob: Blob, width: number, height: number}}>}
 */
export async function resizePhoto(file) {
    // `from-image` applica l'orientamento EXIF: senza, le foto fatte col
    // telefono in verticale arriverebbero coricate.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
        const large = await encode(bitmap, LARGE_EDGE);
        const thumb = await encode(bitmap, THUMB_EDGE);
        return { large, thumb };
    } finally {
        bitmap.close?.();
    }
}

export const extensionOf = (blob) => (blob.type === 'image/webp' ? 'webp' : 'jpg');
