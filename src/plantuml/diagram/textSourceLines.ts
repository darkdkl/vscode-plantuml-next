interface Box {
    left: number;
    top: number;
    right: number;
    bottom: number;
}

interface SvgElement {
    insertAt: number;
    marked: boolean;
    box?: Box;
    path?: boolean;
    extent?: Box;
    text?: string;
    x?: number;
    y?: number;
    size?: number;
    line?: number;
}

const tagReg = /<(\/?)([a-zA-Z]+)\b((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
const wordCharReg = /[\p{L}\p{N}]/u;
const TITLE_BAND = 2;
const DEFAULT_FONT_SIZE = 14;

export function markTextSourceLines(svg: string, content: string): string {
    let elements = parseSvg(svg);
    let texts = elements.filter(e => e.text !== undefined && !e.marked);
    let canvas = canvasOf(svg);
    let drawn = elements.filter(e => !(e.box && canvas && contains(e.box, canvas)));
    let drawing = drawingOf(drawn);
    let shapes = drawn.filter(e => e.box && !e.marked && !framesDrawing(e, drawn, drawing) && !(e.path && isTab(e, drawn)));
    let lineStarts = [0];
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    let counts = new Map<string, number>();
    for (let t of texts) counts.set(t.text, (counts.get(t.text) || 0) + 1);
    for (let t of texts) {
        if (counts.get(t.text) > 1 || t.text.length < 2 || !/\p{L}/u.test(t.text)) continue;
        t.line = onlyLineWith(content, lineStarts, t.text);
    }
    let sameBoxes = new Map<string, SvgElement[]>();
    for (let s of shapes) {
        let key = boxKey(s.box);
        if (!sameBoxes.has(key)) sameBoxes.set(key, []);
        sameBoxes.get(key).push(s);
    }
    let owned = new Map<SvgElement, SvgElement[]>();
    for (let t of texts.filter(t => t.line !== undefined)) {
        let shape = smallestShapeAround(shapes, t);
        if (!shape) continue;
        if (!owned.has(shape)) owned.set(shape, []);
        owned.get(shape).push(t);
    }
    for (let [shape, owners] of owned) {
        let title = owners.reduce((a, b) => b.line < a.line ? b : a);
        if (owners.some(o => o.line !== title.line && o.y <= title.y + 2)) continue;
        if (title.y > shape.box.top + TITLE_BAND * (title.size || DEFAULT_FONT_SIZE) && holdsShapes(shape, drawn)) continue;
        for (let s of sameBoxes.get(boxKey(shape.box))) {
            s.line = title.line;
            s.text = title.text;
        }
    }
    let parts: string[] = [];
    let last = 0;
    for (let e of elements.filter(e => !e.marked && e.line !== undefined)) {
        parts.push(svg.slice(last, e.insertAt), ` data-source-line="${e.line}" data-qualified-name="${escapeAttribute(e.text)}"`);
        last = e.insertAt;
    }
    parts.push(svg.slice(last));
    return parts.join("");
}

function parseSvg(svg: string): SvgElement[] {
    let elements: SvgElement[] = [];
    let markedDepth: boolean[] = [];
    let match: RegExpExecArray;
    tagReg.lastIndex = 0;
    while (match = tagReg.exec(svg)) {
        let [tag, closing, name, attrs, selfClosing] = match;
        if (closing) {
            markedDepth.pop();
            continue;
        }
        let marked = markedDepth.some(m => m) || /\sdata-source-line=/.test(attrs);
        let insertAt = match.index + 1 + name.length;
        if ((name == "script" || name == "style") && !selfClosing) {
            let end = svg.indexOf(`</${name}`, tagReg.lastIndex);
            if (end >= 0) tagReg.lastIndex = end;
        } else if (name == "text" && !selfClosing) {
            let end = svg.indexOf("</text>", match.index + tag.length);
            let raw = svg.slice(match.index + tag.length, end < 0 ? undefined : end).replace(/<[^>]*>/g, "");
            let x = attribute(attrs, "x") + attribute(attrs, "textLength") / 2;
            let size = attribute(attrs, "font-size");
            let y = attribute(attrs, "y") - size / 3;
            elements.push({ insertAt, marked, text: textOf(raw), x, y, size });
        } else if (name == "rect") {
            let left = attribute(attrs, "x");
            let top = attribute(attrs, "y");
            elements.push({ insertAt, marked, box: { left, top, right: left + attribute(attrs, "width"), bottom: top + attribute(attrs, "height") } });
        } else if (name == "ellipse" || name == "circle") {
            let x = attribute(attrs, "cx");
            let y = attribute(attrs, "cy");
            let rx = attribute(attrs, name == "circle" ? "r" : "rx");
            let ry = attribute(attrs, name == "circle" ? "r" : "ry");
            elements.push({ insertAt, marked, extent: { left: x - rx, top: y - ry, right: x + rx, bottom: y + ry } });
        } else if (name == "line") {
            let xs = [attribute(attrs, "x1"), attribute(attrs, "x2")];
            let ys = [attribute(attrs, "y1"), attribute(attrs, "y2")];
            elements.push({ insertAt, marked, extent: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } });
        } else if (name == "path") {
            let box = pathBox((attrs.match(/\sd="([^"]*)"/) || ["", ""])[1]);
            let filled = /\sfill="/.test(attrs) && !/\sfill="none"/.test(attrs);
            if (box && filled) elements.push({ insertAt, marked, box, path: true });
            else if (box) elements.push({ insertAt, marked, extent: box });
        } else if (name == "polygon") {
            let numbers = (attrs.match(/\spoints="([^"]*)"/) || ["", ""])[1].split(/[\s,]+/).filter(n => n).map(Number);
            let xs = numbers.filter((n, i) => i % 2 == 0);
            let ys = numbers.filter((n, i) => i % 2 == 1);
            if (xs.length) elements.push({ insertAt, marked, box: { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) } });
        }
        if (!selfClosing) markedDepth.push(marked);
    }
    return elements;
}

const pathArity: { [command: string]: number } = { M: 2, L: 2, T: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, A: 7 };

function pathBox(d: string): Box {
    let xs: number[] = [];
    let ys: number[] = [];
    let x = 0;
    let y = 0;
    for (let segment of d.match(/[MLHVCSQTAZ][^MLHVCSQTAZ]*/gi) || []) {
        let command = segment[0].toUpperCase();
        let relative = segment[0] != command;
        let arity = pathArity[command];
        let numbers = (segment.slice(1).match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) || []).map(Number);
        if (!arity) continue;
        for (let i = 0; i + arity <= numbers.length; i += arity) {
            let n = numbers.slice(i, i + arity);
            let baseX = relative ? x : 0;
            let baseY = relative ? y : 0;
            if (command == "H") x = baseX + n[0];
            else if (command == "V") y = baseY + n[0];
            else if (command == "A") {
                x = baseX + n[5];
                y = baseY + n[6];
            } else {
                for (let j = 0; j < arity - 2; j += 2) {
                    xs.push(baseX + n[j]);
                    ys.push(baseY + n[j + 1]);
                }
                x = baseX + n[arity - 2];
                y = baseY + n[arity - 1];
            }
            xs.push(x);
            ys.push(y);
        }
    }
    if (!xs.length) return undefined;
    return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}

