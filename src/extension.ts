import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { generateSymbolsForDirectory, loadOverrides, symbolReport, writeSymbolIndex } from "./wombat/symbols";
import type { SymbolIndex } from "./wombat/types";
import {
  allReferencesFor,
  codeLensTitle,
  createIndexModel,
  entityRange,
  findSymbolAt,
  formatHover,
  locationOf,
  type IndexModel
} from "./vscode/model";
import { OverrideNameOverlayController } from "./vscode/overrideOverlay";

class SymbolStore {
  private model: IndexModel | undefined;
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  constructor(private readonly context: vscode.ExtensionContext) {}

  load(): void {
    const symbolsPath = this.resolveConfiguredPath("symbolsPath");
    if (!fs.existsSync(symbolsPath)) {
      this.model = undefined;
      this.changeEmitter.fire();
      return;
    }
    const parsed = JSON.parse(fs.readFileSync(symbolsPath, "utf8")) as SymbolIndex;
    this.model = createIndexModel(parsed);
    this.changeEmitter.fire();
  }

  getModel(): IndexModel | undefined {
    return this.model;
  }

  resolveConfiguredPath(key: "scriptsPath" | "symbolsPath" | "overridesPath"): string {
    const config = vscode.workspace.getConfiguration("wombat");
    const raw = config.get<string>(key) ?? "";
    const withExtensionPath = raw.replace("${extensionPath}", this.context.extensionPath);
    if (path.isAbsolute(withExtensionPath)) {
      return path.normalize(withExtensionPath);
    }
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? this.context.extensionPath;
    return path.normalize(path.resolve(folder, withExtensionPath));
  }

  relativeScriptPath(document: vscode.TextDocument): string | undefined {
    const scriptsPath = this.resolveConfiguredPath("scriptsPath");
    const relative = normalizePath(path.relative(scriptsPath, document.uri.fsPath));
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
      return relative;
    }

    const normalized = normalizePath(document.uri.fsPath);
    const marker = "/scripts.wombat/";
    const markerIndex = normalized.lastIndexOf(marker);
    if (markerIndex >= 0) {
      return normalized.slice(markerIndex + marker.length);
    }
    return undefined;
  }
}

export function activate(context: vscode.ExtensionContext): void {
  const store = new SymbolStore(context);
  store.load();
  const overlay = new OverrideNameOverlayController(context, store);

  const selector: vscode.DocumentSelector = [{ language: "wombat", scheme: "file" }];

  context.subscriptions.push(
    overlay,
    vscode.languages.registerHoverProvider(selector, new WombatHoverProvider(store)),
    vscode.languages.registerCodeLensProvider(selector, new WombatCodeLensProvider(store)),
    vscode.languages.registerDefinitionProvider(selector, new WombatDefinitionProvider(store)),
    vscode.languages.registerReferenceProvider(selector, new WombatReferenceProvider(store)),
    vscode.commands.registerCommand("wombat.generateSymbols", async () => generateSymbols(context, store)),
    vscode.commands.registerCommand("wombat.reloadSymbols", async () => {
      store.load();
      vscode.window.showInformationMessage("Wombat symbols reloaded.");
    }),
    vscode.commands.registerCommand("wombat.openSymbolReport", async () => openSymbolReport(store)),
    vscode.commands.registerCommand("wombat.toggleOverrideNamesInEditor", async () => overlay.toggle())
  );

  if (vscode.workspace.getConfiguration("wombat").get<boolean>("autoDetectScriptsWombat", true)) {
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument((document) => autoDetectWombat(document)));
    for (const document of vscode.workspace.textDocuments) {
      void autoDetectWombat(document);
    }
  }
}

export function deactivate(): void {
  // No background resources to release.
}

class WombatHoverProvider implements vscode.HoverProvider {
  constructor(private readonly store: SymbolStore) {}

  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Hover> {
    const lookup = lookupAt(this.store, document, position);
    if (!lookup) {
      return undefined;
    }
    const markdown = new vscode.MarkdownString(formatHover(lookup));
    markdown.supportThemeIcons = true;
    return new vscode.Hover(markdown, document.getWordRangeAtPosition(position, /[A-Za-z_][A-Za-z0-9_]*/));
  }
}

