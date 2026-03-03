import fs from "node:fs/promises";
import * as THREE from 'three';
import { LDrawLoader } from "three/addons/loaders/LDrawLoader.js";
import { LDrawConditionalLineMaterial } from "three/addons/materials/LDrawConditionalLineMaterial.js";
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { NodeIO } from "@gltf-transform/core";
import { MeshoptEncoder } from "meshoptimizer"; // WASM, no external binary needed
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import {
  meshopt,
} from "@gltf-transform/functions";

import { Blob, FileReader } from "vblob";

globalThis.Blob = Blob;
globalThis.FileReader = FileReader;

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
        mimeType: 'image/png',
        animations: collectAnimations(object),
        includeCustomExtensions: false,
      }
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
          new THREE.BufferAttribute(new Float32Array(attr.array), attr.itemSize)
        );
      }
    }

    // Uint32 → Uint16 when safe
    if (geo.index && geo.index.array instanceof Uint32Array) {
      const vertexCount = geo.attributes.position?.count ?? 0;
      if (vertexCount <= 65535) {
        geo.setIndex(
          new THREE.BufferAttribute(new Uint16Array(geo.index.array), 1)
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
 * @returns {Promise<THREE.Group>} - Resolves with a THREE.Group containing the parsed LDraw model.
 */
async function ldrawMPDtoGroup(mpdText) {
  const loader = new LDrawLoader();

  // Required in recent three.js if the model uses conditional lines
  loader.setConditionalLineMaterial(LDrawConditionalLineMaterial);

  let ldrawGroup = await new Promise((resolve, reject) => {
    loader.parse(mpdText, resolve, reject);
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

//////////////// Main CLI entry point
async function main() {
  const [, , inFile, outFile] = process.argv;

  if (!inFile || !outFile) {
    console.error("Usage: node main.mjs input.mpd output.glb");
    console.error("Example: node main.mjs models/f1-car-packed.mpd output/f1-car.glb");
    console.error("- input.mpd: a packed LDraw MPD model (unpacked files with external references are not supported yet)");
    console.error("- output.glb: the resulting optimized GLB model, meshopt-compressed (Draco not supported yet)");
    process.exit(1);
  }

  // Elapsed time measurement
  const startTime = Date.now();
  console.log(`Processing ${inFile}...`);

  // -- Load and prepare the LDraw model (ONLY for packed .mpd files) --
  const mpdContents = await fs.readFile(inFile, "utf8");
  let ldrawGroup = await ldrawMPDtoGroup(mpdContents);
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
    });

  const document = await io.readBinary(glbBuf);

  // See: https://gltf-transform.donmccurdy.com/functions.html
  await document.transform(
    meshopt({
      //TODO this drastically reduces file size but causes some viewers to fail loading the model, e.g. Blender, investigate further, maybe switch to Draco compression instead?
      encoder: MeshoptEncoder,
      level: "high",
    }),
  );

  // -- Write the optimized GLB back to disk --
  const optimizedBuf = await io.writeBinary(document); // serialize back to GLB

  await fs.writeFile(outFile, optimizedBuf);

  const endTime = Date.now();
  console.log(
    `Wrote ${outFile} (${optimizedBuf.length.toLocaleString()} bytes), elapsed time: ${(endTime - startTime) / 1000}s`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
