import fs from "node:fs/promises";
import * as THREE from "three";
import { LDrawLoader } from "three/addons/loaders/LDrawLoader.js";
import { LDrawConditionalLineMaterial } from "three/addons/materials/LDrawConditionalLineMaterial.js";
import { GLTFExporter } from "three/examples/jsm/exporters/GLTFExporter.js";
import { NodeIO } from "@gltf-transform/core";
import { MeshoptEncoder } from "meshoptimizer"; // WASM, no external binary needed
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { meshopt } from "@gltf-transform/functions";
import { draco } from "@gltf-transform/functions";
import draco3d from "draco3dgltf";

import { Blob, FileReader } from "vblob";
import { parseArgs } from "node:util";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const COMPRESSION_MODES = ["draco", "meshopt", "none"];

globalThis.Blob = Blob;
globalThis.FileReader = FileReader;

// ---------------------------------------------------------------------------
// Node.js shim for THREE.FileLoader
//
// In a browser, FileLoader uses XMLHttpRequest / fetch to load URLs.
// In Node.js that works for fetch (Node ≥ 18) in theory, but Three.js's
// internal error handling swallows network failures silently, so any HTTPS
// request that fails (CORS header, missing XHR polyfill, redirect quirks…)
// simply produces no output and no error message.
//
// The fix: replace the load() method on THREE.FileLoader with one that uses
// Node-native APIs (fs for file:// URLs, global fetch for http/https).
// This runs for every file the loader touches — parts, materials, configs —
// so no URL-specific hacks are needed.
// ---------------------------------------------------------------------------
(function patchFileLoader() {
  const proto = THREE.FileLoader.prototype;
  const _origLoad = proto.load;

  proto.load = function (url, onLoad, onProgress, onError) {
    // Replicate Three.js path/manager expansion so we can inspect the FINAL
    // URL before deciding whether to handle it natively.  If we checked the
    // raw `url` argument we would miss relative paths like 'parts/3001.dat'
    // that only become absolute after FileLoader prepends its base path
    // (set via loader.setPartsLibraryPath → fileLoader.setPath).
    let resolvedUrl = url ?? "";
    if (this.path) resolvedUrl = this.path + resolvedUrl;
    if (this.manager) resolvedUrl = this.manager.resolveURL(resolvedUrl);

    // Only intercept URL schemes that Node.js handles natively.
    // For everything else (relative paths, data URIs, …) fall through to the
    // original Three.js implementation unchanged.
    if (!/^(https?|file):\/\//.test(resolvedUrl)) {
      return _origLoad.call(this, url, onLoad, onProgress, onError);
    }

    const responseType = this.responseType; // '' | 'arraybuffer' | 'blob' | ...
    this.manager?.itemStart(resolvedUrl);

    (async () => {
      let data;

      if (resolvedUrl.startsWith("file://")) {
        const filePath = new URL(resolvedUrl).pathname;
        data =
          responseType === "arraybuffer"
            ? (await fs.readFile(filePath)).buffer
            : await fs.readFile(filePath, "utf8");
      } else {
        const res = await fetch(resolvedUrl);
        if (!res.ok)
          throw new Error(
            `HTTP ${res.status} ${res.statusText}: ${resolvedUrl}`,
          );
        data =
          responseType === "arraybuffer"
            ? await res.arrayBuffer()
            : await res.text();
      }

      this.manager?.itemEnd(resolvedUrl);
      onLoad?.(data);
    })().catch((err) => {
      this.manager?.itemError(resolvedUrl);
      if (onError) {
        onError(err);
      } else {
        console.error("FileLoader error:", err);
      }
    });
  };
})();

function usage() {
  console.error("\nUsage: node main.mjs [options] <input.mpd>");
  console.error(
    "Converts an LDraw MPD file to an optimized GLTF .glb file. The output filename is derived from the input if not provided.",
  );
  console.error("Options:");
  console.error(
    "  -c, --compress <mode>   draco|meshopt|none (default: meshopt)",
  );
  console.error(
    "  -l, --ldraw <url>       Library URL (http(s):// or file:// for a local directory)",
  );
  console.error(
    "  -o, --output <file>     Output filename (default: <input>.glb)",
  );
  console.error("Examples:");
  console.error(
    "  # Convert with meshopt compression and a parts LDraw library URL",
  );
  console.error(
    "  node main.mjs -c meshopt -l https://github.com/anteloc/ldraw-lib/tree/master/ldraw -o output-dir/f1-car.glb models/f1-car.mpd",
  );
  console.error(
    "  # Convert with meshopt compression and a local LDraw library",
  );
  console.error(
    "  node main.mjs -l file://some/path/ldraw -o output-dir/f1-car.glb models/f1-car.mpd",
  );
  console.error(
    "  # Convert with (default) meshopt compression and no LDraw library (only works for fully packed .mpd files)",
  );
  console.error(
    "  node main.mjs -o output-dir/f1-car.glb models/f1-car-packed.mpd",
  );
}

