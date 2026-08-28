# ZotFlow Enhancement Pack

ZotFlow Enhancement Pack is an optional companion plugin that supplies the
large, offline resources required by ZotFlow reading features such as
Structured Document Text generation.

The resource binaries are not tracked in Git. `npm run build` downloads the
exact Document Worker archive pinned by `document-worker.lock.json`, verifies
the archive and every selected resource, and embeds gzip/base64 data into the
released `main.js`.

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
Pack API version changes stop the workflow and require an explicit interface
migration followed by a manual major release.

## Runtime contract

When enabled, the plugin registers its API at
`window.__zotflowEnhancementPackV1`. The API exposes compatibility metadata
and gzip/base64 resource payloads. It performs no runtime downloads.
