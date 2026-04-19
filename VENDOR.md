# Vendored dependencies

This repo bundles `claude-max-api-proxy` under `vendor/claude-max-api-proxy/`
so installation works without an npm registry round-trip. The vendored tree
includes the package's `dist/`, `package.json`, `package-lock.json`, `LICENSE`,
`README.md`, and a pre-populated production `node_modules/`.

## Why vendor it?

- **Offline installable** — `git clone` is the only network call.
- **Reproducible** — every install on every machine runs identical code.
- **Resilient to upstream churn** — npm yanks, registry outages, and breaking
  releases can't break a fresh install of this bridge.

## Refreshing the vendored copy

When upstream `claude-max-api-proxy` ships a new version we want to ship:

```bash
cd vendor
rm -rf claude-max-api-proxy
npm pack claude-max-api-proxy@<NEW_VERSION>
tar -xf claude-max-api-proxy-*.tgz
mv package claude-max-api-proxy
rm claude-max-api-proxy-*.tgz
cd claude-max-api-proxy
npm install --omit=dev --no-audit --no-fund
```

Then re-run the smoke test:

```bash
cd ../..
./test/smoke.sh
```

If smoke passes, commit the diff and bump the bridge release tag.

## License compliance

`vendor/claude-max-api-proxy/LICENSE` is the upstream MIT license, preserved
verbatim. Do not modify it. The same applies to every transitive dependency's
LICENSE file inside `node_modules/`. Our top-level `NOTICE` cites both
upstream projects.
