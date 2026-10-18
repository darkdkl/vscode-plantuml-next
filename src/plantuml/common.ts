import * as vscode from 'vscode';
import * as fs from 'fs';
import * as nls from "vscode-nls";
import { join } from "path";

export const languageid = "plantuml";

export var outputPanel = vscode.window.createOutputChannel("PlantUML");
export var bar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
// the extension root, found from this file (out/src/plantuml/common.js) rather
// than by the extension id, which would find the original extension in a fork.
export const extensionPath = join(__dirname, "..", "..", "..");
const packageJSON = JSON.parse(fs.readFileSync(join(extensionPath, "package.json"), "utf8"));
export const extensionId: string = `${packageJSON.publisher}.${packageJSON.name}`;
export const extensionVersion: string = packageJSON.version;
export const repositoryURL = "https://github.com/darkdkl/vscode-plantuml-next";
// the extension this one is forked from, they can't be enabled together
export const originalExtensionId = "jebbs.plantuml";

nls.config(<nls.Options>{ locale: vscode.env.language });
export var localize: any = nls.loadMessageBundle(join(extensionPath, "langs", "lang.json"));
