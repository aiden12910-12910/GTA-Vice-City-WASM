# GTA Vice City in your Browser

Play GTA Vice City in your browser using game files you are authorized to use. The project runs locally in your browser and is still experimental.

[![Open in your browser](https://img.shields.io/badge/-open%20in%20your%20browser-0098d4?style=for-the-badge)](https://joncodeofficial.github.io/gta-vice-city-wasm/)

![GTA: Vice City running in the browser, with a custom Spider-Man skin](public/demo.webp)

Only use files you have permission to use. This project does not provide or distribute GTA VC game assets and is still experimental. If you do not have GTA VC game files, ask the developer about an authorized USB copy.

## What's included

- **Play in your browser.** Nothing to install, and your game files stay on your device.
- **Your own saved games.** Import, export and remove PC saves.
- **Custom skins.** Change how Tommy looks with your own images.
- **Experimental cheats.** Cheat controls are marked TEST and may not work yet.
- **Touch controls.** On-screen controls for phones and tablets.
- **Controller support.** Pair a controller and press any button to play.
- **Install it as an app.** Add it to your desktop or home screen from the browser.

## How it works

1. Install GTA: Vice City for PC from your own copy (Steam, Rockstar Games Launcher or the original discs)
2. Open the [live page](https://joncodeofficial.github.io/gta-vice-city-wasm/) and drop the folder where the game is installed (or a `.zip` of it) onto **Game files (PC)**, or use its **Choose folder** / **Choose .zip** buttons. On a phone, use a `.zip`
3. The game loads into your browser's local storage (OPFS). It takes a few minutes and only happens once. Nothing is uploaded
4. Click **Start to play** and the game loads entirely from your device

Your imported data persists between sessions so you only need to import once unless you clear browser storage.

The site only hosts the engine (`public/engine/`) and a few files from the reVC project (`public/revc/`), such as controller button icons and `revc.ini`. Everything from the game comes from your own install.

## Saves & skins

Before pressing Start, you can add your own saved games and character skins from the **Saves & skins** section.

### Saves

- Add a saved game downloaded for **GTA Vice City on PC**. Files named `GTAVCsf1.b` to `GTAVCsf8.b`, or a `.zip` containing one, both work.
- Importing into a slot that already has a save replaces it.
- You can download your saves to keep them safe.

### Skins

- Add a skin as a `.bmp`, `.png`, `.jpg` or `.zip` file. It is adjusted automatically.
- Once in game, open *Options → Player Skin Setup*, pick your skin and leave the menu to put it on.
- Skins only change Tommy's everyday outfit.

If your download is a `.rar` or `.7z`, unpack it first. *Reset game data* also deletes your saves and skins.

## Requirements

- A modern desktop browser with WebAssembly + OPFS + Service Worker support
- Recommended: Chrome 110+, Firefox 111+, or Safari 16.4+
- GTA: Vice City for PC installed (about 1.5 GB), and about 1.2 GB of free browser storage for the game

## Running locally

```bash
pnpm install
pnpm dev
```

Then open `http://localhost:5173`.

To test the conversion outside the browser, run it on an install folder:

```bash
node scripts/convert-pc.mjs "<path to GTA Vice City>" out/
```

## Tech stack

- **Vite** — dev server and build tool
- **WebAssembly** — game engine compiled from C++ via Emscripten
- **OPFS** (Origin Private File System) — stores the converted game data locally in the browser
- **Service Worker** — intercepts fetch requests to serve game files from OPFS
- **Web Worker** — converts the game install off the main thread (`src/convert/`, MP3 encoding with [lamejs](https://github.com/zhuker/lamejs))

## Credits

**Browser client port** (OPFS storage, Service Worker, import UI, GitHub Pages deploy):
[@joncodeofficial](https://github.com/joncodeofficial)

**Based on** [reVCDOS](https://github.com/Lolendor/reVCDOS) by [@Lolendor](https://github.com/Lolendor)

**WASM engine port** by the DOS Zone team:
- [@specialist003](https://github.com/okhmanyuk-ev)
- [@caiiiycuk](https://www.youtube.com/caiiiycuk)
- [@SerGen](https://t.me/ser_var)

The game engine is based on the open-source reverse engineering project [re3/reVC](https://github.com/SugaryHull/re3/tree/miami).

## License

This repository's source code is licensed under the [MIT License](LICENSE).

## Disclaimer

Only use files you have permission to use. This project does not provide or distribute GTA VC game assets and is still experimental. If you do not have GTA VC game files, ask the developer about an authorized USB copy.

This is an unofficial, non-commercial fan project. It is not affiliated with, endorsed by, or sponsored by Rockstar Games or Take-Two Interactive. All trademarks and copyrights belong to their respective owners. The source code is provided as-is under the MIT License; see [LICENSE](LICENSE) for details.
