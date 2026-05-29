# OUO Wombat VS Code

VS Code extension and symbol generator for decoded Wombat scripts.

The extension is intentionally read-only with respect to Wombat source. It
shows readable names and inheritance metadata through editor providers while
leaving `.m` files and compiled bytecode untouched.

## Generate Symbols

```sh
npm install
npm run generate:symbols -- --scripts ../.rundir/scripts.wombat --out symbols/symbols.json --overrides symbols/overrides.json
```

Human-readable names and notes belong in `symbols/overrides.json`. Regenerate
`symbols/symbols.json` after editing overrides.

## Develop

```sh
npm run compile
npm test
```

Open this folder in VS Code and launch the extension host. Files under a
`scripts.wombat` directory are detected as the `wombat` language.
