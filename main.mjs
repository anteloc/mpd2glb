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

// ---------------------------------------------------------------------------
// Workaround for a three.js LDrawLoader submodel-resolution bug
//
// The LDraw standard says a submodel embedded in the .mpd as a "0 FILE" block
// always wins over a same-named file in the parts library.  LDrawLoader breaks
// that rule for sub-folder-qualified names:
//
//   * "0 FILE" blocks are cached under their RAW name, backslashes included
//     ("s\10179 - 33299s01.dat").
//   * type-1 references are NORMALIZED before the cache lookup: "\" becomes
//     "/", a leading "s/" becomes "parts/s/" and "48/" becomes "p/48/", giving
//     "parts/s/10179 - 33299s01.dat".
//
// The two keys never match, so the embedded block is ignored and the loader
// goes looking for a library part that does not exist, aborting the conversion.
//
// The fix registers the already-parsed embedded block under every key the
// reference resolver can produce.  Keys that already exist are left alone, so
// genuine library subparts (e.g. "s\47996s01.dat") keep resolving normally.
// ---------------------------------------------------------------------------
function patchEmbeddedFileResolution(loader) {
  const parseCache = loader.partsCache.parseCache;
  const origSetData = parseCache.setData.bind(parseCache);

  parseCache.setData = (fileName, text) => {
    origSetData(fileName, text);

    // The first "0 FILE" name is not trimmed by the loader, unlike references.
    const trimmed = fileName.trim();
    const normalized = trimmed.replace(/\\/g, "/");
    const aliases = new Set([trimmed, normalized]);

    if (normalized.startsWith("s/")) {
      aliases.add("parts/" + normalized);
    } else if (normalized.startsWith("48/")) {
      aliases.add("p/" + normalized);
    }

    // Sharing the parsed object is safe: getData() clones by default, and the
    // non-cloning callers only read metadata from it.
    const parsed = parseCache._cache[fileName.toLowerCase()];

    for (const alias of aliases) {
      const key = alias.toLowerCase();
      if (!(key in parseCache._cache)) {
        parseCache._cache[key] = parsed;
      }
    }
  };
}

// ---------------------------------------------------------------------------
// Tolerate subobjects that really cannot be resolved.
//
// A rejected fetch inside LDrawLoader propagates out of Promise.all and aborts
// the whole conversion, after printing one stack trace per occurrence.  Resolve
// with empty LDraw content instead: the part becomes an empty group, the rest
// of the model still converts, and every distinct missing name is collected so
// a single summary can be reported afterwards.
//
// @returns {Set<string>} the names that could not be resolved, filled in as
//   parsing progresses.
// ---------------------------------------------------------------------------
function patchMissingSubobjectHandling(loader) {
  const parseCache = loader.partsCache.parseCache;
  const origFetchData = parseCache.fetchData.bind(parseCache);
  const missing = new Set();

  parseCache.fetchData = async (fileName) => {
    try {
      return await origFetchData(fileName);
    } catch {
      missing.add(fileName);
      return "";
    }
  };

  return missing;
}

// ---------------------------------------------------------------------------
// Colour remapping (--map-color <from>,<to>)
//
// Both sides accept either an LDraw colour code or a colour name as defined by
// the "0 !COLOUR <name> CODE <code> ..." directives of LDConfig.ldr.  Names are
// matched case-insensitively and spaces are interchangeable with underscores,
// so "Dark_pink", "dark pink" and "DARK_PINK" all resolve to code 5.
//
// The mapping is applied to the parsed scene rather than to the colour table,
// so it works both with a preloaded LDConfig.ldr and with packed models that
// carry their own "0 !COLOUR" definitions: by the time parsing is done, every
// colour the model uses is present in the loader's material library.
// ---------------------------------------------------------------------------

/**
 * Splits a raw "<from>,<to>" CLI value into its two colour tokens.
 *
 * @param {string[]} specs - Raw --map-color values, in command-line order.
 * @returns {Array<{from: string, to: string}>}
 */
function parseColorMappingSpecs(specs) {
  return specs.map((spec) => {
    const parts = spec.split(",").map((part) => part.trim());

    if (parts.length !== 2 || parts.some((part) => part === "")) {
      throw new Error(
        `Invalid --map-color value: "${spec}". Expected <from>,<to>, ` +
          `e.g. Green,Dark_Pink or 16,26`,
      );
    }

    return { from: parts[0], to: parts[1] };
  });
}

/**
 * Resolves a colour code or colour name to its LDraw colour code.
 *
 * @param {string} token - Colour code or colour name.
 * @param {LDrawLoader} loader - Loader holding the populated material library.
 * @returns {?string} The colour code, or null if the colour is unknown.
 */
