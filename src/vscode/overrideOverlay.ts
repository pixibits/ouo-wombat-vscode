import * as vscode from "vscode";
import type { IndexModel } from "./model";
import { buildOverrideNameDecorations, PersistentBooleanFlag } from "./overridePresentation";

export interface OverrideNameSymbolStore {
  readonly onDidChange: vscode.Event<void>;
  getModel(): IndexModel | undefined;
  relativeScriptPath(document: vscode.TextDocument): string | undefined;
}

const STATE_KEY = "overrideNamesInEditor";

export class OverrideNameOverlayController implements vscode.Disposable {
  private readonly flag: PersistentBooleanFlag;
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly statusBarItem: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly store: OverrideNameSymbolStore
  ) {
    this.flag = new PersistentBooleanFlag(context.workspaceState, STATE_KEY, false);
    this.decorationType = vscode.window.createTextEditorDecorationType({
      color: "rgba(0, 0, 0, 0)"
    });
    this.statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
    this.statusBarItem.command = "wombat.toggleOverrideNamesInEditor";
    this.statusBarItem.tooltip = "Toggle in-place override names in Wombat editors";
    this.statusBarItem.show();

    this.disposables.push(
      this.store.onDidChange(() => this.refreshVisibleEditors()),
      vscode.window.onDidChangeActiveTextEditor(() => this.refreshVisibleEditors()),
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshVisibleEditors()),
      vscode.workspace.onDidOpenTextDocument(() => this.refreshVisibleEditors())
    );

    this.syncStatusBar();
    this.refreshVisibleEditors();
  }

  get enabled(): boolean {
    return this.flag.current;
  }

  async toggle(): Promise<void> {
    await this.flag.toggle();
    this.syncStatusBar();
    this.refreshVisibleEditors();
  }

  refreshVisibleEditors(): void {
    for (const editor of vscode.window.visibleTextEditors) {
      this.refreshEditor(editor);
    }
  }

  dispose(): void {
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.statusBarItem.dispose();
    this.decorationType.dispose();
  }

  private refreshEditor(editor: vscode.TextEditor): void {
    if (!this.enabled || editor.document.uri.scheme !== "file") {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const model = this.store.getModel();
    const relativePath = this.store.relativeScriptPath(editor.document);
    if (!model || !relativePath) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    const decorations = buildOverrideNameDecorations(model, relativePath);
    if (decorations.length === 0) {
      editor.setDecorations(this.decorationType, []);
      return;
    }

    editor.setDecorations(
      this.decorationType,
      decorations.map((spec) => ({
        range: toVscodeRange(spec.range),
        renderOptions: {
          after: {
            contentText: spec.displayText,
            color: new vscode.ThemeColor("editor.foreground"),
            margin: `0 0 0 -${spec.rawText.length}ch`
          }
        }
      }))
    );
  }

  private syncStatusBar(): void {
    this.statusBarItem.text = this.enabled ? "Wombat: Display" : "Wombat: Raw";
    this.statusBarItem.tooltip = this.enabled
      ? "Override names are shown inline in Wombat editors. Click to switch back to raw names."
      : "Raw Wombat names are shown inline in editors. Click to show override names.";
  }
}

function toVscodeRange(range: { start: { line: number; character: number }; end: { line: number; character: number } }): vscode.Range {
  return new vscode.Range(range.start.line, range.start.character, range.end.line, range.end.character);
}
