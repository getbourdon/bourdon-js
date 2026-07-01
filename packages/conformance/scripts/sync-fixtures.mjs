// Refresh the vendored conformance fixtures from the Python oracle.
//
// The published @getbourdon/conformance package ships a self-contained snapshot
// of the oracle's fixtures under ./fixtures. This script copies them from the
// oracle checkout (BOURDON_CONFORMANCE_DIR, else a sibling getbourdon/bourdon
// clone). Run it whenever the oracle regenerates fixtures, and in the release
// workflow before publish, so the tarball is never stale.
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  process.env.BOURDON_CONFORMANCE_DIR,
  // sibling clone: <parent>/bourdon/conformance next to bourdon-js/
  resolve(pkgDir, "..", "..", "..", "bourdon", "conformance"),
].filter(Boolean);

const src = candidates.find((d) => existsSync(resolve(d, "manifest.json")));
if (!src) {
  console.error(
    "sync-fixtures: no oracle conformance dir found.\n" +
      "  Set BOURDON_CONFORMANCE_DIR, or check out getbourdon/bourdon as a sibling of bourdon-js.\n" +
      `  Looked in: ${candidates.join(", ")}`,
  );
  process.exit(1);
}

const dest = resolve(pkgDir, "fixtures");
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });
cpSync(src, dest, { recursive: true });
console.log(`sync-fixtures: copied ${src} -> ${dest}`);
