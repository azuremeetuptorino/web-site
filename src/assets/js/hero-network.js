/**
 * La "rete" dietro le hero: punti che vagano e si collegano quando sono
 * vicini, e che si lasciano attirare dal puntatore.
 *
 * Costa poco solo se si ferma quando non serve: il disegno gira solo mentre
 * il canvas e nello schermo e la scheda e in primo piano. A chi chiede meno
 * movimento si disegna un fotogramma fermo, che resta una bella texture.
 *
 * @param {HTMLCanvasElement | null} canvas
 * @returns {() => void} ferma l'animazione e stacca gli ascoltatori
 */
export function initHeroNetwork(canvas) {
    const context = canvas?.getContext?.('2d');
    if (!context) return () => {};

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    const pointer = { x: -1e4, y: -1e4 };

    let width = 0;
    let height = 0;
    let points = [];
    let frame = 0;
    let onScreen = true;

    function resize() {
        const rect = canvas.getBoundingClientRect();
        const ratio = Math.min(window.devicePixelRatio || 1, 2);
        width = rect.width;
        height = rect.height;
        canvas.width = Math.round(width * ratio);
        canvas.height = Math.round(height * ratio);
        context.setTransform(ratio, 0, 0, ratio, 0, 0);

        // Uno ogni ~16.000 px²: una trentina su un telefono, una novantina su
        // un monitor. Oltre, le linee diventano una ragnatela e il costo sale
        // col quadrato.
        const count = Math.round(Math.min(90, Math.max(26, (width * height) / 16000)));
        points = Array.from({ length: count }, () => ({
            x: Math.random() * width,
            y: Math.random() * height,
            vx: (Math.random() - 0.5) * 0.35,
            vy: (Math.random() - 0.5) * 0.35,
            r: Math.random() * 1.6 + 0.6
        }));
        if (!running()) draw(false);
    }

    function draw(move) {
        context.clearRect(0, 0, width, height);
        const reach = Math.min(150, Math.max(90, width / 8));

        for (const point of points) {
            if (move) {
                point.x += point.vx;
                point.y += point.vy;
                if (point.x < 0 || point.x > width) point.vx *= -1;
                if (point.y < 0 || point.y > height) point.vy *= -1;

                const dx = pointer.x - point.x;
                const dy = pointer.y - point.y;
                const distance = Math.hypot(dx, dy);
                if (distance < 180 && distance > 1) {
                    point.x += (dx / distance) * 0.6;
                    point.y += (dy / distance) * 0.6;
                }
            }
        }

        context.lineWidth = 1;
        for (let i = 0; i < points.length; i++) {
            const a = points[i];
            for (let j = i + 1; j < points.length; j++) {
                const b = points[j];
                const distance = Math.hypot(a.x - b.x, a.y - b.y);
                if (distance < reach) {
                    context.strokeStyle = `rgba(80, 230, 255, ${(1 - distance / reach) * 0.35})`;
                    context.beginPath();
                    context.moveTo(a.x, a.y);
                    context.lineTo(b.x, b.y);
                    context.stroke();
                }
            }

            const toPointer = Math.hypot(a.x - pointer.x, a.y - pointer.y);
            if (toPointer < 200) {
                context.strokeStyle = `rgba(161, 138, 255, ${(1 - toPointer / 200) * 0.6})`;
                context.beginPath();
                context.moveTo(a.x, a.y);
                context.lineTo(pointer.x, pointer.y);
                context.stroke();
            }
        }

        context.fillStyle = 'rgba(255, 255, 255, 0.85)';
        for (const point of points) {
            context.beginPath();
            context.arc(point.x, point.y, point.r, 0, Math.PI * 2);
            context.fill();
        }
    }

    const running = () => onScreen && !document.hidden && !reducedMotion.matches;

    function loop() {
        draw(true);
        frame = requestAnimationFrame(loop);
    }

    function update() {
        cancelAnimationFrame(frame);
        frame = 0;
        if (running()) frame = requestAnimationFrame(loop);
        else draw(false);
    }

    function onPointerMove(event) {
        const rect = canvas.getBoundingClientRect();
        pointer.x = event.clientX - rect.left;
        pointer.y = event.clientY - rect.top;
    }

    function onPointerLeave() {
        pointer.x = -1e4;
        pointer.y = -1e4;
    }

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);

    const visibility = new IntersectionObserver((entries) => {
        onScreen = entries.some((entry) => entry.isIntersecting);
        update();
    });
    visibility.observe(canvas);

    window.addEventListener('pointermove', onPointerMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onPointerLeave);
    document.addEventListener('visibilitychange', update);
    reducedMotion.addEventListener('change', update);

    resize();
    update();

    return () => {
        cancelAnimationFrame(frame);
        resizeObserver.disconnect();
        visibility.disconnect();
        window.removeEventListener('pointermove', onPointerMove);
        document.documentElement.removeEventListener('pointerleave', onPointerLeave);
        document.removeEventListener('visibilitychange', update);
        reducedMotion.removeEventListener('change', update);
    };
}
