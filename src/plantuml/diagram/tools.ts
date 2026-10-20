import * as vscode from 'vscode';
import { Diagram, diagramStartReg, diagramEndReg } from './diagram';
import { languageid } from '../common';

export function currentDiagram(): Diagram {
    let editor = vscode.window.activeTextEditor;
    if (editor) return diagramAt(editor.document, editor.selection.anchor.line);
}

export function nearestDiagram(document: vscode.TextDocument, line: number): Diagram {
    let diagram = diagramAt(document, line);
    for (let i = line - 1; !diagram && i >= 0; i--) {
        if (diagramEndReg.test(document.lineAt(i).text)) diagram = diagramAt(document, i);
    }
    for (let i = line + 1; !diagram && i < document.lineCount; i++) {
        if (diagramStartReg.test(document.lineAt(i).text)) diagram = diagramAt(document, i);
    }
    return diagram;
}

export function diagramAt(document: vscode.TextDocument, lineNumber: number): Diagram
export function diagramAt(document: vscode.TextDocument, position: vscode.Position): Diagram
export function diagramAt(document: vscode.TextDocument, para: number | vscode.Position): Diagram {
    let lineNumber = para instanceof vscode.Position ? para.line : para;
    let start: vscode.Position;
    let end: vscode.Position;
    let content: string = "";
    for (let i = lineNumber; i >= 0; i--) {
        let line = document.lineAt(i);
        if (diagramStartReg.test(line.text)) {
            start = line.range.start;
            break;
        } else if (i != lineNumber && diagramEndReg.test(line.text)) {
            return undefined;
        }
    }
    for (let i = lineNumber; i < document.lineCount; i++) {
        let line = document.lineAt(i);
        if (diagramEndReg.test(line.text)) {
            end = line.range.end
            break;
        } else if (i != lineNumber && diagramStartReg.test(line.text)) {
            return undefined;
        }
    }
    // if no diagram block found, add entire document
    if (
        !(start && end) &&
        document.getText().trim() &&
        document.languageId == languageid
    ) {
        start = document.lineAt(0).range.start;
        end = document.lineAt(document.lineCount - 1).range.end;
    }
    let diagram: Diagram = undefined;
    if (start && end) {
        content = document.getText(new vscode.Range(start, end));
        diagram = new Diagram(content, document, start, end);
    }
    return diagram;
}

export function diagramsOf(document: vscode.TextDocument): Diagram[] {
    let diagrams: Diagram[] = [];
    for (let i = 0; i < document.lineCount; i++) {
        let line = document.lineAt(i);
        if (diagramStartReg.test(line.text)) {
            let d = diagramAt(document, i);
            if (d) diagrams.push(d);
        }
    }
    // if no diagram block found, try add entire document
    if (!diagrams.length) {
        let d = diagramAt(document, 0);
        if (d) diagrams.push(d);
    }
    return diagrams;
}
