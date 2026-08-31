/**
 * Regenerate contract-manifest.json (the committed snapshot CI checks).
 * Run after any deliberate contract change, together with a
 * toolContractVersion bump when the change is not purely additive.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  canonicalStringify,
  contractHash,
  contractManifestObject,
} from "./hash.ts";
import { TOOL_CONTRACT_VERSION } from "./versions.ts";

const outPath = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "contract-manifest.json",
);
const hash = await contractHash();
writeFileSync(
  outPath,
  JSON.stringify(
    {
      toolContractVersion: TOOL_CONTRACT_VERSION,
      sha256: hash,
      manifest: JSON.parse(canonicalStringify(contractManifestObject())),
    },
    null,
    2,
  ) + "\n",
);
console.log(`contract-manifest.json written (v${TOOL_CONTRACT_VERSION}, ${hash})`);
