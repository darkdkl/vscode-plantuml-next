// Source navigation for inline SVG pages: cmd/ctrl-click an element to select its
// source in the editor, and highlight the element defined at the editor cursor.
// It works for elements PlantUML marks with "data-source-line", like classes,
// components, use cases and states.

const SOURCE_NAV_STYLE = `
:host-context(.source-nav) [data-source-line] { cursor: pointer; }
`;
const SOURCE_HIGHLIGHT_PADDING = 4;

let sourceHighlightLine = -1;
let sourceFollowLine = -1;
let sourceHighlightBox = undefined;

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

    sourceHighlightBox = document.createElement("div");
    sourceHighlightBox.id = "source-highlight";
    imgContainer.appendChild(sourceHighlightBox);

    window.addEventListener("message", e => {
        if (!e.data || e.data.action != "highlight") return;
        sourceHighlightLine = e.data.line;
        applySourceHighlight();
        let moved = sourceHighlightLine >= 0 && sourceHighlightLine !== sourceFollowLine;
        if (sourceHighlightLine >= 0) sourceFollowLine = sourceHighlightLine;
        if (e.data.reveal || (moved && e.data.follow)) revealSourceHighlight(e.data.reveal);
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

function applySourceHighlight() {
    if (!sourceHighlightBox) return;
    if (zoomer && zoomer.pending) return;
    let rect = sourceHighlightRect();
    if (!rect) {
        sourceHighlightBox.style.display = "none";
        return;
    }
    let container = sourceHighlightBox.parentElement.getBoundingClientRect();
    let pad = SOURCE_HIGHLIGHT_PADDING;
    sourceHighlightBox.style.left = (rect.left - container.left - pad) + "px";
    sourceHighlightBox.style.top = (rect.top - container.top - pad) + "px";
    sourceHighlightBox.style.width = (rect.right - rect.left + 2 * pad) + "px";
    sourceHighlightBox.style.height = (rect.bottom - rect.top + 2 * pad) + "px";
    sourceHighlightBox.style.display = "block";
}

function revealSourceHighlight(flash) {
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
        sourceHighlightBox.classList.remove("flash");
        void sourceHighlightBox.offsetWidth;
        sourceHighlightBox.classList.add("flash");
    }
}