function isTab(path: SvgElement, elements: SvgElement[]): boolean {
    return elements.some(e => e !== path && e.box && !e.path && contains(e.box, path.box) && Math.abs(e.box.left - path.box.left) <= 1 && Math.abs(e.box.top - path.box.top) <= 1);
}

function smallestShapeAround(shapes: SvgElement[], text: SvgElement): SvgElement {
    let smallest: SvgElement = undefined;
    for (let s of shapes) {
        if (!isInside(text, s.box)) continue;
        if (!smallest || area(s.box) < area(smallest.box)) smallest = s;
    }
    return smallest;
}

function canvasOf(svg: string): Box {
    let root = svg.match(/<svg\b[^>]*\sviewBox="([^"]*)"/);
    let numbers = root ? root[1].split(/[\s,]+/).map(Number) : [];
    if (numbers.length != 4 || numbers.some(isNaN)) return undefined;
    return { left: numbers[0], top: numbers[1], right: numbers[0] + numbers[2], bottom: numbers[1] + numbers[3] };
}

function drawingOf(elements: SvgElement[]): Box {
    let drawing: Box = undefined;
    for (let e of elements) {
        let box = e.box || e.extent || { left: e.x, top: e.y, right: e.x, bottom: e.y };
        drawing = drawing ? {
            left: Math.min(drawing.left, box.left),
            top: Math.min(drawing.top, box.top),
            right: Math.max(drawing.right, box.right),
            bottom: Math.max(drawing.bottom, box.bottom),
        } : { ...box };
    }
    return drawing;
}

