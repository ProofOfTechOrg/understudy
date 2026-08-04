<!-- Content type: How-to -->

# Release packages with Changesets

Understudy versions published packages on `dev` and publishes them from `master`.

1. Target feature and fix pull requests at `dev`. Add a changeset with `pnpm changeset` when a pull request changes `@understudy/protocol` or `@understudy/connector`.
2. Merge the pull request into `dev`. `.github/workflows/version.yml` opens or updates `changeset-release/dev` with version bumps, changelog entries, and consumed changesets.
3. Review and merge the `Version Packages` pull request into `dev`.
4. Verify the versioned `dev` commit, then immediately open and merge a promotion pull request from `dev` to `master`.
5. `.github/workflows/release.yml` publishes unpublished public package versions with npm provenance, tags them, and creates GitHub releases.

If another changeset reaches `dev` before promotion, merge the regenerated `Version Packages` pull request and update the promotion. The release workflow rejects pending changesets on `master`.

Do not merge `master` back into `dev`. The apps in `apps/backend` and `apps/extension` are private, versioned directly in their manifests, and excluded from Changesets versioning and publishing. Read the [Changesets documentation](https://github.com/changesets/changesets) for CLI details.
