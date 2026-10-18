// SVG pages are shown inline instead of in an <img>: the browser then paints
// only the elements in view (an <img> replays the whole SVG for every tile),
// and links work without an image map.
// The SVG lives in a shadow root, so its ids and styles don't leak into the page.

const SVG_SHADOW_STYLE = `
svg { display: block; width: 100%; height: 100%; }
a { cursor: pointer; }
`;

function isSVGSource(src) {
    return src.startsWith("data:image/svg+xml");
}

/**
 * create an inline SVG element for a data URI
 * @returns the host element, with naturalWidth / naturalHeight like an <img>,
 * or undefined if the source is not a valid SVG
 */
async function createSVGImage(src) {
    let text = await fetch(src).then(r => r.text());
    let doc = new DOMParser().parseFromString(text, "image/svg+xml");
    let svg = doc.documentElement;
    if (!svg || svg.localName != "svg" || doc.getElementsByTagName("parsererror").length) return undefined;

    let size = getSVGSize(svg);
    if (!size.width || !size.height) return undefined;
    sanitizeSVG(svg);
    // sized by the host instead
    svg.style.removeProperty("width");
    svg.style.removeProperty("height");

    let host = document.createElement("span");
    host.className = "svg-image";
    let root = host.attachShadow({ mode: "open" });
    let style = document.createElement("style");
    style.textContent = SVG_SHADOW_STYLE + SOURCE_NAV_STYLE;
    root.append(style, document.adoptNode(svg));
    host.naturalWidth = size.width;
    host.naturalHeight = size.height;
    // for copying the image
    host.imageSrc = src;
    return host;
}

function getSVGSize(svg) {
    let width = parseFloat(svg.getAttribute("width"));
    let height = parseFloat(svg.getAttribute("height"));
    if (width && height) return { width: width, height: height };
    let viewBox = (svg.getAttribute("viewBox") || "").split(/[\s,]+/).map(Number);
    return { width: viewBox[2], height: viewBox[3] };
}

// an <img> never runs scripts of the SVG, keep it that way
function sanitizeSVG(svg) {
    for (let script of Array.from(svg.getElementsByTagName("script"))) script.remove();
    for (let el of [svg, ...svg.getElementsByTagName("*")]) {
        for (let attr of Array.from(el.attributes)) {
            let name = attr.name.toLowerCase();
            let isHref = name == "href" || name.endsWith(":href");
            if (name.startsWith("on") || (isHref && /^\s*javascript:/i.test(attr.value)))
                el.removeAttribute(attr.name);
        }
    }
}
