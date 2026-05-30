import type { IndexModel, SymbolEntity } from "./model";
import { entityRange, presentationLabelForEntity } from "./model";
import type { SourceRange } from "../wombat/types";

export interface OverrideNameDecorationSpec {
  kind: SymbolEntity["kind"];
  range: SourceRange;
  rawText: string;
  displayText: string;
}

export interface BooleanStateStore {
  get<T>(key: string, defaultValue: T): T;
  update(key: string, value: boolean): PromiseLike<void> | Promise<void>;
}

export class PersistentBooleanFlag {
  private value: boolean;

  constructor(
    private readonly store: BooleanStateStore,
    private readonly key: string,
    defaultValue = false
  ) {
    this.value = store.get<boolean>(key, defaultValue);
  }

  get current(): boolean {
    return this.value;
  }

  async set(value: boolean): Promise<void> {
    if (this.value === value) {
      return;
    }

    await this.store.update(this.key, value);
    this.value = value;
  }

  async toggle(): Promise<void> {
    await this.set(!this.value);
  }
}

export function buildOverrideNameDecorations(model: IndexModel, relativePath: string): OverrideNameDecorationSpec[] {
  const decorations: OverrideNameDecorationSpec[] = [];

  for (const entity of model.declarationsByPath.get(relativePath) ?? []) {
    const displayText = presentationLabelForEntity(entity);
    const rawText = rawNameForEntity(entity);
    if (!displayText || !rawText) {
      continue;
    }

    decorations.push({
      kind: entity.kind,
      range: entityRange(entity),
      rawText,
      displayText
    });
  }

  for (const ref of model.referencesByPath.get(relativePath) ?? []) {
    const target = ref.targetId ? model.byId.get(ref.targetId) : undefined;
    const displayText = target ? presentationLabelForEntity(target) : undefined;
    if (!displayText) {
      continue;
    }

    decorations.push({
      kind: "reference",
      range: ref.location.range,
      rawText: ref.name,
      displayText
    });
  }

  decorations.sort((a, b) => {
    const startLine = a.range.start.line - b.range.start.line;
    if (startLine !== 0) {
      return startLine;
    }
    const startCharacter = a.range.start.character - b.range.start.character;
    if (startCharacter !== 0) {
      return startCharacter;
    }
    return a.range.end.character - b.range.end.character;
  });

  return decorations;
}

function rawNameForEntity(entity: SymbolEntity): string | undefined {
  switch (entity.kind) {
    case "reference":
    case "trigger":
      return undefined;
    default:
      return entity.record.name;
  }
}
