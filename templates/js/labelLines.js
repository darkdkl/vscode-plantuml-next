const LABEL_TITLE_BAND = 2;
const LABEL_DEFAULT_FONT_SIZE = 14;
const LABEL_SHAPES = "rect, polygon, path";
const LABEL_GRAPHICS = "rect, polygon, path, ellipse, circle, line, polyline, text, image";
const labelWordChar = /[\p{L}\p{N}]/u;

function markLabelTexts(root, content) {
    let svg = root.querySelector("svg");
    if (!svg) return [];
    let free = Array.from(svg.querySelectorAll("text"))
        .filter(el => !el.closest("[data-source-line]"))
        .map(el => ({ el: el, text: labelTextOf(el.textContent) }));
    let counts = new Map();
    for (let t of free) counts.set(t.text, (counts.get(t.text) || 0) + 1);
    let lineStarts = [0];
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    let labels = [];
    for (let t of free) {
        if (counts.get(t.text) > 1 || t.text.length < 2 || !/\p{L}/u.test(t.text)) continue;
        t.line = labelLineOf(content, lineStarts, t.text);
        if (t.line !== undefined) labels.push(t);
    }
    for (let t of labels) {
        t.el.setAttribute("data-source-line", t.line);
        t.el.setAttribute("data-qualified-name", t.text);
    }
    return labels;
}

function hasLabelLayout(root) {
    let svg = root.querySelector("svg");
    return !!svg && svg.isConnected && !!svg.getScreenCTM() && svg.getBoundingClientRect().width > 0;
}

function markLabelFrames(root, labels) {
    let svg = root.querySelector("svg");
    let toUser = svg.getScreenCTM().inverse();
    let flat = !svg.querySelector("[transform], svg");
    let userMatrix = el => flat ? new DOMMatrix() : toUser.multiply(el.getScreenCTM());
    let boxOf = el => {
        let b = el.getBBox();
        if (flat) return { left: b.x, top: b.y, right: b.x + b.width, bottom: b.y + b.height };
        let m = userMatrix(el);
        let points = [[b.x, b.y], [b.x + b.width, b.y], [b.x, b.y + b.height], [b.x + b.width, b.y + b.height]]
            .map(([x, y]) => new DOMPoint(x, y).matrixTransform(m));
        return {
            left: Math.min(...points.map(p => p.x)),
            top: Math.min(...points.map(p => p.y)),
            right: Math.max(...points.map(p => p.x)),
            bottom: Math.max(...points.map(p => p.y)),
        };
    };
    let labelOf = new Map(labels.map(t => [t.el, t]));
    let graphics = Array.from(svg.querySelectorAll(LABEL_GRAPHICS)).map(el => ({ el: el, box: boxOf(el), toLocal: flat ? undefined : () => userMatrix(el).inverse() }));
    for (let g of graphics) {
        let t = labelOf.get(g.el);
        if (!t) continue;
        t.x = (g.box.left + g.box.right) / 2;
        t.y = (g.box.top + g.box.bottom) / 2;
        t.size = parseFloat(g.el.getAttribute("font-size")) || LABEL_DEFAULT_FONT_SIZE;
    }
    let viewBox = svg.viewBox.baseVal;
    let canvas = viewBox && viewBox.width ? { left: viewBox.x, top: viewBox.y, right: viewBox.x + viewBox.width, bottom: viewBox.y + viewBox.height } : undefined;
    let drawn = graphics.filter(g => !(canvas && g.el.localName != "text" && boxContains(g.box, canvas)));
    let drawing = drawn.reduce((d, g) => d ? boxUnion(d, g.box) : g.box, undefined);
    let boxes = drawn.filter(g => g.el.matches(LABEL_SHAPES));
    let shapes = boxes.filter(g => !g.el.closest("[data-source-line]") && isLabelShape(g, boxes, drawing));
    shapes.sort((a, b) => boxArea(a.box) - boxArea(b.box));
    let sameBoxes = new Map();
    for (let s of shapes) {
        let key = boxKey(s.box);
        if (!sameBoxes.has(key)) sameBoxes.set(key, []);
        sameBoxes.get(key).push(s);
    }

    let owned = new Map();
    for (let t of labels) {
        let shape = smallestShapeAround(shapes, t);
        if (!shape) continue;
        if (!owned.has(shape)) owned.set(shape, []);
        owned.get(shape).push(t);
    }
    for (let [shape, owners] of owned) {
        let title = owners.reduce((a, b) => b.line < a.line ? b : a);
        if (owners.some(o => o.line !== title.line && o.y <= title.y + 2)) continue;
        if (title.y > shape.box.top + LABEL_TITLE_BAND * title.size && holdsBoxes(shape, boxes)) continue;
        for (let s of sameBoxes.get(boxKey(shape.box))) {
            s.el.setAttribute("data-source-line", title.line);
            s.el.setAttribute("data-qualified-name", title.text);
        }
    }
}

function isLabelShape(shape, boxes, drawing) {
    let el = shape.el;
    if (el.localName == "path") {
        if (getComputedStyle(el).fill == "none") return false;
        let tab = boxes.some(b => b !== shape && b.el.localName != "path" && boxContains(b.box, shape.box) &&
            Math.abs(b.box.left - shape.box.left) <= 1 && Math.abs(b.box.top - shape.box.top) <= 1);
        if (tab) return false;
    }
    return !(boxContains(shape.box, drawing) && holdsBoxes(shape, boxes));
}

function holdsBoxes(shape, boxes) {
    return boxes.some(b => b !== shape && !sameBox(b.box, shape.box) && boxContains(shape.box, b.box));
}

function smallestShapeAround(shapesByArea, text) {
    for (let s of shapesByArea) {
        let b = s.box;
        if (text.x < b.left || text.x > b.right || text.y < b.top || text.y > b.bottom) continue;
        let point = new DOMPoint(text.x, text.y);
        if (s.el.isPointInFill(s.toLocal ? point.matrixTransform(s.toLocal()) : point)) return s;
    }
    return undefined;
}

function labelTextOf(raw) {
    let text = raw.replace(/\u00a0/g, " ").trim();
    let guard = text.match(/^\[(.*)\]$/);
    return guard ? guard[1].trim() : text;
}

function labelLineOf(content, lineStarts, text) {
    let found = undefined;
    for (let i = content.indexOf(text); i >= 0; i = content.indexOf(text, i + 1)) {
        if (labelWordChar.test(content.charAt(i - 1)) || labelWordChar.test(content.charAt(i + text.length))) continue;
        let line = labelLineAt(lineStarts, i);
        if (/^\s*('|@start|@end)/.test(content.slice(lineStarts[line], lineStarts[line + 1]))) continue;
        if (found !== undefined && found !== line) return undefined;
        found = line;
    }
    return found;
}

function labelLineAt(lineStarts, offset) {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        let middle = Math.ceil((low + high) / 2);
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

function boxContains(outer, inner) {
    return outer.left <= inner.left + 1 && outer.top <= inner.top + 1 && outer.right >= inner.right - 1 && outer.bottom >= inner.bottom - 1;
}

function boxUnion(a, b) {
    return { left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) };
}

function boxKey(box) {
    return [box.left, box.top, box.right, box.bottom].map(v => v.toFixed(2)).join();
}

function sameBox(a, b) {
    return Math.abs(a.left - b.left) < 0.01 && Math.abs(a.top - b.top) < 0.01 && Math.abs(a.right - b.right) < 0.01 && Math.abs(a.bottom - b.bottom) < 0.01;
}

function boxArea(box) {
    return (box.right - box.left) * (box.bottom - box.top);
}
