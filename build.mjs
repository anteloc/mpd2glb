// Bundles main.mjs into mpd2glb.mjs, a single self-contained CLI file.
//
// The bundle must run with nothing but Node.js or Bun: release archives ship
// without node_modules, and users copy mpd2glb.mjs into other projects. Every
// runtime dependency is therefore bundled, including WASM binaries.
import { build } from "esbuild";
import { createRequire } from "node:module";
import { dirname } from "node:path";

const require = createRequire(import.meta.url);

// draco3dgltf is an Emscripten build that reads draco_encoder.wasm from its own
// directory at runtime, which does not exist once bundled. Replace the package
// with a wrapper that hands the encoder the WASM bytes embedded in the bundle.
// Only the encoder is used by mpd2glb, so the decoder is left out.
const dracoDir = dirname(require.resolve("draco3dgltf"));

const inlineDracoWasm = {
  name: "inline-draco-wasm",
  setup(build) {
    build.onResolve({ filter: /^draco3dgltf$/ }, () => ({
      path: "draco3dgltf",
      namespace: "inline-draco-wasm",
    }));
    build.onLoad({ filter: /.*/, namespace: "inline-draco-wasm" }, () => ({
      contents: `
        import createEncoderModule from "./draco_encoder_gltf_nodejs.js";
        import wasmBinary from "./draco_encoder.wasm";

        export default {
          createEncoderModule: (module = {}) => createEncoderModule({ wasmBinary, ...module }),
        };
      `,
      resolveDir: dracoDir,
      loader: "js",
    }));
  },
};

// sharp is a native module with per-platform binaries, so it cannot be bundled.
// It is only reached through ndarray-pixels when prune() checks textures for a
// solid color, and prune() treats a failure there as "keep the texture". A stub
// that throws is enough, and the bundle no longer needs sharp installed.
const stubSharp = {
  name: "stub-sharp",
  setup(build) {
    build.onResolve({ filter: /^sharp$/ }, () => ({
      path: "sharp",
      namespace: "stub-sharp",
    }));
    build.onLoad({ filter: /.*/, namespace: "stub-sharp" }, () => ({
      contents: `
        export default function sharp() {
          throw new Error("sharp is not included in the mpd2glb bundle");
        }
      `,
      loader: "js",
    }));
  },
};

await build({
  entryPoints: ["main.mjs"],
  outfile: "mpd2glb.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  // Matches engines.node in package.json. Without it, esbuild decodes the
  // inlined WASM with Uint8Array.fromBase64(), which Node.js 24 does not have.
  target: "node24.11",
  // Bundled CommonJS modules (e.g. draco3dgltf) call require() and read
  // __dirname/__filename, none of which exist in an ES module.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  define: {
    __dirname: "import.meta.dirname",
    __filename: "import.meta.filename",
  },
  loader: { ".wasm": "binary" },
  plugins: [inlineDracoWasm, stubSharp],
});
