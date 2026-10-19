import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as child_process from 'child_process';

import { RenderTask } from '../plantuml/renders/interfaces'
import { Diagram } from '../plantuml/diagram/diagram';
import { diagramsOf, currentDiagram, diagramAt } from '../plantuml/diagram/tools';
import { SourceMap, SourceEntity } from '../plantuml/diagram/sourceMap';
import { config } from '../plantuml/config';
import { localize, extensionPath, languageid } from '../plantuml/common';
import { parseError, calculateExportPath, addFileIndex, showMessagePanel, fileToBase64 } from '../plantuml/tools';
import { exportToBuffer } from "../plantuml/exporter/exportToBuffer";
import { UI } from '../ui/ui';
import { warmProcesses } from '../plantuml/renders/warmProcess';

enum previewStatus {
    default,
    error,
    processing,
}
class Previewer extends vscode.Disposable {

    private _uiPreview: UI;
    private _disposables: vscode.Disposable[] = [];
    private watchDisposables: vscode.Disposable[] = [];
    private status: previewStatus;
    private previewPageStatus: string;
    private rendered: Diagram;
    private task: RenderTask;
    private taskKilling: boolean;

    private images: string[];
    private imageError: string;
    private error: string = "";
    private zoomUpperLimit: boolean = false;

    // the page is loaded once, and then updated by "render" messages
    private pageReady: boolean = false;
    private pageSettings: string = "";
    private lastRender: any = undefined;
    private resetPageStatus: boolean = false;

    // source navigation: the displayed diagram, by its document and index
    // since its position changes with edits, and the elements of the shown page.
    private displayed: { document: vscode.TextDocument, index: number } = undefined;
    private sourceEntities: SourceEntity[] = [];
    private sourceMap: { key: string, map: SourceMap } = undefined;
    private highlighted: number = undefined;
    private pendingReveal: boolean = false;
    private pendingDefinition: { uri: string, position: vscode.Position, time: number } = undefined;

    constructor() {
        super(() => this.dispose());
        this.register();
    }

    dispose() {
        this._disposables && this._disposables.length && this._disposables.map(d => d.dispose());
        this.watchDisposables && this.watchDisposables.length && this.watchDisposables.map(d => d.dispose());
    }

    reset() {
        this.rendered = null;
        this.previewPageStatus = "";
        this.images = [];
        this.imageError = "";
        this.error = "";
        this.resetPageStatus = true;
    }

    updateWebView(): string {
        let render = {
            action: "render",
            pages: <{ src: string, map?: string }[]>[],
            error: "",
            imageError: "",
            showSpinner: this.status === previewStatus.processing,
            status: <string>undefined,
        };
        try {
            switch (this.status) {
                case previewStatus.default:
                case previewStatus.error:
                    render.pages = this.pagesOf(this.images);
                    render.imageError = this.imageError;
                    render.error = this.error;
                    break;
                case previewStatus.processing:
                    for (let format of ["svg", "png"]) {
                        let exported = calculateExportPath(this.rendered, format);
                        exported = addFileIndex(exported, 0, this.rendered.pageCount);
                        if (!fs.existsSync(exported)) continue;
                        render.pages = [{ src: fileToBase64(exported) }];
                        break;
                    }
                    break;
                default:
                    return;
            }
            this.postRender(render);
        } catch (error) {
            return error
        }
    }
    private pagesOf(images: string[]): { src: string, map?: string }[] {
        // images are in order of [image1, ..., imageN, map1, ..., mapN]
        let pages: { src: string, map?: string }[] = [];
        let maps: string[] = [];
        for (let c of images) {
            if (c.startsWith('data:image/'))
                pages.push({ src: c });
            else
                maps.push(c.replaceAll('<area ', '<area target="_blank" '));
        }
        pages.forEach((p, i) => p.map = maps[i]);
        return pages;
    }
    private postRender(render: any) {
        this.lastRender = render;
        let settings = JSON.stringify({
            zoomUpperLimit: this.zoomUpperLimit,
            showSnapIndicators: config.previewSnapIndicators,
            swapMouseButtons: config.previewSwapMouseButtons,
        });
        let env = {
            localize: localize,
            status: this.previewPageStatus,
            settings: settings,
        };
        let loaded = this._uiPreview.open("preview.html", env);
        if (!loaded && settings !== this.pageSettings) {
            // settings are read by the page on load only
            this._uiPreview.update("preview.html", env);
            loaded = true;
        }
        if (loaded) {
            // the render is sent once the page is ready
            this.pageReady = false;
            this.pageSettings = settings;
            this.resetPageStatus = false;
            return;
        }
        if (this.pageReady) this.sendRender(false);
    }
    private sendRender(pageLoaded: boolean) {
        if (!this.lastRender) return;
        let render = { ...this.lastRender };
        if (pageLoaded)
            // the page may be reloaded, restore its status
            render.status = this.previewPageStatus;
        else if (this.resetPageStatus)
            render.status = "";
        this.resetPageStatus = false;
        this._uiPreview.postMessage(render);
    }

