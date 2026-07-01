# @getbourdon/conformance

## 0.2.0

### Minor Changes

- 821638d: Publish `@getbourdon/conformance` and expand the participant reader set.

  - **`@getbourdon/conformance` goes public** with the parity fixtures bundled into
    the package. `conformanceDir()` now resolves `BOURDON_CONFORMANCE_DIR` → the
    bundled snapshot → a sibling oracle checkout, so an installed consumer is
    self-contained (previously it read a sibling Python checkout at runtime and was
    unusable once published). Fixtures are refreshed from the oracle by
    `sync-fixtures` (run in the release workflow before publish).
  - **New participant readers**: `cursor`, `copilot`, `copilot-cli`, `cascade`, and
    the quarantined-class `openclaw` (network reader with a CVE handshake gate).
    Adds the `quarantinedClass` marker to the `BourdonParticipant` contract; the
    CLI risk gate (`bourdon agent add/set-tier`) reads it to require
    `--i-understand-the-risk` for trusted registration of openclaw.
