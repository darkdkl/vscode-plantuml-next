// Source navigation for inline SVG pages: cmd/ctrl-click an element to select its
// source in the editor, and highlight the element defined at the editor cursor.
// It works for elements PlantUML marks with "data-source-line", like classes,
// components, use cases and states.

const SOURCE_NAV_STYLE = `
:host-context(.source-nav) [data-source-line] { cursor: pointer; }
.source-highlight {
    filter: drop-shadow(0 0 var(--source-glow-1) #0089c9) drop-shadow(0 0 var(--source-glow-2) #0089c9);
}
.source-highlight.flash { animation: source-highlight-flash 0.5s ease-out 2; }
.source-highlight.flash-out { animation: source-highlight-flash-out 4.2s ease-out forwards; }
@keyframes source-highlight-flash {
    50% { filter: drop-shadow(0 0 var(--source-glow-2) #0089c9) drop-shadow(0 0 var(--source-glow-3) #0089c9); }
}
@keyframes source-highlight-flash-out {
    6% { filter: drop-shadow(0 0 var(--source-glow-2) #0089c9) drop-shadow(0 0 var(--source-glow-3) #0089c9); }
    12%, 86% { filter: drop-shadow(0 0 var(--source-glow-1) #0089c9) drop-shadow(0 0 var(--source-glow-2) #0089c9); }
    100% { filter: drop-shadow(0 0 var(--source-glow-1) transparent) drop-shadow(0 0 var(--source-glow-2) transparent); }
}
`;
const SOURCE_FLASH_OUT_MS = 4200;
const SOURCE_GLOW_PIXELS = [3, 6, 12];

let sourceHighlightLine = -1;
let sourceFollowLine = -1;
let sourceFlashOutTimer = undefined;

function addSourceNavigation(vscode) {
    let imgContainer = document.getElementById("image-container");

    // Cmd on macOS, Ctrl elsewhere. On macOS ctrl-click is a right click: it
    // fires "contextmenu" instead of "click", so navigate on "mouseup".
    let isNavClick = e => (e.metaKey || e.ctrlKey) && (e.button == 0 || (e.button == 2 && e.ctrlKey));

    // inline SVGs are in a shadow root, e.target is the host
    let sourceElementOf = e => {
        if (!isNavClick(e)) return undefined;
        for (let el of e.composedPath()) {
            if (el === imgContainer) break;
            if (el instanceof SVGElement && el.hasAttribute("data-source-line")) return el;
        }
        return undefined;
    }

    // capture: stop the event before zoom, selection and links see any part of it
    imgContainer.addEventListener("mouseup", e => {
        let el = sourceElementOf(e);
        if (!el) return;
        let line = Number(el.getAttribute("data-source-line"));
        if (vscode) vscode.postMessage({ action: "revealSource", line: line });
        flashSourceElement(line);
        e.preventDefault();
        e.stopImmediatePropagation();
    }, true);
    for (let type of ["mousedown", "click", "auxclick", "contextmenu"]) {
        imgContainer.addEventListener(type, e => {
            if (!sourceElementOf(e)) return;
            e.preventDefault();
            e.stopImmediatePropagation();
        }, true);
    }

    // show elements as clickable while the modifier is down
    let setNavMode = e => imgContainer.classList.toggle("source-nav", !!e && (e.metaKey || e.ctrlKey));
    window.addEventListener("keydown", setNavMode);
    window.addEventListener("keyup", setNavMode);
    // the modifier may be pressed outside the preview
    imgContainer.addEventListener("mousemove", setNavMode);
    window.addEventListener("blur", () => setNavMode(undefined));

    window.addEventListener("message", e => {
        if (!e.data || e.data.action != "highlight") return;
        if (e.data.transient && !e.data.reveal) {
            if (sourceRectOf(e.data.line)) flashSourceElement(e.data.line);
            return;
        }
        clearTimeout(sourceFlashOutTimer);
        sourceHighlightLine = e.data.line;
        applySourceHighlight();
        if (!e.data.transient) {
            for (let el of sourceHighlightElements()) {
                if (!el.classList.contains("flash-out")) continue;
                el.classList.remove("flash-out");
                el.classList.add("flash");
            }
        }
        let moved = sourceHighlightLine >= 0 && sourceHighlightLine !== sourceFollowLine;
        if (sourceHighlightLine >= 0) sourceFollowLine = sourceHighlightLine;
        if (e.data.reveal || (moved && e.data.follow)) revealSourceHighlight(e.data.reveal, e.data.transient);
        if (e.data.transient) scheduleFlashOut();
    });
}

