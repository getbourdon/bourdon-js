# Changesets

This folder manages versioning + changelogs for the `@getbourdon/*` packages.

## Releasing (via Trusted Publishing — no token)

1. Add a changeset describing your changes:
   ```bash
   pnpm changeset          # pick the packages + bump type (patch/minor/major), write a summary
   ```
2. When ready to release, apply the bumps + changelogs:
   ```bash
   pnpm version-packages   # = changeset version (updates versions + CHANGELOG.md)
   git commit -am "release: version packages"
   ```
3. Tag and push — this fires `.github/workflows/release.yml`, which publishes the
   bumped packages to npm via **OIDC Trusted Publishing** (no `NPM_TOKEN`, with provenance):
   ```bash
   git tag v$(node -p "require('./packages/recognition/package.json').version")
   git push origin main --tags
   ```

`@getbourdon/conformance` is ignored (private until its fixtures are bundled).

> One-time: configure the Trusted Publisher on npmjs.com per package
> (owner `getbourdon`, repo `bourdon-js`, workflow `release.yml`, environment `npm-publish`),
> and make the repo public so the Sigstore provenance attestation can be generated.