/**
 * Exports a THREE.Object3D to a .glb binary buffer.
 *
 * @param {THREE.Object3D} object - The object to export.
 * @param {number} scale - The scale factor to apply to the object.
 * @param {number} xrot - The rotation around the X-axis to apply to the object.
 * @returns {Promise<ArrayBuffer>} - Resolves with the .glb ArrayBuffer.
 */
async function exportToGLB(object, scale, xrot) {
  prepareObject(object);

  object.scale.setScalar(scale);
  object.rotation.x = xrot; // flip Y-down (LDraw) → Y-up (GLTF)
  object.updateWorldMatrix(true, true);

  return new Promise((resolve, reject) => {
    const exporter = new GLTFExporter();

    exporter.parse(
      object,
      (result) => {
        if (result instanceof ArrayBuffer) {
          resolve(result);
        } else {
          const blob = new TextEncoder().encode(JSON.stringify(result));
          resolve(blob.buffer);
        }
      },
      (error) => reject(error),
      {
        binary: true,
        forceIndices: true,
        truncateDrawRange: true,
        mimeType: "image/png",
        animations: collectAnimations(object),
        includeCustomExtensions: false,
      },
    );
  });
}

/**
 * Walk the graph and collect every AnimationClip attached to any object.
 *
 * @param {THREE.Object3D} root
 * @returns {THREE.AnimationClip[]}
 */
function collectAnimations(root) {
  const clips = [];
  root.traverse((node) => {
    if (Array.isArray(node.animations)) {
      clips.push(...node.animations);
    }
  });
  return [...new Set(clips)];
}

/**
 * Pre-export cleanup:
 *  - Convert Float64 attributes → Float32 (GLTF spec requirement)
 *  - Downcast Uint32 indices → Uint16 when vertex count allows (saves ~50% index size)
 *  - Strip zero-influence morph attributes
 *
 * @param {THREE.Object3D} root
 */
function prepareObject(root) {
  root.traverse((node) => {
    if (!node.isMesh && !node.isPoints && !node.isLine) return;

    const geo = node.geometry;
    if (!geo) return;

    // Float64 → Float32
    for (const [name, attr] of Object.entries(geo.attributes)) {
      if (attr.array instanceof Float64Array) {
        geo.setAttribute(
          name,
          new THREE.BufferAttribute(
            new Float32Array(attr.array),
            attr.itemSize,
          ),
        );
      }
    }

    // Uint32 → Uint16 when safe
    if (geo.index && geo.index.array instanceof Uint32Array) {
      const vertexCount = geo.attributes.position?.count ?? 0;
      if (vertexCount <= 65535) {
        geo.setIndex(
          new THREE.BufferAttribute(new Uint16Array(geo.index.array), 1),
        );
      }
    }

    // Strip zero-influence morph targets
    if (geo.morphAttributes) {
      const allZero = (node.morphTargetInfluences ?? []).every((w) => w === 0);
      if (allZero) {
        for (const key of Object.keys(geo.morphAttributes)) {
          delete geo.morphAttributes[key];
        }
        node.morphTargetInfluences = [];
        node.morphTargetDictionary = {};
      }
    }
  });
}

/**
 * Reads an LDraw MPD file content and parses it into a THREE.Group using LDrawLoader.
 * @param {String} mpdText
 * @param {String} ldrawLibrary - Optional URL to the LDraw parts library.
 * @returns {Promise<THREE.Group>} - Resolves with a THREE.Group containing the parsed LDraw model.
 */
async function ldrawMPDtoGroup(mpdText, ldrawLibrary) {
  const loader = new LDrawLoader();

  // Required in recent three.js if the model uses conditional lines
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);

  if (ldrawLibrary) {
    loader.setPartsLibraryPath(ldrawLibrary);
    await loader.preloadMaterials(`${ldrawLibrary}LDConfig.ldr`).catch(() => {
      console.error(
        `Failed to preload materials from LDConfig.ldr. Check the ldraw filepath or URL and ensure it points to a valid LDraw library.`,
      );
    });
  }

  let ldrawGroup = await new Promise((resolve, reject) => {
    loader.parse(mpdText, resolve, reject);
  }).catch((error) => {
    console.error("Error parsing MPD content:", error);
    throw error;
  });

  return ldrawGroup;
}

/**
 * Optimizes an LDraw group by removing conditional lines.
 *
 * @param {THREE.Group} ldrawGroup - The LDraw group to optimize.
 * @returns {THREE.Group} - The optimized LDraw group.
 */
function optimizeLDrawGroup(ldrawGroup) {
  const conditionalLines = [];

  let optimizedGroup = ldrawGroup; // convert to InstancedMesh for better optimization results

  optimizedGroup.traverse((o) => {
    // Conditional lines are view-dependent in LDraw. GLTF has no equivalent,
    // and converting them to plain lines makes too many edges visible.
    if (
      o.isLineSegments &&
      o.material instanceof LDrawConditionalLineMaterial
    ) {
      conditionalLines.push(o);
    }
  });
  conditionalLines.forEach((o) => o.removeFromParent());

  return optimizedGroup;
}