class WombatCodeLensProvider implements vscode.CodeLensProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.changeEmitter.event;

  constructor(private readonly store: SymbolStore) {
    this.store.onDidChange(() => this.changeEmitter.fire());
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const model = this.store.getModel();
    const relativePath = this.store.relativeScriptPath(document);
    if (!model || !relativePath) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    for (const entity of model.declarationsByPath.get(relativePath) ?? []) {
      if (entity.kind !== "function-def" && entity.kind !== "function-forward" && entity.kind !== "member") {
        continue;
      }
      const title = codeLensTitle(entity, model);
      if (!title) {
        continue;
      }
      lenses.push(
        new vscode.CodeLens(toVscodeRange(entityRange(entity)), {
          title,
          command: "wombat.openSymbolReport"
        })
      );
    }
    return lenses;
  }
}

class WombatDefinitionProvider implements vscode.DefinitionProvider {
  constructor(private readonly store: SymbolStore) {}

  provideDefinition(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Definition> {
    const lookup = lookupAt(this.store, document, position);
    const entity = lookup?.definitionTarget ?? lookup?.target;
    const location = entity ? locationOf(entity) : undefined;
    if (!location) {
      return undefined;
    }
    return toVscodeLocation(this.store, location);
  }
}

class WombatReferenceProvider implements vscode.ReferenceProvider {
  constructor(private readonly store: SymbolStore) {}

  provideReferences(document: vscode.TextDocument, position: vscode.Position): vscode.ProviderResult<vscode.Location[]> {
    const model = this.store.getModel();
    const lookup = lookupAt(this.store, document, position);
    if (!model || !lookup) {
      return [];
    }
    return allReferencesFor(model, lookup)
      .map((entity) => locationOf(entity))
      .filter((location): location is NonNullable<typeof location> => location !== undefined)
      .map((location) => toVscodeLocation(this.store, location));
  }
}

async function generateSymbols(context: vscode.ExtensionContext, store: SymbolStore): Promise<void> {
  const scriptsPath = store.resolveConfiguredPath("scriptsPath");
  const outPath = store.resolveConfiguredPath("symbolsPath");
  const overridesPath = store.resolveConfiguredPath("overridesPath");

  if (!fs.existsSync(scriptsPath)) {
    vscode.window.showErrorMessage(`Wombat scripts directory not found: ${scriptsPath}`);
    return;
  }

  if (!fs.existsSync(overridesPath)) {
    fs.mkdirSync(path.dirname(overridesPath), { recursive: true });
    fs.writeFileSync(overridesPath, '{\n  "schemaVersion": 1,\n  "symbols": {}\n}\n', "utf8");
  }

  const index = generateSymbolsForDirectory({
    scriptsPath,
    sourceRootLabel: normalizePath(path.relative(context.extensionPath, scriptsPath)) || normalizePath(scriptsPath),
    overrides: loadOverrides(overridesPath)
  });
  writeSymbolIndex(outPath, index);
  fs.writeFileSync(`${outPath}.report.md`, symbolReport(index), "utf8");
  store.load();
  vscode.window.showInformationMessage(
    `Generated Wombat symbols: ${index.counts.scripts} scripts, ${index.counts.functionSlots} function slots, ${index.counts.diagnostics} diagnostics.`
  );
}

async function openSymbolReport(store: SymbolStore): Promise<void> {
  const model = store.getModel();
  if (!model) {
    vscode.window.showWarningMessage("No Wombat symbols loaded.");
    return;
  }
  const document = await vscode.workspace.openTextDocument({
    language: "markdown",
    content: symbolReport(model.index)
  });
  await vscode.window.showTextDocument(document, { preview: true });
}

async function autoDetectWombat(document: vscode.TextDocument): Promise<void> {
  if (document.uri.scheme !== "file" || document.languageId === "wombat") {
    return;
  }
  if (!normalizePath(document.uri.fsPath).includes("/scripts.wombat/") || !document.fileName.endsWith(".m")) {
    return;
  }
  await vscode.languages.setTextDocumentLanguage(document, "wombat");
}

function lookupAt(store: SymbolStore, document: vscode.TextDocument, position: vscode.Position) {
  const model = store.getModel();
  const relativePath = store.relativeScriptPath(document);
  if (!model || !relativePath) {
    return undefined;
  }
  return findSymbolAt(model, relativePath, { line: position.line, character: position.character });
}

function toVscodeLocation(store: SymbolStore, location: { path: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } }): vscode.Location {
  const scriptsPath = store.resolveConfiguredPath("scriptsPath");
  return new vscode.Location(vscode.Uri.file(path.join(scriptsPath, location.path)), toVscodeRange(location.range));
}

function toVscodeRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, "/");
}
