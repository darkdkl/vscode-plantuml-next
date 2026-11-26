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
    text?: string;
    x?: number;
    y?: number;
    line?: number;
}

const tagReg = /<(\/?)([a-zA-Z]+)\b((?:"[^"]*"|'[^']*'|[^"'>])*?)(\/?)>/g;
const wordCharReg = /[\p{L}\p{N}]/u;

export function markTextSourceLines(svg: string, content: string): string {
    let elements = parseSvg(svg);
    let allTexts = elements.filter(e => e.text !== undefined);
    let texts = allTexts.filter(e => !e.marked);
    let shapes = elements.filter(e => e.box && !e.marked);
    let lineStarts = [0];
    for (let i = content.indexOf("\n"); i >= 0; i = content.indexOf("\n", i + 1)) lineStarts.push(i + 1);
    let counts = new Map<string, number>();
    for (let t of texts) counts.set(t.text, (counts.get(t.text) || 0) + 1);
    for (let t of texts) {
        if (counts.get(t.text) > 1 || t.text.length < 2 || !/\p{L}/u.test(t.text)) continue;
        t.line = onlyLineWith(content, lineStarts, t.text);
    }
    for (let t of texts.filter(t => t.line !== undefined)) {
        let shape = smallestShapeAround(shapes, t);
        if (!shape || shape.line !== undefined) continue;
        if (allTexts.every(o => !isInside(o, shape.box) || (!o.marked && o.line === t.line))) {
            shape.line = t.line;
            shape.text = t.text;
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
            let y = attribute(attrs, "y") - attribute(attrs, "font-size") / 3;
            elements.push({ insertAt, marked, text: textOf(raw), x, y });
        } else if (name == "rect") {
            let left = attribute(attrs, "x");
            let top = attribute(attrs, "y");
            elements.push({ insertAt, marked, box: { left, top, right: left + attribute(attrs, "width"), bottom: top + attribute(attrs, "height") } });
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

function smallestShapeAround(shapes: SvgElement[], text: SvgElement): SvgElement {
    let smallest: SvgElement = undefined;
    for (let s of shapes) {
        if (!isInside(text, s.box)) continue;
        if (!smallest || area(s.box) < area(smallest.box)) smallest = s;
    }
    return smallest;
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
