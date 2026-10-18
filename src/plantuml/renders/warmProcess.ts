import * as child_process from 'child_process';
import { RenderError } from './interfaces';

/*
 * Keeps PlantUML processes running in "-pipe" mode while the preview is open,
 * so that an update doesn't pay the JVM start-up and warm-up for every edit:
 * diagrams are written to stdin one by one, and each output ends with a delimiter.
 * Only the processes of the previewed diagram are kept, one per page, since the
 * file name, include path and page index are command line arguments.
 */

const DELIMITER = "___PLANTUML_VSCODE_DIAGRAM_END___";
// stderr of a diagram (its error message) arrives right after the delimiter
const STDERR_WAIT = 50;
// for diagrams of many pages, pages after this render with new processes
export const MAX_WARM_PAGES = 4;

interface Request {
    content: string;
    canceled: () => boolean;
    resolve: (out: Buffer) => void;
    reject: (err: RenderError) => void;
}

class WarmProcess {
    private process: child_process.ChildProcess;
    private queue: Request[] = [];
    private current: Request = undefined;
    private stdout: Buffer = Buffer.alloc(0);
    private stderr: string = "";
    private exited: boolean = false;

    constructor(command: string, args: string[], private onExit: () => void) {
        this.process = child_process.spawn(command, [...args, "-pipedelimitor", DELIMITER]);
        this.process.stdout.on('data', (chunk: Buffer) => this.onStdout(chunk));
        this.process.stderr.on('data', (chunk: Buffer) => this.stderr += chunk.toString());
        this.process.stdin.on('error', () => { /* reported by 'exit' or 'error' */ });
        this.process.on('error', err => this.terminate(err.message));
        this.process.on('exit', code => this.terminate(`PlantUML process exited with code ${code}`));
    }

    render(content: string, canceled: () => boolean): Promise<Buffer> {
        return new Promise<Buffer>((resolve, reject) => {
            if (this.exited) {
                reject(<RenderError>{ error: "PlantUML process is not running", out: Buffer.alloc(0) });
                return;
            }
            this.queue.push({ content: content, canceled: canceled, resolve: resolve, reject: reject });
            this.next();
        });
    }

    dispose() {
        if (this.exited) return;
        this.process.kill();
        this.terminate("PlantUML process is stopped");
    }

    private next() {
        if (this.current || this.exited) return;
        // skip requests canceled while waiting, the running one can't be stopped
        // without losing the warm process, so it's left to finish.
        let request: Request;
        while ((request = this.queue.shift()) && request.canceled()) {
            request.reject(<RenderError>{ error: "canceled", out: Buffer.alloc(0) });
        }
        if (!request) return;
        this.current = request;
        this.stdout = Buffer.alloc(0);
        this.stderr = "";
        let content = request.content.endsWith("\n") ? request.content : request.content + "\n";
        this.process.stdin.write(content);
    }

    private onStdout(chunk: Buffer) {
        this.stdout = Buffer.concat([this.stdout, chunk]);
        let index = this.stdout.indexOf(DELIMITER);
        if (index < 0 || !this.current) return;
        let out = this.stdout.slice(0, index);
        this.stdout = this.stdout.slice(index + DELIMITER.length);
        // the delimiter is followed by a line break
        let start = 0;
        while (start < out.length && (out[start] == 0x0a || out[start] == 0x0d)) start++;
        out = out.slice(start);

        let request = this.current;
        setTimeout(() => {
            if (this.current !== request) return;
            // If environment variables such as JAVA_TOOL_OPTIONS or _JAVA_OPTIONS are set,
            // some java implementations will echo them on stderr.
            let stderr = this.stderr.replace(/^Picked up .*$/mg, "").trim();
            this.stderr = "";
            this.current = undefined;
            if (stderr)
                request.reject(<RenderError>{ error: stderr, out: out });
            else
                request.resolve(out);
            this.next();
        }, STDERR_WAIT);
    }

    private terminate(reason: string) {
        if (this.exited && !this.current && !this.queue.length) return;
        this.exited = true;
        let stderr = this.stderr.replace(/^Picked up .*$/mg, "").trim();
        let error = <RenderError>{ error: stderr || reason, out: Buffer.alloc(0) };
        let requests = this.current ? [this.current, ...this.queue] : this.queue;
        this.current = undefined;
        this.queue = [];
        requests.forEach(r => r.reject(error));
        this.onExit();
    }
}

class WarmProcessPool {
    private processes = new Map<string, WarmProcess>();

    /**
     * keep only the processes for these command lines, stop the others
     */
    retain(command: string, argsList: string[][]) {
        let keys = new Set(argsList.map(args => this.keyOf(command, args)));
        for (let [key, process] of [...this.processes]) {
            if (keys.has(key)) continue;
            this.processes.delete(key);
            process.dispose();
        }
    }

    /**
     * render a diagram with a running process for the command line, or a new one.
     * @param canceled checked before the diagram is sent to the process
     */
    render(command: string, args: string[], content: string, canceled: () => boolean): Promise<Buffer> {
        let key = this.keyOf(command, args);
        let process = this.processes.get(key);
        if (!process) {
            process = new WarmProcess(command, args, () => {
                if (this.processes.get(key) === process) this.processes.delete(key);
            });
            this.processes.set(key, process);
        }
        return process.render(content, canceled);
    }

    private keyOf(command: string, args: string[]): string {
        return JSON.stringify([command, ...args]);
    }

    dispose() {
        let processes = [...this.processes.values()];
        this.processes.clear();
        processes.forEach(p => p.dispose());
    }
}

export const warmProcesses = new WarmProcessPool();