function resolveColorToken(token, loader) {
  if (/^\d+$/.test(token)) {
    return loader.getMaterial(token) ? token : null;
  }

  const normalize = (name) => name.trim().toLowerCase().replace(/[\s_]+/g, "_");
  const wanted = normalize(token);
  const material = loader.materials.find((m) => normalize(m.name) === wanted);

  return material ? material.userData.code : null;
}

/**
 * Replaces the materials of every mesh and line whose colour code appears on
 * the left-hand side of a --map-color option.
 *
 * Replacing the material reference (instead of recolouring it in place) keeps
 * the exported GLB tidy: the remapped geometry shares the single, correctly
 * named material of the target colour, and chained mappings such as
 * "--map-color 2,5 --map-color 5,4" stay independent of each other.
 *
 * @param {THREE.Object3D} root - The parsed LDraw scene.
 * @param {Array<{from: string, to: string}>} mappings - Colour mappings.
 * @param {LDrawLoader} loader - Loader holding the populated material library.
 */
function applyColorMappings(root, mappings, loader) {
  const unknown = [];
  const byCode = new Map();

  for (const { from, to } of mappings) {
    const fromCode = resolveColorToken(from, loader);
    const toCode = resolveColorToken(to, loader);

    if (fromCode === null) unknown.push(from);
    if (toCode === null) unknown.push(to);
    if (fromCode !== null && toCode !== null) {
      byCode.set(fromCode, loader.getMaterial(toCode));
    }
  }

  if (unknown.length > 0) {
    throw new Error(
      `Unknown LDraw colour(s): ${unknown.join(", ")}. ` +
        `Use a colour code or a colour name from LDConfig.ldr` +
        `${loader.materials.length === 0 ? " (hint: pass -l <ldraw library> so the colour table is loaded)" : ""}`,
    );
  }

  // Meshes hold face materials, LineSegments hold the edge variants; both carry
  // the same userData.code, so the target variant is picked the same way the
  // loader itself does it in applyMaterialsToMesh().
  const mapMaterial = (object, material) => {
    const target = byCode.get(material?.userData?.code);
    if (!target) return material;

    if (!object.isLineSegments) return target;

    const edgeMaterial = loader.edgeMaterialCache.get(target);
    if (!edgeMaterial) return material;

    if (!object.isConditionalLine) return edgeMaterial;

    return loader.conditionalEdgeMaterialCache.get(edgeMaterial) ?? material;
  };

  let remapped = 0;

  root.traverse((object) => {
    if (!object.material) return;

    if (Array.isArray(object.material)) {
      object.material = object.material.map((material) => {
        const mapped = mapMaterial(object, material);
        if (mapped !== material) remapped++;
        return mapped;
      });
    } else {
      const mapped = mapMaterial(object, object.material);
      if (mapped !== object.material) remapped++;
      object.material = mapped;
    }
  });

  if (remapped === 0) {
    console.warn(
      `Warning: --map-color matched no geometry, the model does not use ` +
        `colour(s): ${mappings.map((m) => m.from).join(", ")}`,
    );
  }
}

/**
 * Prints usage instructions to the console.
 */
