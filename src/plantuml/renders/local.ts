import * as vscode from 'vscode';
import * as fs from 'fs';
import * as child_process from 'child_process';
import * as path from 'path';

import { IRender, RenderTask, RenderError } from './interfaces'
import { Diagram } from '../diagram/diagram';
import { config } from '../config';
import { localize, extensionPath } from '../common';
import { addFileIndex } from '../tools';
import { processWrapper } from './processWrapper';
import { warmProcesses, MAX_WARM_PAGES, setWarmProcessLogger } from './warmProcess';
import { logMessage } from '../tools';

setWarmProcessLogger(logMessage);

class LocalRender implements IRender {
    private unpairedDiagram: string = undefined;

    /**
     * Indicates the exporter should limt concurrency or not.
     * @returns boolean
     */
    limitConcurrency(): boolean {
        return true;
    }
    /**
     * formats return an string array of formats that the exporter supports.
     * @returns an array of supported formats
     */
    formats(): string[] {
        // no "pdf": the bundled MIT build of PlantUML can't export PDF
        return [
            "png",
            "svg",
            "eps",
            "vdx",
            "xmi",
            "scxml",
            "html",
            "txt",
            "utxt",
            "latex",
            "latex:nopreamble"
        ];
    }
    /**
     * export a diagram to file or to Buffer.
     * @param diagram The diagram to export.
     * @param format format of export file.
     * @param savePath if savePath is given, it exports to a file, or, to Buffer.
     * @returns ExportTask.
     */
    render(diagram: Diagram, format: string, savePath: string): RenderTask {
        // rendering to buffer is for the preview, which is updated on every edit
        if (!savePath && config.previewKeepAlive(diagram.parentUri))
            return this.createWarmTask(diagram, format);
        return this.createTask(diagram, "-pipe", savePath, format);
    }

