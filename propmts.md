# Fix LDrawLoader.js

## Goal

The current project is a tool for converting from **LDraw LEGO CAD models** in `.mpd` format to `.glb` format (glTF).

This tool fails to **correctly perform the conversion** for some of the input models, even though they are **correct according to the LDraw standard**, and our **main goal** is to **fix this tool**.

## Context

A `.mpd` file is a source file describing the assembly of several parts, subparts, submodels, in order to get a full model.

As part of the LDraw specification, a submodel can be declared inside a `.mpd` file, as a `0 FILE` section, and then referenced elsewhere in the file like on a `1-line`, that's a file-reference, like e.g.:

```
1 72 460 0 -190 1 0 0 0 1 0 0 0 1 10179 - subModel-2.ldr
...
0 FILE 10179 - subModel-2.ldr
0 subModel-2
0 Author: Roland Dahl [RolandD]
0 Name: 10179 - subModel-2.ldr
0 !LDRAW_ORG Model
0 !LICENSE Redistributable under CCAL version 2.0 : see CAreadme.txt
0 !THEME Star Wars / Ultimate Collector Series / Star Wars Episode 4/5/6
1 72 0 0 0 1 0 0 0 1 0 0 0 1 3703.dat
0 STEP
1 71 -160 -8 0 1 0 0 0 1 0 0 0 1 3460.dat
1 71 -160 -16 0 1 0 0 0 1 0 0 0 1 3460.dat
1 71 -20 -8 -20 0 0 -1 0 1 0 1 0 0 3021.dat
1 71 -20 -16 -20 0 0 -1 0 1 0 1 0 0 3021.dat
1 71 120 -8 0 -1 0 0 0 1 0 0 0 -1 3710.dat
1 71 120 -16 0 -1 0 0 0 1 0 0 0 -1 3710.dat
```

**LDraw Standard Rule** for **resolving the actual** file and/or submodel is:

**If the referenced file or submodel is embedded into the .mpd file on a `0 FILE` section, then give priority to that; else, try and find it on the LDraw parts library as a part or a subpart `.dat` file**

For our scenario, **for certain specific cases**, a **ThreeJS loader** dependency called **LDrawLoader.js**, required for loading the `.mpd` file and resolving its dependencies, **ignores this rule** and goes directly to the **LDraw parts library**, trying to find the referenced file, instead of resolving it **inside the `.mpd` file** as a **`0 FILE` submodel section**.

Given that the referenced file is actually a submodel, the conversion process either fails or is incomplete, because such submodel doesn't exist in the LDraw library.

## Test case

An example test case of a `.mpd` file at `./models/10179-1.mpd`, which cannot be converted due to the issue mentioned before is the following:

```
$  node main.mjs -l $LDRAW_DIR -c meshopt ./models/10179-1.mpd -o result.glb
Processing: models/10179-1.mpd...
Error: LDrawLoader: Subobject "parts/s/10179 - 47996s01_bended.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
Error: LDrawLoader: Subobject "parts/s/10179 - 33299s01.dat" could not be loaded.
    at LDrawParsedCache.fetchData (file:///Users/captain/workspaces/workspace-ai/mpd2glb/node_modules/three/examples/jsm/loaders/LDrawLoader.js:647:9)
```

## Golden Rules

- We want to get a tool that just works, not to fix the root cause.
- Don't try and fix the loader, ThreeJS or the like.
- Instead, try and find workaround(s) via methods like e.g. 
    - monkey patching, 
    - inheritance overriding, 
    - custom configurations, 
    - etc.

