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
.source-highlight.flash-out { animation: source-highlight-flash-out 1.2s ease-out forwards; }
@keyframes source-highlight-flash {
    50% { filter: drop-shadow(0 0 var(--source-glow-2) #0089c9) drop-shadow(0 0 var(--source-glow-3) #0089c9); }
}
@keyframes source-highlight-flash-out {
    30% { filter: drop-shadow(0 0 var(--source-glow-2) #0089c9) drop-shadow(0 0 var(--source-glow-3) #0089c9); }
    100% { filter: drop-shadow(0 0 var(--source-glow-1) transparent) drop-shadow(0 0 var(--source-glow-2) transparent); }
}
`;
const SOURCE_FLASH_OUT_MS = 1200;
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
        if (vscode) vscode.postMessage({
            action: "revealSource",
            line: Number(el.getAttribute("data-source-line")),
        });
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
        clearTimeout(sourceFlashOutTimer);
        sourceHighlightLine = e.data.line;
        applySourceHighlight();
        let moved = sourceHighlightLine >= 0 && sourceHighlightLine !== sourceFollowLine;
        if (sourceHighlightLine >= 0) sourceFollowLine = sourceHighlightLine;
        if (e.data.reveal || (moved && e.data.follow)) revealSourceHighlight(e.data.reveal, e.data.transient);
        if (e.data.transient) {
            sourceFlashOutTimer = setTimeout(() => {
                sourceHighlightLine = -1;
                applySourceHighlight();
            }, SOURCE_FLASH_OUT_MS);
        }
    });
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
    let root = sourceRoot();
    if (!root || sourceHighlightLine < 0) return undefined;
    let rect = undefined;
    for (let el of root.querySelectorAll(`[data-source-line="${sourceHighlightLine}"]`)) {
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

function sourceHighlightElements() {
    let root = sourceRoot();
    if (!root || sourceHighlightLine < 0) return [];
    return Array.from(root.querySelectorAll(`[data-source-line="${sourceHighlightLine}"]`));
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
    let visible = rect.left >= 0 && rect.top >= 0 && rect.right <= window.innerWidth && rect.bottom <= window.innerHeight;
    if (!visible) {
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
