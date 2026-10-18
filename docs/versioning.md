# Versioning and releases

faztudo has one release version, and several smaller version numbers for the
things other programs depend on. Each moves on its own rules.

## Release version

Releases follow [Semantic Versioning](https://semver.org/): `vMAJOR.MINOR.PATCH`.

- Before 1.0, a minor release (`v0.3.0` to `v0.4.0`) may change behavior or
  formats; the CHANGELOG says what and how to move over. Patch releases
  (`v0.3.1`) only fix things.
- From 1.0 on, breaking changes need a major release.
- Pre-releases use a suffix: `v0.2.0-rc.1`. They are marked as pre-releases
  on GitHub.
- The first tagged release is `v0.1.0`, the usable alpha at milestone M2.
  Until then builds report `dev` plus the commit they came from.

`faztudo version` prints the version, the commit and the build date, and
`faztudo version --json` gives the same as JSON. The API reports it at
`GET /api/v1/health`. Builds made with `go build` or `go install` still know
their commit, because the Go toolchain records it.

## Contract versions

| what | where the version lives | rule |
| :--- | :--- | :--- |
| HTTP and WebSocket API | the path, `/api/v1` | additive changes (new fields, endpoints, event types) keep `v1`; removing or changing the meaning of a field needs `/api/v2`, with `v1` kept for at least one minor release |
| event payloads | `version` on every event | a payload change that old readers would misread bumps that event type's version; readers handle every version still in the log |
| database | numbered migrations in `internal/store/migrations/` | migrations only move forward, run at startup inside a transaction, and never edit an already released migration; take a copy of the data file before upgrading across a minor release |
| config files | `config.toml`, `lanes.toml` | unknown keys are an error with the key named; renamed keys are accepted with a warning for one minor release |
| bridge protocol | `protocol` field in the bridge handshake | same rule as the API |

## Making a release

1. Make sure `main` is green and `make check` passes locally.
2. Move the `## [Unreleased]` entries in `CHANGELOG.md` under a new
   `## [X.Y.Z] - YYYY-MM-DD` heading, commit as a person, push.
3. Tag and push: `git tag -a vX.Y.Z -m "faztudo X.Y.Z" && git push origin vX.Y.Z`.
4. The release workflow builds Linux binaries (amd64, arm64), a tarball, a deb
   package and checksums with GoReleaser, using the CHANGELOG
   section as the notes, and opens a draft release.
5. Read the draft, try the binary, then publish it.

Nothing in this process creates commits; tags and releases are made by the
maintainer.