function usage() {
  const helpText = `
  Usage: node main.mjs [options] <input.mpd>
  Converts an LDraw MPD file to an optimized GLTF .glb file. The output filename is derived from the input if not provided.
  
  Options:
    -h, --help              Show this help message and exit
    -c, --compress <mode>   draco|meshopt|none (default: draco)
    -l, --ldraw <path>      Library path: http(s)://, file://, or a local directory path
    -o, --output <file>     Output filename (default: <input>.glb)
        --map-color <a>,<b> Replace LDraw colour <a> by colour <b> in the output.
                            Each side is a colour code or a colour name from
                            LDConfig.ldr (case-insensitive, spaces = underscores).
                            May be given several times.
    <input.mpd>             Input LDraw MPD file path or URL (required)

  Examples:

    # fully local: ldraw lib and model
    node main.mjs -c draco -o 10129-1.glb -l path/to/ldraw path/to/models/10129-1.mpd

    # mixed: ldraw lib (local) and model (remote)
    node main.mjs -c draco -o 10129-1.glb -l https://raw.githubusercontent.com/anteloc/ldraw-lib/master/models/10129-1.mpd

    # fully remote: ldraw lib and model
    node main.mjs -c meshopt -o 10129-1.glb -l https://raw.githubusercontent.com/anteloc/ldraw-lib/master/ldraw  https://raw.githubusercontent.com/anteloc/ldraw-lib/master/models/10129-1.mpd

    # packed model: no ldraw lib required
    node main.mjs -c meshopt -o some-model.glb path/to/models/some-model-packed.mpd

    # recolour: by name, by code, or mixed, repeatable
    node main.mjs -l path/to/ldraw --map-color Green,Dark_Pink -c draco -o prop.glb models/55300.dat
    node main.mjs -l path/to/ldraw --map-color 16,26 -c draco -o prop.glb models/55300.dat
    node main.mjs -l path/to/ldraw --map-color 16,Dark_Pink --map-color Red,4 -c draco -o prop.glb models/55300.dat
    `
  ;
  console.error(helpText);
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
 * @param {Array<{from: string, to: string}>} colorMappings - Optional colour remappings.
 * @returns {Promise<THREE.Group>} - Resolves with a THREE.Group containing the parsed LDraw model.
 */
async function ldrawMPDtoGroup(mpdText, ldrawLibrary, colorMappings = []) {
  const loader = new LDrawLoader();

  // Embedded "0 FILE" submodels must win over the parts library, see above
  patchEmbeddedFileResolution(loader);
  const missingSubobjects = patchMissingSubobjectHandling(loader);

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

  if (missingSubobjects.size > 0) {
    console.warn(
      `Warning: ${missingSubobjects.size} subobject(s) could not be resolved, ` +
        `the converted model may be incomplete:`,
    );
    for (const fileName of [...missingSubobjects].sort()) {
      console.warn(`  - ${fileName}`);
    }
  }

  if (colorMappings.length > 0) {
    applyColorMappings(ldrawGroup, colorMappings, loader);
  }

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
/**
 * Parses command-line arguments.
 * @param {string[]} argv - The command-line arguments (default: process.argv).
 * @returns {Object} The parsed arguments.
 */
function parseCLI(argv = process.argv) {
  const { values, positionals } = parseArgs({
    args: argv.slice(2),
    options: {
      help: {
        type: "boolean",
        short: "h",
        default: false,
      },
      compress: {
        type: "string",
        short: "c",
        default: "draco",
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
      "map-color": {
        type: "string",
        multiple: true,
        default: [],
      },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    usage();
    process.exit(0);
  }

  // Validate compression mode
  if (!COMPRESSION_MODES.includes(values.compress)) {
    throw new Error(
      `Invalid --compress value: "${values.compress}". ` +
        `Allowed: ${COMPRESSION_MODES.join(", ")}`,
    );
  }

  // Normalize ldraw path/URL (if provided)
  if (values.ldraw) {
    values.ldraw = normalizeLDrawPath(values.ldraw);
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
    colorMappings: parseColorMappingSpecs(values["map-color"]),
  };
}

/**
 * Normalizes a --ldraw value to a URL string with a trailing slash.
 * Accepts http(s):// and file:// URLs, or a local filesystem path.
 */
function normalizeLDrawPath(ldraw) {
  let normalized;
  try {
    const parsed = new URL(ldraw);
    if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
      throw new Error(`Unsupported protocol: ${parsed.protocol}`);
    }
    normalized = ldraw;
  } catch {
    // Not a URL — treat as a local filesystem path
    normalized = pathToFileURL(resolve(ldraw)).href;
  }
  if (!normalized.endsWith("/")) normalized += "/";
  return normalized;
}

/**
 * Reads text from a local path, file:// URL, or http(s):// URL.
 */
async function readTextFile(input) {
  if (input.startsWith("file://")) {
    return fs.readFile(new URL(input).pathname, "utf8");
  }
  if (input.startsWith("http://") || input.startsWith("https://")) {
    const res = await fetch(input);
    if (!res.ok)
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${input}`);
    return res.text();
  }
  return fs.readFile(input, "utf8");
}

function generateOutputName(input) {
  // Handle URLs: extract filename from the URL path
  if (/^(https?|file):\/\//.test(input)) {
    const url = new URL(input);
    const filename = basename(url.pathname) || "model";
    return replaceExtension(filename, ".glb");
  }

  // Handle local file paths
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

//////////////// Main CLI entry point ////////////////
async function main() {
  let config;

  try {
    config = parseCLI();
  } catch (error) {
    console.error(`Error: ${error.message}`);
    usage();
    process.exit(1);
  }

  const { input, output, compress, ldraw, colorMappings } = config;

  // Elapsed time measurement
  const startTime = Date.now();
  
  console.log(`Processing: ${input}...`);

  // -- Load and prepare the LDraw model (ONLY for packed .mpd files) --
  const mpdContents = await readTextFile(input);
  let ldrawGroup = await ldrawMPDtoGroup(mpdContents, ldraw, colorMappings);
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