function framesDrawing(shape: SvgElement, elements: SvgElement[], drawing: Box): boolean {
    return contains(shape.box, drawing) && holdsShapes(shape, elements);
}

function holdsShapes(shape: SvgElement, elements: SvgElement[]): boolean {
    let key = boxKey(shape.box);
    return elements.some(e => e.box && boxKey(e.box) != key && contains(shape.box, e.box));
}

function contains(outer: Box, inner: Box): boolean {
    return outer.left <= inner.left + 1 && outer.top <= inner.top + 1 && outer.right >= inner.right - 1 && outer.bottom >= inner.bottom - 1;
}

function boxKey(box: Box): string {
    return [box.left, box.top, box.right, box.bottom].join();
}

function isInside(text: SvgElement, box: Box): boolean {
    return text.x >= box.left && text.x <= box.right && text.y >= box.top && text.y <= box.bottom;
}

function area(box: Box): number {
    return (box.right - box.left) * (box.bottom - box.top);
}

const attributeRegs = new Map<string, RegExp>();

function attribute(attrs: string, name: string): number {
    if (!attributeRegs.has(name)) attributeRegs.set(name, new RegExp(`\\s${name}="([-\\d.]+)`));
    let match = attrs.match(attributeRegs.get(name));
    return match ? Number(match[1]) : 0;
}

function textOf(raw: string): string {
    let text = raw
        .replace(/&#x([0-9a-f]+);/gi, (m, hex) => String.fromCodePoint(parseInt(hex, 16)))
        .replace(/&#(\d+);/g, (m, dec) => String.fromCodePoint(Number(dec)))
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&")
        .replace(/\u00a0/g, " ")
        .trim();
    let guard = text.match(/^\[(.*)\]$/);
    return guard ? guard[1].trim() : text;
}

function onlyLineWith(content: string, lineStarts: number[], text: string): number {
    let found: number = undefined;
    for (let i = content.indexOf(text); i >= 0; i = content.indexOf(text, i + 1)) {
        if (wordCharReg.test(content.charAt(i - 1)) || wordCharReg.test(content.charAt(i + text.length))) continue;
        let line = lineAt(lineStarts, i);
        if (!isSourceLine(content.slice(lineStarts[line], lineStarts[line + 1]))) continue;
        if (found !== undefined && found !== line) return undefined;
        found = line;
    }
    return found;
}

function lineAt(lineStarts: number[], offset: number): number {
    let low = 0;
    let high = lineStarts.length - 1;
    while (low < high) {
        let middle = Math.ceil((low + high) / 2);
        if (lineStarts[middle] <= offset) low = middle;
        else high = middle - 1;
    }
    return low;
}

function isSourceLine(line: string): boolean {
    return !/^\s*('|@start|@end)/.test(line);
}

function escapeAttribute(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
