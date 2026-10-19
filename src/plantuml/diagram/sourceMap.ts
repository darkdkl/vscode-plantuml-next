import * as vscode from 'vscode';

/**
 * An element of the rendered SVG that PlantUML marked with "data-source-line".
 */
export interface SourceEntity {
    /**
     * line in the diagram, 0 is the "@start" line
     */
    line: number;
    /**
     * "data-qualified-name" of the element
     */
    name: string;
}

interface SourceBlock {
    // line in the diagram
    line: number;
    name: string;
    // first and last document lines of the definition
    start: number;
    end: number;
}

/**
 * Maps elements of a rendered diagram to their definitions in the document,
 * and back.
 */
export class SourceMap {
    private blocks: SourceBlock[] = [];

    /**
     * @param diagramStart document line of the "@start" line
     * @param diagramEnd document line of the "@end" line
     */
    constructor(document: vscode.TextDocument, diagramStart: number, diagramEnd: number, entities: SourceEntity[]) {
        let added = new Set<number>();
        for (let entity of entities) {
            if (added.has(entity.line)) continue;
            let line = diagramStart + entity.line;
            if (line <= diagramStart || line >= diagramEnd) continue;
            // elements from included files have lines of those files, skip
            // them by checking that the line defines the element.
            if (!nameMatches(document.lineAt(line).text, entity.name)) continue;
            added.add(entity.line);
            this.blocks.push({
                line: entity.line,
                name: entity.name,
                start: line,
                end: blockEnd(document, line, diagramEnd - 1),
            });
        }
        this.blocks.sort((a, b) => a.start - b.start);
    }

    /**
     * the document range that defines the element at a diagram line
     */
    rangeOf(document: vscode.TextDocument, line: number): vscode.Range {
        let block = this.blocks.find(b => b.line == line);
        if (!block) return undefined;
        return new vscode.Range(block.start, 0, block.end, document.lineAt(block.end).text.length);
    }

    nameRangeOf(document: vscode.TextDocument, line: number): vscode.Range {
        let block = this.blocks.find(b => b.line == line);
        if (!block) return undefined;
        let text = document.lineAt(block.start).text;
        let name = shortName(block.name);
        let index = name ? text.indexOf(name) : -1;
        if (index >= 0) return new vscode.Range(block.start, index, block.start, index + name.length);
        return new vscode.Range(block.start, Math.max(text.search(/\S/), 0), block.start, text.length);
    }

    lineDeclaredAt(documentLine: number): number {
        let block = this.blocks.find(b => b.start == documentLine);
        return block ? block.line : undefined;
    }

    lineOfName(name: string): number {
        let block = this.blocks.find(b => b.name === name) ||
            this.blocks.find(b => shortName(b.name) && shortName(b.name) === shortName(name));
        return block ? block.line : undefined;
    }

    /**
     * the diagram line of the innermost element defined at a document line
     */
    lineOf(documentLine: number): number {
        let found: SourceBlock = undefined;
        for (let block of this.blocks) {
            if (block.start > documentLine) break;
            if (block.end >= documentLine) found = block;
        }
        return found ? found.line : undefined;
    }
}

function shortName(name: string): string {
    return name.split(/\.|::/).pop();
}

function nameMatches(text: string, name: string): boolean {
    // generated names, like notes "GMN12" and states ".start.", can't be checked
    if (!name || name.startsWith(".") || /^GMN\d+$/.test(name)) return true;
    return text.includes(shortName(name));
}

const noteStartReg = /^\s*(note|legend|rnote|hnote)\b[^:]*$/i;
const noteEndReg = /^\s*end\s*(note|legend|rnote|hnote)\b/i;

/**
 * the last line of a definition, which may be a "{ ... }" block, or a
 * multi-line note.
 */
function blockEnd(document: vscode.TextDocument, line: number, maxLine: number): number {
    if (noteStartReg.test(document.lineAt(line).text)) {
        for (let i = line + 1; i <= maxLine; i++) {
            if (noteEndReg.test(document.lineAt(i).text)) return i;
        }
        return line;
    }
    let depth = 0;
    for (let i = line; i <= maxLine; i++) {
        let text = document.lineAt(i).text;
        // comments and quoted texts don't count
        if (/^\s*'/.test(text)) continue;
        text = text.replace(/"[^"]*"/g, "");
        for (let c of text) {
            if (c == "{") depth++;
            else if (c == "}") depth--;
        }
        if (depth <= 0) return i;
    }
    // not closed
    return line;
}
