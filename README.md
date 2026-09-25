# Pi Pair Programmer

TypeScript [Pi extension](https://pi.dev/docs/extensions). The current entry point registers `/pair-programmer`, which confirms that the extension loaded; pair-programming behavior has not been specified yet.

## Develop

Requires Node.js 22.19 or newer.

```sh
npm install
npm run check
./node_modules/.bin/pi --extension ./src/index.ts
```

Run `/pair-programmer` in Pi to verify the extension. Pi loads the TypeScript source directly; no build step is needed.

## Install as a Pi package

From a local checkout:

```sh
pi install ./path/to/pi-pair-programmer
```

The `pi.extensions` entry in `package.json` makes `src/index.ts` discoverable when installing the package. Pi supplies the host API at runtime; the dependency is included locally for development and declared as a peer for package consumers.
