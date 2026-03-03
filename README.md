# mpd2glb

> A node.js CLI tool for converting packed LDraw models (.mpd) to GLTF's binary (.glb) format.

[![node-lts](https://img.shields.io[mpd2glb])]
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

**mpd2glb** reads packed .mpd LDraw models (see below for details) and generates a new GLTF binary model (.glb) with most similar features to the original LDraw model. The final .glb model will have the real-world dimensions of the original model, i.e. scaled to centimeters instead of LDUs.

## Features

- **Multi-platform** - Built on node.js with cross-platform dependencies
- **Automated conditional lines clean-up** - Avoids visual artifacts on the output model
- **Rescaling models to real-world size** - Converts LDU dimensions to real-world metrics: .glb models are real-size 
ones!
- **Meshopt optimized** - For quick load times and rendering on browser or elsewhere!
- **No LDraw parts library dependency** - Requires input .mpd models to be packed first, take a look at: 
    - [Packing LDraw Files](https://forums.ldraw.org/thread-28554.html)
    - [packLDrawModel.mjs packager](https://github.com/mrdoob/three.js/blob/dev/utils/packLDrawModel.mjs)

## Quick Start

### Prerequisites

I've built and tested this tool with the following (other versions could also work):

- [Node v24.11](https://nodejs.org/en/download)
- [npm v11.6.1](https://docs.npmjs.com/downloading-and-installing-node-js-and-npm)
- [Bun v1.3.10 (optional)](https://bun.com/)

### Building from source (no other way for now!)

```bash
git clone https://github.com/anteloc/mpd2glb.git
cd mpd2glb
npm install # install required node modules
npm run build # outputs: mpd2glb.mjs executable
```

### Verify it works

```bash
npm main.mjs
# or
bun main.mjs
# or (bun only!)
bun mpd2glb.mjs
```

## Usage

This is a very simple tool, try it with a sample packed model (included):

```bash
node main.js models/f1-car-packed.mpd f1-car.glb
# or (faster execution!)
bun mpd2glb.mjs models/f1-car-packed.mpd f1-car.glb
```
To see the result, open the `f1-car.glb` model on an editor, like e.g. [Three.js Editor](https://threejs.org/editor/)

## Notes

- The resulting .glb files can be imported and edited with other tools
- World-size models (centimetres): on some editors, they will look very small or even hard to find 
- Editable parts: individual parts can be handled independently.

