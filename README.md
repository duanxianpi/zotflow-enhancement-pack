# ZotFlow Enhancement Pack

ZotFlow Enhancement Pack is an optional companion plugin that supplies the
large, offline resources required by ZotFlow reading features such as
Structured Document Text generation.

The resource binaries are not tracked in Git. `npm run build` downloads the
exact Document Worker archive pinned by `document-worker.lock.json`, verifies
the downloaded archive, and appends the gzip/base64 data to
the released `main.js` as a marked comment trailer. The trailer includes a self-describing JSON resource directory and a fixed
112-byte v2 footer. The executable entry only tells users the Pack can remain
disabled; it contains no resource API or resource index.

## Development

```bash
npm install
npm run build
```

Downloaded archives and extracted resources are stored under `.cache/` and are
ignored by Git.

To synchronize from a ZotFlow checkout without changing the Pack version:

```bash
npm run sync:document-worker -- \
  --zotflow-lock ../document-worker.lock.json \
  --zotflow-commit local \
  --bump none
```

In CI, ZotFlow sends a `document-worker-updated` repository dispatch event.
The Pack workflow downloads the lock from that exact ZotFlow commit, performs
a minor version bump when the compatibility target changed, verifies a clean
build, and opens a pull request.

Document Worker/resource changes are eligible for the automatic minor bump.
Only the current offline protocol is accepted. Unsupported
contracts stop the workflow. `sync` compares resource paths, sizes and existing
content digests, plus SDT output versions, against the source lock. Manual workflow
refs are resolved to an immutable ZotFlow commit before downloading the lock.

## Runtime contract

Install the Pack and keep it **disabled**. ZotFlow reads the installed
main.js through the vault adapter when an SDT resource is first needed. It
never enables or executes the Pack plugin to access its resources.

ZotFlow validates the v2 directory and exact Document Worker compatibility,
snapshots the compressed component, and decompresses requested resources in a
service inside its existing ZotFlow Worker, exposed through its existing Comlink bridge.
Document Worker consumers read the cached Blobs locally; the main thread creates
URLs only for consumers that need them. ZotFlow releases resources after their consumers
end. Updates never replace resources inside an existing Worker session.
There are no runtime downloads and no global registry.

The Pack version (currently 2.0.0) is separate from protocol 2.0 and the generated
document's SDT pack/schema versions. The Pack and
ZotFlow are developed and released against this single resource contract.

## Build and release verification

`npm run build` prepares pinned inputs, builds the offline container,
then runs `verify:pack` and `test:protocol`. All selected resources are read
back from the final main.js and checked against the lock before provenance
attestation or Draft Release creation. Release artifacts and the existing
manifest-version trigger are unchanged.

Only ZIP downloads/cache reads and final resource verification scan binary
contents for integrity. Extracted cache preparation checks file existence and
size; packaging checks size. The single `postbuild` verification hashes each
decoded resource against its pinned digest. A same-size damaged cache therefore
fails final verification; regenerate the affected extracted cache before rebuilding.
Watch builds verify each output themselves.

The protocol uses three digest types: archive SHA-256 (build only), per-resource
SHA-256, and directory SHA-256 (also the runtime generation ID). It has no lock-file
or resource-list digest. ZotFlow compares resource metadata directly with its
pinned list and verifies each requested resource once, without a second CRC32
pass. With eight resources, a cached production build computes 10 SHA-256 digests
(excluding tests); initial runtime use of all resources computes nine.

The startup probe helper is a development experiment. Its generated probe
files intentionally contain filler, not a valid resource package, and must
not be published as release artifacts.