    setUIStatus(status: string) {
        this.previewPageStatus = status;
    }
    async update(processingTip: boolean) {
        if (this.taskKilling) return;
        await this.killTasks();
        // console.log("updating...");
        // do not await doUpdate, so that preview window could open before update task finish.
        this.doUpdate(processingTip).catch(e => showMessagePanel(e));
    }
    private killTasks() {
        if (!this.task) return;
        this.task.canceled = true;

        if (!this.task.processes || !this.task.processes.length)
            return Promise.resolve(true);
        this.taskKilling = true;
        return Promise.all(
            this.task.processes.map(p => this.killTask(p))
        ).then(() => {
            this.task = null;
            this.taskKilling = false;
        });
    }
    private killTask(process: child_process.ChildProcess) {
        return new Promise((resolve, reject) => {
            process.on('exit', (code, sig) => {
                // console.log(`Killed ${process.pid} with code ${code} and signal ${sig}!`);
                resolve(true);
            });
            
            if(!process.kill('SIGINT') && process.exitCode != null){
                // console.log(`Process ${process.pid} exited with status code ${process.exitCode}`);
                resolve(true);
            }
        })
    }
    get TargetChanged(): boolean {
        let current = currentDiagram();
        if (!current) return false;
        let changed = (!this.rendered || !this.rendered.isEqual(current));
        if (changed) {
            this.rendered = current;
            this.error = "";
            this.images = [];
            this.imageError = "";
            this.previewPageStatus = "";
            this.resetPageStatus = true;
        }
        return changed;
    }
    private async doUpdate(processingTip: boolean) {
        let diagram = currentDiagram();
        if (!diagram) {
            this.status = previewStatus.error;
            this.error = localize(3, null);
            this.images = [];
            this.updateWebView();
            return;
        }
        // the document may change while rendering
        let source = { document: diagram.document, index: diagram.index };
        // the preview shows SVG inline with its own links, so no image map is
        // needed, which saves a second render (and JVM) per page.
        let task: RenderTask = exportToBuffer(diagram, "svg", undefined, false);
        this.task = task;

        // console.log(`start pid ${this.task.processes.reduce((p, c) => p + " " + c.pid, "")}!`);
        if (processingTip) this.processing();
        await task.promise.then(
            result => {
                if (task.canceled) return;
                this.task = null;
                this.status = previewStatus.default;
                this.displayed = source;

                this.error = "";
                this.imageError = "";
                this.images = result.reduce((p, buf) => {
                    let sigPNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
                    let isPNG = buf.slice(0, sigPNG.length).equals(sigPNG);
                    let isSVG = (buf.slice(0, 256).indexOf('<svg') >= 0);

                    if (isPNG || isSVG) {
                        let b64 = buf.toString('base64');
                        if (!b64) return p;

                        // push image
                        p.push(`data:image/${isPNG ? 'png' : "svg+xml"};base64,${b64}`);
                    } else {
                        // push image map
                        let imageMap = '<map></map>';
                        if (buf.toString().trim().length > 0)
                            imageMap = buf.toString()

                        p.push(imageMap);
                    }
                    return p;
                }, <string[]>[]);
                this.updateWebView();
            },
            error => {
                if (task.canceled) return;
                this.task = null;
                this.status = previewStatus.error;
                let err = parseError(error)[0];
                this.error = err.error;
                let b64 = err.out.toString('base64');
                if (!(b64 || err.error)) return;
                this.imageError = `data:image/svg+xml;base64,${b64}`
                this.updateWebView();
            }
        );
    }
    //display processing tip
    processing() {
        this.status = previewStatus.processing;
        this.updateWebView();
    }
    register() {
        let disposable: vscode.Disposable;

        //register command
        disposable = vscode.languages.registerDefinitionProvider({ language: languageid }, {
            provideDefinition: (document, position) => this.definitionAt(document, position),
        });
        this._disposables.push(disposable);

        disposable = vscode.commands.registerCommand('plantuml.revealInPreview', () => {
            this.revealInPreview().catch(e => showMessagePanel(e));
        });
        this._disposables.push(disposable);

        disposable = vscode.commands.registerCommand('plantuml.toggleHighlightCursor', () => {
            this.toggleSetting("previewHighlightCursor").catch(e => showMessagePanel(e));
        });
        this._disposables.push(disposable);

        disposable = vscode.commands.registerCommand('plantuml.toggleFollowCursor', () => {
            this.toggleSetting("previewFollowCursor").catch(e => showMessagePanel(e));
        });
        this._disposables.push(disposable);

        disposable = vscode.workspace.onDidChangeConfiguration(e => {
            if (!e.affectsConfiguration("plantuml.previewHighlightCursor") && !e.affectsConfiguration("plantuml.previewFollowCursor")) return;
            this.highlighted = null;
            this.syncHighlight();
        });
        this._disposables.push(disposable);

        disposable = vscode.commands.registerCommand('plantuml.preview', async () => {
            try {
                var editor = vscode.window.activeTextEditor;
                if (!editor) return;
                let diagrams = diagramsOf(editor.document);
                if (!diagrams.length) return;

                //reset in case that starting commnad in none-diagram area, 
                //or it may show last error image and may cause wrong "TargetChanged" result on cursor move.
                this.reset();
                this.TargetChanged;
                //update preview
                await this.update(true);
            } catch (error) {
                showMessagePanel(error);
            }
        });
        this._disposables.push(disposable);

        this._uiPreview = new UI(
            "plantuml.preview",
            localize(17, null),
            path.join(extensionPath, "templates"),
        );
        this._disposables.push(this._uiPreview);

        this._uiPreview.addEventListener("message", e => {
            if (e.message.action == "openExternalLink") {
                vscode.env.openExternal(e.message.href);
            } else if (e.message.action == "ready") {
                this.pageReady = true;
                this.highlighted = undefined;
                this.sendRender(true);
            } else if (e.message.action == "revealSource") {
                this.revealSource(e.message.line).catch(e => showMessagePanel(e));
            } else if (e.message.action == "sourceEntities") {
                // the page is switched or updated, and has no highlight
                this.sourceEntities = e.message.entities || [];
                this.sourceMap = undefined;
                this.highlighted = undefined;
                this.syncHighlight(this.pendingReveal);
                this.pendingReveal = false;
            } else {
                this.setUIStatus(JSON.stringify(e.message));
            }
        });
        this._uiPreview.addEventListener("open", () => this.startWatch());
        this._uiPreview.addEventListener("close", () => {
            this.stopWatch();
            this.killTasks();
            this.pageReady = false;
            // PlantUML processes are kept for the preview only
            warmProcesses.dispose();
        });
    }
    startWatch() {
        let disposable: vscode.Disposable;
        let disposables: vscode.Disposable[] = [];

        //register watcher
        let lastTimestamp = new Date().getTime();
        disposable = vscode.workspace.onDidChangeTextDocument(e => {
            if (!config.previewAutoUpdate) return;
            if (!e || !e.document || !e.document.uri) return;
            if (e.document.uri.scheme == "plantuml") return;
            lastTimestamp = new Date().getTime();
            setTimeout(() => {
                if (new Date().getTime() - lastTimestamp >= 400) {
                    if (!currentDiagram()) return;
                    this.update(false);
                }
            }, 500);
        });
        disposables.push(disposable);
        disposable = vscode.window.onDidChangeTextEditorSelection(e => {
            this.syncHighlight();
            this.revealOnDefinition(e);
            if (!config.previewAutoUpdate) return;
            lastTimestamp = new Date().getTime();
            setTimeout(() => {
                if (new Date().getTime() - lastTimestamp >= 400) {
                    if (!this.TargetChanged) return;
                    this.update(true);
                }
            }, 500);
        });
        disposables.push(disposable);

        this.watchDisposables = disposables;
    }
    private displayedDiagram(): Diagram {
        if (!this.displayed) return undefined;
        return diagramsOf(this.displayed.document)[this.displayed.index];
    }
    private sourceMapOf(diagram: Diagram): SourceMap {
        let key = [diagram.document.uri.toString(), diagram.document.version, diagram.start.line].join(":");
        if (!this.sourceMap || this.sourceMap.key !== key) {
            this.sourceMap = {
                key: key,
                map: new SourceMap(diagram.document, diagram.start.line, diagram.end.line, this.sourceEntities),
            };
        }
        return this.sourceMap.map;
    }
    // select the source of a diagram element, which is ctrl-clicked in the preview
    private async revealSource(line: number) {
        let diagram = this.displayedDiagram();
        if (!diagram) return;
        let range = this.sourceMapOf(diagram).rangeOf(diagram.document, line);
        if (!range) return;
        let visible = vscode.window.visibleTextEditors.find(e => e.document === diagram.document);
        let editor = await vscode.window.showTextDocument(diagram.document, {
            viewColumn: visible ? visible.viewColumn : vscode.ViewColumn.One,
            selection: new vscode.Selection(range.start, range.end),
        });
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    }
    // highlight the diagram element defined at the cursor
    private syncHighlight(reveal: boolean = false) {
        if (!this.pageReady || !this.displayed) return;
        let line = this.lineAtCursor();
        if (reveal && line === undefined)
            vscode.window.showInformationMessage("PlantUML: there is no element of the diagram at the cursor to show in the preview.");
        let persistent = config.previewHighlightCursor;
        let shown = persistent ? line : undefined;
        if (!reveal && shown === this.highlighted) return;
        this.highlighted = shown;
        let target = reveal ? line : shown;
        this._uiPreview.postMessage({
            action: "highlight",
            line: target === undefined ? -1 : target,
            reveal: reveal,
            transient: reveal && !persistent,
            follow: persistent && config.previewFollowCursor,
        });
    }
    private async toggleSetting(key: string) {
        let settings = vscode.workspace.getConfiguration("plantuml");
        await settings.update(key, !settings.get<boolean>(key), vscode.ConfigurationTarget.Global);
    }
    private lineAtCursor(): number {
        let document = this.displayed.document;
        let editor = vscode.window.activeTextEditor;
        // the preview itself may have the focus
        if (!editor || editor.document !== document)
            editor = vscode.window.visibleTextEditors.find(e => e.document === document);
        if (!editor || !this.sourceEntities.length) return undefined;
        let cursor = editor.selection.active.line;
        let diagram = diagramAt(document, cursor);
        if (!diagram || diagram.index !== this.displayed.index) return undefined;
        return this.sourceMapOf(diagram).lineOf(cursor);
    }
    private definitionAt(document: vscode.TextDocument, position: vscode.Position): vscode.LocationLink[] {
        if (!this.displayed || document !== this.displayed.document || !this.sourceEntities.length) return undefined;
        let diagram = diagramAt(document, position.line);
        if (!diagram || diagram.index !== this.displayed.index) return undefined;
        let map = this.sourceMapOf(diagram);
        let word = document.getWordRangeAtPosition(position, /[\p{L}\p{N}_.$]+/u);
        let line = word ? map.lineOfName(document.getText(word)) : undefined;
        if (line === undefined) line = map.lineOf(position.line);
        if (line === undefined) return undefined;
        let target = map.nameRangeOf(document, line);
        this.pendingDefinition = { uri: document.uri.toString(), position: target.start, time: Date.now() };
        return [{
            originSelectionRange: word,
            targetUri: document.uri,
            targetRange: map.rangeOf(document, line),
            targetSelectionRange: target,
        }];
    }
    private revealOnDefinition(e: vscode.TextEditorSelectionChangeEvent) {
        let pending = this.pendingDefinition;
        if (!pending || Date.now() - pending.time > 2000) return;
        if (e.textEditor.document.uri.toString() !== pending.uri) return;
        if (!e.selections[0].start.isEqual(pending.position)) return;
        this.pendingDefinition = undefined;
        this._uiPreview.reveal();
        this.syncHighlight(true);
    }
    private async revealInPreview() {
        let editor = vscode.window.activeTextEditor;
        if (!editor) return;
        let diagram = diagramAt(editor.document, editor.selection.active.line);
        if (!diagram) return;
        let shown = this.pageReady && this.displayed &&
            this.displayed.document === editor.document && this.displayed.index === diagram.index;
        if (!shown) {
            this.pendingReveal = true;
            await vscode.commands.executeCommand('plantuml.preview');
            return;
        }
        this._uiPreview.reveal();
        this.syncHighlight(true);
    }
    stopWatch() {
        for (let d of this.watchDisposables) {
            d.dispose();
        }
        this.watchDisposables = [];
    }
}
export const previewer = new Previewer();