#!/usr/bin/env node
// Encrypted, off-device backup of a project's keys (house rule: keys live in ~/.secrets/<project>/; the Private Keys
// copy sits on the same SSD, so it does not survive a failed disk). The owner runs this and types the passphrase;
// nothing here sees or stores it.
//
//   node ops/backup-keys.mjs <destination folder> [--project orrery] [--match mainnet-]
//
// Packs ~/.secrets/<project>/<match>*.json into a tar, encrypts it with GnuPG symmetric AES-256 (the owner types the
// passphrase twice in gpg's own prompt), writes <destination>/<project>-keys-<date>.tar.gpg plus a .sha256 of the
// encrypted file, then decrypts it once (gpg asks for the passphrase again unless its agent still holds it) and checks
// every file byte for byte against the originals. The destination should be a removable drive or a synced cloud folder,
// not this laptop's disk; the script warns when it is.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const opt = (n, d) => {
  const i = args.indexOf(n);
  return i >= 0 ? args[i + 1] : d;
};
const dest = args.find((a, i) => !a.startsWith("--") && !["--project", "--match"].includes(args[i - 1]));
const project = opt("--project", "orrery");
const match = opt("--match", "mainnet-");
if (!dest) {
  console.error("usage: node ops/backup-keys.mjs <destination folder> [--project orrery] [--match mainnet-]");
  process.exit(1);
}
const src = join(homedir(), ".secrets", project);
const files = readdirSync(src).filter((f) => f.startsWith(match) && f.endsWith(".json")).sort();
if (!files.length) {
  console.error(`no ${match}*.json in ${src}`);
  process.exit(1);
}
const out = resolve(dest);
if (!existsSync(out) || !statSync(out).isDirectory()) {
  console.error(`${out} is not a folder`);
  process.exit(1);
}
// Same device as the home folder means the backup dies with this disk.
if (statSync(out).dev === statSync(homedir()).dev || out.startsWith("/mnt/shared") || out.startsWith("/mnt/data")) {
  console.warn(`warning: ${out} is on this laptop's disks; use a removable drive or a cloud-synced folder for an off-device copy`);
}
const sha = (b) => createHash("sha256").update(b).digest("hex");
const stamp = new Date().toISOString().slice(0, 10);
const target = join(out, `${project}-keys-${stamp}.tar.gpg`);
console.log(`packing ${files.length} files from ${src}: ${files.join(", ")}`);

const tar = spawnSync("tar", ["-C", src, "-cf", "-", ...files], { maxBuffer: 64 * 1024 * 1024 });
if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
console.log("gpg will ask for the passphrase twice. Use a long one and keep it apart from the backup.");
const enc = spawnSync("gpg", ["--symmetric", "--cipher-algo", "AES256", "--s2k-mode", "3", "--s2k-digest-algo", "SHA512", "--s2k-count", "65011712", "--output", target], {
  input: tar.stdout,
  stdio: ["pipe", "inherit", "inherit"],
});
if (enc.status !== 0) throw new Error("gpg did not finish; nothing was written");
writeFileSync(`${target}.sha256`, `${sha(readFileSync(target))}  ${target.split("/").pop()}\n`);

// Prove the backup opens and holds the same bytes.
const work = mkdtempSync(join(tmpdir(), "keys-verify-"));
try {
  const dec = spawnSync("gpg", ["--decrypt", target], { stdio: ["inherit", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  if (dec.status !== 0) throw new Error("the backup did not decrypt; do not rely on it");
  const untar = spawnSync("tar", ["-C", work, "-xf", "-"], { input: dec.stdout });
  if (untar.status !== 0) throw new Error("the decrypted backup is not a valid tar");
  for (const f of files) {
    if (sha(readFileSync(join(work, f))) !== sha(readFileSync(join(src, f)))) throw new Error(`${f} differs after decrypting`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
console.log(`backup ok: ${target} (${files.length} files checked byte for byte after decrypting), checksum in ${target}.sha256`);
console.log("Restore: gpg --decrypt <file> | tar -xf - -C ~/.secrets/<project>/   (then chmod 600 each file)");