function scheduleFlashOut() {
    clearTimeout(sourceFlashOutTimer);
    sourceFlashOutTimer = setTimeout(() => {
        sourceHighlightLine = -1;
        applySourceHighlight();
    }, SOURCE_FLASH_OUT_MS);
}

function flashSourceElement(line) {
    clearTimeout(sourceFlashOutTimer);
    sourceHighlightLine = line;
    sourceFollowLine = line;
    applySourceHighlight();
    revealSourceHighlight(true, true);
    scheduleFlashOut();
}

// the root to find elements in, if the current page is an inline SVG
function sourceRoot() {
    return switcher && switcher.svgImage ? switcher.svgImage.shadowRoot : undefined;
}

/**
 * report the elements of the shown page to the extension, call it when the
 * page is switched or updated.
 */
function reportSourceEntities() {
    let root = sourceRoot();
    let entities = [];
    if (root) {
        for (let el of root.querySelectorAll("[data-source-line]")) {
            entities.push({
                line: Number(el.getAttribute("data-source-line")),
                name: el.getAttribute("data-qualified-name") || "",
            });
        }
    }
    // the extension sends the highlight again
    sourceHighlightLine = -1;
    applySourceHighlight();
    if (vscode) vscode.postMessage({ action: "sourceEntities", entities: entities });
}

function sourceHighlightRect() {
    return sourceRectOf(sourceHighlightLine);
}

function isRectVisible(rect) {
    return rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
}

function sourceElementsOf(line) {
    let root = sourceRoot();
    if (!root || line < 0) return [];
    return Array.from(root.querySelectorAll(`[data-source-line="${line}"]`));
}

function sourceHighlightElements() {
    return sourceElementsOf(sourceHighlightLine);
}

function sourceRectOf(line) {
    let rect = undefined;
    for (let el of sourceElementsOf(line)) {
        let r = el.getBoundingClientRect();
        if (!r.width && !r.height) continue;
        rect = rect ? {
            left: Math.min(rect.left, r.left),
            top: Math.min(rect.top, r.top),
            right: Math.max(rect.right, r.right),
            bottom: Math.max(rect.bottom, r.bottom),
        } : { left: r.left, top: r.top, right: r.right, bottom: r.bottom };
    }
    return rect;
}

function applySourceHighlight() {
    let root = sourceRoot();
    if (!root) return;
    let host = switcher.svgImage;
    let scale = host.getBoundingClientRect().width / host.naturalWidth;
    if (scale > 0 && !(zoomer && zoomer.pending)) {
        SOURCE_GLOW_PIXELS.forEach((pixels, i) => host.style.setProperty(`--source-glow-${i + 1}`, `${pixels / scale}px`));
    }
    let elements = sourceHighlightElements();
    for (let el of root.querySelectorAll(".source-highlight")) {
        if (!elements.includes(el)) el.classList.remove("source-highlight", "flash", "flash-out");
    }
    for (let el of elements) el.classList.add("source-highlight");
}

function revealSourceHighlight(flash, transient) {
    let rect = sourceHighlightRect();
    if (!rect) return;
    if (!isRectVisible(rect)) {
        window.scrollTo({
            left: window.scrollX + (rect.left + rect.right - window.innerWidth) / 2,
            top: window.scrollY + (rect.top + rect.bottom - window.innerHeight) / 2,
            behavior: "smooth",
        });
    }
    if (flash) {
        let name = transient ? "flash-out" : "flash";
        let elements = sourceHighlightElements();
        for (let el of elements) el.classList.remove("flash", "flash-out");
        if (elements.length) void elements[0].getBoundingClientRect();
        for (let el of elements) el.classList.add(name);
    }
}
