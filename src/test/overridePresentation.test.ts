import { describe, expect, it } from "vitest";
import { createIndexModel } from "../vscode/model";
import { buildOverrideNameDecorations, PersistentBooleanFlag, type BooleanStateStore } from "../vscode/overridePresentation";
import { generateSymbolsFromFiles } from "../wombat/symbols";

describe("override name presentation", () => {
  it("builds decoration specs for overridden functions, members, and references", () => {
    const files = [
      {
        name: "spell",
        path: "spell.m",
        text: `
          member obj Q5F6;

          function void Q4RD() {
            return();
          }

          function void castSpell(obj speaker) {
            Q4RD();
            Q4BY();
            return();
          }

          function void Q4BY() {
            return();
          }
        `
      }
    ];

    const baseIndex = generateSymbolsFromFiles(files, "fixture");
    const functionSlotId = baseIndex.functionSlots.find((record) => record.name === "Q4RD")?.id;
    const memberId = baseIndex.members.find((record) => record.name === "Q5F6")?.id;

    expect(functionSlotId).toBeDefined();
    expect(memberId).toBeDefined();

    const index = generateSymbolsFromFiles(files, "fixture", {
      schemaVersion: 1,
      symbols: {
        [functionSlotId!]: {
          displayName: "fizzleSpell"
        },
        [memberId!]: {
          displayName: "activePet"
        }
      }
    });

    const model = createIndexModel(index);
    const decorations = buildOverrideNameDecorations(model, "spell.m");

    expect(
      decorations.filter((entry) => entry.rawText === "Q4RD").map((entry) => ({ kind: entry.kind, displayText: entry.displayText }))
    ).toEqual([
      { kind: "function-def", displayText: "fizzleSpell" },
      { kind: "reference", displayText: "fizzleSpell" }
    ]);
    expect(decorations.find((entry) => entry.rawText === "Q5F6")).toMatchObject({
      kind: "member",
      displayText: "activePet"
    });
    expect(decorations.some((entry) => entry.rawText === "Q4BY")).toBe(false);
  });

  it("persists the editor toggle in workspace state", async () => {
    const values = new Map<string, boolean>();
    const store: BooleanStateStore = {
      get<T>(key: string, defaultValue: T): T {
        if (values.has(key)) {
          return values.get(key) as T;
        }
        return defaultValue;
      },
      async update(key: string, value: boolean): Promise<void> {
        values.set(key, value);
      }
    };

    const flag = new PersistentBooleanFlag(store, "overrideNamesInEditor");
    expect(flag.current).toBe(false);

    await flag.toggle();
    expect(flag.current).toBe(true);
    expect(values.get("overrideNamesInEditor")).toBe(true);

    await flag.set(false);
    expect(flag.current).toBe(false);
    expect(values.get("overrideNamesInEditor")).toBe(false);
  });
});
