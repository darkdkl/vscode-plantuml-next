// Source navigation for inline SVG pages: cmd/ctrl-click an element to select its
// source in the editor, and highlight the element defined at the editor cursor.
// It works for elements PlantUML marks with "data-source-line", like classes,
// components, use cases and states.

const SOURCE_NAV_STYLE = `
:host-context(.source-nav) [data-source-line] { cursor: pointer; }
.source-highlight { filter: drop-shadow(0 0 2px #0089c9) drop-shadow(0 0 4px #0089c9); }
`;

let sourceHighlightLine = -1;

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
        if (e.data && e.data.action == "highlight") {
            sourceHighlightLine = e.data.line;
            applySourceHighlight();
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

function applySourceHighlight() {
    let root = sourceRoot();
    if (!root) return;
    for (let el of root.querySelectorAll(".source-highlight")) el.classList.remove("source-highlight");
    if (sourceHighlightLine < 0) return;
    for (let el of root.querySelectorAll(`[data-source-line="${sourceHighlightLine}"]`)) {
        el.classList.add("source-highlight");
    }
}