    getMapData(diagram: Diagram, savePath: string): RenderTask {
        return this.createTask(diagram, "-pipemap", savePath);
    }
    /**
     * java arguments to render a page of the diagram from stdin
     */
    buildParams(diagram: Diagram, index: number, taskType: string, format?: string): string[] {
        let params = [
            '-Djava.awt.headless=true',
            '-jar',
            config.jar(diagram.parentUri),
            "-pipeimageindex",
            `${index}`,
            '-charset',
            'utf-8',
        ];

        let includePath = ''
        if (diagram.dir && path.isAbsolute(diagram.dir)) {
            includePath = diagram.dir;
        }

        let ws = vscode.workspace.getWorkspaceFolder(diagram.parentUri);
        let folderPaths = config.includepaths(diagram.parentUri);
        for (let folderPath of folderPaths) {
            if (!folderPath) continue;
            if (!path.isAbsolute(folderPath)) {
                folderPath = path.join(ws.uri.fsPath, folderPath);
            }
            includePath = includePath + path.delimiter + folderPath;
        }

        let diagramsRoot = config.diagramsRoot(diagram.parentUri);
        if (diagramsRoot) {
            includePath = includePath + path.delimiter + diagramsRoot.fsPath;
        }

        params.unshift('-Dplantuml.include.path=' + includePath);

        // Add user java args
        params.unshift(...config.commandArgs(diagram.parentUri));
        // Jar args
        params.push(taskType);
        if (format) params.push("-t" + format);
        if (diagram.path) params.push("-filename", path.basename(diagram.path));
        // Add user jar args
        params.push(...config.jarArgs(diagram.parentUri));
        return params;
    }
    /**
     * render with running PlantUML processes, see warmProcess.ts
     */
    private createWarmTask(diagram: Diagram, format: string): RenderTask {
        let error = this.checkJava(diagram);
        if (error) return <RenderTask>{ promise: Promise.reject(error) };

        let java = config.java(diagram.parentUri);
        let params = [...Array(diagram.pageCount).keys()].map(index => this.buildParams(diagram, index, "-pipe", format));
        // stop the processes of previously previewed diagrams
        warmProcesses.retain(java, params.slice(0, MAX_WARM_PAGES));
        let content = pipeContent(diagram.content);
        let diagramKey = `${diagram.path}:${diagram.start ? diagram.start.line : 0}`;
        if (content !== undefined) {
            if (this.unpairedDiagram === diagramKey) this.unpairedDiagram = undefined;
        } else if (this.unpairedDiagram !== diagramKey) {
            this.unpairedDiagram = diagramKey;
            logMessage(`${diagram.name}: no @start/@end lines, rendering without a running PlantUML process`);
        }
        let fileName = diagram.path ? path.basename(diagram.path) : diagram.name;

        let task = <RenderTask>{ processes: [], canceled: false };
        // pages one at a time, like createTask()
        task.promise = params.reduce(
            (pChain, pageParams, index) => pChain.then(buffers => {
                if (task.canceled) return buffers;
                let label = diagram.pageCount > 1 ? `${fileName}, page ${index + 1}` : fileName;
                let render: Promise<Buffer> = content !== undefined && index < MAX_WARM_PAGES ?
                    warmProcesses.render(java, pageParams, content, label, () => task.canceled) :
                    this.renderOnce(java, pageParams, diagram.content);
                return render
                    .then(
                        out => [...buffers, out],
                        err => Promise.reject(<RenderError>{ error: localize(10, null, diagram.name, err.error), out: err.out })
                    );
            }),
            Promise.resolve(<Buffer[]>[])
        );
        return task;
    }
    private renderOnce(java: string, params: string[], content: string): Promise<Buffer> {
        let process = child_process.spawn(java, params);
        process.stdin.write(content);
        process.stdin.end();
        return processWrapper(process);
    }
    private checkJava(diagram: Diagram): string {
        if (!config.java) return localize(5, null);
        if (!fs.existsSync(config.jar(diagram.parentUri))) return localize(6, null, extensionPath);
        return undefined;
    }
    private createTask(diagram: Diagram, taskType: string, savePath: string, format?: string): RenderTask {
        if (!config.java) {
            let pms = Promise.reject(localize(5, null));
            return <RenderTask>{ promise: pms };
        }
        if (!fs.existsSync(config.jar(diagram.parentUri))) {
            let pms = Promise.reject(localize(6, null, extensionPath));
            return <RenderTask>{ promise: pms };
        }

        let processes: child_process.ChildProcess[] = [];
        let buffers: Buffer[] = [];
        //make a promise chain that export only one page at a time
        //but processes are all started at the begining, and recorded for later process.
        let pms = [...Array(diagram.pageCount).keys()].reduce(
            (pChain, index) => {
                let params = this.buildParams(diagram, index, taskType, format);
                let process : any = child_process.spawn(config.java(diagram.parentUri), params);
                processes.push(process);
                return pChain.then(
                    () => {

                        if (process.killed) {
                            buffers = null;
                            return Promise.resolve(null);
                        }

                        if (diagram && diagram.content) {
                            process.stdin.write(diagram.content);
                            process.stdin.end();
                        }
                        let savePath2 = savePath ? addFileIndex(savePath, index, diagram.pageCount) : "";

                        let pms = processWrapper(process, savePath2).then(
                            stdout => buffers.push(stdout),
                            err => Promise.reject(<RenderError>{ error: localize(10, null, diagram.name, err.error), out: err.out })
                        );
                        return pms;
                    },
                    err => {
                        return Promise.reject(err);
                    }
                )
            },
            Promise.resolve(Buffer.alloc(0))
        );
        return <RenderTask>{
            processes: processes,
            promise: new Promise<Buffer[]>(
                (resolve, reject) => {
                    pms.then(
                        () => {
                            resolve(buffers);
                        },
                        err => {
                            reject(err);
                        }
                    )
                }
            )
        }
    }
}
export const localRender = new LocalRender();

function pipeContent(content: string): string {
    let lines = content.split("\n");
    let first = lines.findIndex(line => line.trim() !== "");
    let last = lines.length - 1;
    while (last > first && lines[last].trim() === "") last--;
    if (first < 0 || first == last) return undefined;
    let start = lines[first].trim().match(/^@start([a-z]+)/);
    if (!start || !lines[last].trim().startsWith("@end" + start[1])) return undefined;
    lines[first] = lines[first].trim();
    lines[last] = lines[last].trim();
    return lines.join("\n");
}
