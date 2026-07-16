# Changesets

Release flow (single-branch, adapted from anchorage's two-branch setup):

1. Every PR that changes a published package (`@understudy/protocol`,
   `@understudy/connector`) adds a changeset: `pnpm changeset`.
2. On push to `master`, `.github/workflows/release.yml` either opens/updates
   the standing "Version Packages" PR (when changesets are pending) or
   publishes any package whose version is not yet on npm (when none are).
3. Merging the Version Packages PR is the release trigger.

The apps (`apps/backend`, `apps/extension`) are `private: true` and never
publish. Docs: https://github.com/changesets/changesets