/**
 *
 * @param {Document} document
 * @param {String} compressionType
 * @returns
 */
async function applyTransform(document, compressionType) {
  if (compressionType === "none") {
    return;
  }

  // See: https://gltf-transform.donmccurdy.com/functions.html
  let transform =
    compressionType === "meshopt"
      ? meshopt({ encoder: MeshoptEncoder, level: "high" })
      : draco({ method: "edgebreaker" });

  await document.transform(transform);
}

// ==================== CLI argument parsing ====================
function parseCLI(argv = process.argv) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      compress: {
        type: "string",
        short: "c",
        default: "meshopt",
      },
      ldraw: {
        type: "string",
        short: "l",
        default: "", // Empty string means "not provided"
      },
      output: {
        type: "string",
        short: "o",
        // No default - computed from input
      },
    },
    allowPositionals: true,
    strict: true,
  });

  // Validate compression mode
  if (!COMPRESSION_MODES.includes(values.compress)) {
    throw new Error(
      `Invalid --compress value: "${values.compress}". ` +
        `Allowed: ${COMPRESSION_MODES.join(", ")}`,
    );
  }

  // Validate ldraw URL (if provided)
  if (values.ldraw && !isValidLDrawUrl(values.ldraw)) {
    throw new Error(
      `Invalid --ldraw value: "${values.ldraw}". ` +
        `Must be http(s):// or file:// URL`,
    );
  }

  // Require exactly one positional argument (input path/URL)
  if (positionals.length === 0) {
    throw new Error("Missing required input: provide a file path or URL");
  }
  if (positionals.length > 1) {
    throw new Error(`Unexpected arguments: ${positionals.slice(1).join(", ")}`);
  }

  const input = positionals[0];
  const output = values.output ?? generateOutputName(input);

  return {
    input,
    output: resolveOutputPath(output),
    compress: values.compress,
    ldraw: values.ldraw || null, // Convert empty string to null
  };
}

function isValidLDrawUrl(url) {
  try {
    const parsed = new URL(url);
    return ["http:", "https:", "file:"].includes(parsed.protocol);
  } catch {
    return false;
  }
}

function generateOutputName(input) {
  // Handle URLs: extract filename from path
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const url = new URL(input);
    const filename = basename(url.pathname) || "model";
    return replaceExtension(filename, ".glb");
  }

  // Handle file paths
  const filename = basename(input);
  return replaceExtension(filename, ".glb");
}

function replaceExtension(filename, newExt) {
  const ext = extname(filename);
  if (ext) {
    return filename.slice(0, -ext.length) + newExt;
  }
  return filename + newExt;
}

function resolveOutputPath(output) {
  // Resolve relative paths to absolute
  if (!output.startsWith("http://") && !output.startsWith("https://")) {
    return resolve(output);
  }
  return output;
}

//////////////// Main CLI entry point
async function main() {
  let config;
  // Usage
  try {
    config = parseCLI();
    console.log("Parsed config:", config);

    // Example output:
    // {
    //   input: 'models/f1-car.mpd',
    //   output: '/absolute/path/to/f1-car.glb',
    //   compress: 'draco',
    //   ldraw: 'https://raw.githubusercontent...',
    // }
  } catch (error) {
    console.error(`Error: ${error.message}`);
    usage();
    process.exit(1);
  }

  const { input, output, compress, ldraw } = config;
  // Elapsed time measurement
  const startTime = Date.now();
  console.log(`Processing ${input}...`);

  // -- Load and prepare the LDraw model (ONLY for packed .mpd files) --
  const mpdContents = await fs.readFile(input, "utf8");
  let ldrawGroup = await ldrawMPDtoGroup(mpdContents, ldraw);
  ldrawGroup = optimizeLDrawGroup(ldrawGroup);

  // -- Convert to GLB --
  // Required rots and scales internally, if applied directly to ldrawGroup, it would cause issues with pieces outlines
  let exportedGlbBuf = await exportToGLB(ldrawGroup, 0.0004, Math.PI); // returns an ArrayBuffer

  const glbBuf = Buffer.from(exportedGlbBuf); // convert ArrayBuffer to Buffer

  // -- GLTF/GLB-Transform optimization pipeline --
  await MeshoptEncoder.ready; // initialize the WASM encoder

  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS) // TODO review which extensions are needed, not all of them!
    .registerDependencies({
      "meshopt.encoder": MeshoptEncoder,
      "draco3d.encoder": await draco3d.createEncoderModule(),
    });

  const document = await io.readBinary(glbBuf);

  await applyTransform(document, compress);

  // -- Write the optimized GLB back to disk --
  const optimizedBuf = await io.writeBinary(document); // serialize back to GLB

  await fs.writeFile(output, optimizedBuf);

  const endTime = Date.now();
  console.log(
    `Wrote ${output} (${optimizedBuf.length.toLocaleString()} bytes), elapsed time: ${(endTime - startTime) / 1000}s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
