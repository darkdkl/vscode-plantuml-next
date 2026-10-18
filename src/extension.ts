'use strict';
// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as nls from "vscode-nls";

import { config } from './plantuml/config';
import { previewer } from './providers/previewer';
import { Symbol } from "./providers/symboler";
import { Completion } from "./providers/completion";
import { Signature } from "./providers/signature";
import { Formatter } from "./providers/formatter";
import { notifyOnNewVersion } from "./plantuml/messages";
import { outputPanel, bar, extensionVersion, originalExtensionId } from "./plantuml/common";
import { contextManager } from './plantuml/context';

import { CommandExportCurrent } from './commands/exportCurrent';
import { CommandExportDocument } from './commands/exportDocument';
import { CommandExportWorkspace } from './commands/exportWorkspace';
import { CommandURLCurrent } from './commands/urlCurrent';
import { CommandURLDocument } from './commands/urlDocument';
import { CommandExtractSource } from './commands/extractSource';
import { plantumlPlugin } from './markdown-it-plantuml/index';
import { Diagnoser } from './providers/diagnoser';
import { warmProcesses } from './plantuml/renders/warmProcess';

// this method is called when your extension is activated
// your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
    contextManager.set(context);
    try {
        notifyOnNewVersion(context, extensionVersion);
        if (vscode.extensions.getExtension(originalExtensionId)) {
            vscode.window.showWarningMessage(
                `The original PlantUML extension (${originalExtensionId}) is also enabled. ` +
                `Disable or uninstall one of them, they provide the same commands and settings.`
            );
        }

        context.subscriptions.push(
            new CommandExportCurrent(),
            new CommandExportDocument(),
            new CommandExportWorkspace(),
            new CommandURLCurrent(),
            new CommandURLDocument(),
            new CommandExtractSource(),
            new Formatter(),
            new Symbol(),
            new Completion(),
            new Signature(),
            new Diagnoser(context.extension),
            previewer,
            config,
            outputPanel,
            bar,
        );
        return {
            extendMarkdownIt(md: any) {
                return md.use(plantumlPlugin);
            }
        }
    } catch (error) {
        outputPanel.clear();
        outputPanel.append(error);
    }
}

// this method is called when your extension is deactivated
export function deactivate() {
    warmProcesses.dispose();
}
