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

function nameMatches(text: string, name: string): boolean {
    // generated names, like notes "GMN12" and states ".start.", can't be checked
    if (!name || name.startsWith(".") || /^GMN\d+$/.test(name)) return true;
    let shortName = name.split(/\.|::/).pop();
    return text.includes(shortName);
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
