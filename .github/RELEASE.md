# Releasing mpd2glb

Pushing a `vX.Y.Z` Git tag creates the matching GitHub Release automatically.
The workflow builds the CLI, verifies it with Node.js and Bun, and attaches
`.zip` and `.tar.gz` archives plus `SHA256SUMS.txt`.

## One-time repository setup

GitHub Actions must be allowed to create releases. In the repository settings,
open **Actions → General → Workflow permissions** and select **Read and write
permissions**. The workflow uses the repository's built-in `GITHUB_TOKEN`; no
personal access token or GitHub secret is needed.

## Release checklist

1. Start from an up-to-date release branch and make sure the worktree is clean.
2. Choose the next [semantic version](https://semver.org/), for example
   `0.3.1`. Edit the single `version` field in `package.json` to that value.
   The version has no `v` prefix.
3. Update `README.md` or release notes if the user-facing behavior changed.
   `package-lock.json` is committed so dependency changes are reviewed and the
   build is reproducible; update it with `npm install` when dependencies change.
4. Run the same checks the release workflow will run:

   ```bash
   npm ci
   npm run build
   node mpd2glb.mjs --help
   bun mpd2glb.mjs --help
   ```

   This requires Node.js **24.11.0+** and Bun **1.3.10+**. Node is required to
   make a release; Bun is required only for the optional Bun smoke test.
5. Commit the version, lockfile, documentation, and code changes. Push the
   commit to GitHub.
6. Create and push an annotated tag whose name exactly matches the package
   version with a `v` prefix:

   ```bash
   git tag -a v0.3.1 -m "Release v0.3.1"
   git push origin v0.3.1
   ```

7. Open the **Actions** tab and wait for the **Release** workflow to finish.
   Its generated GitHub Release will contain `mpd2glb-0.3.1.zip`,
   `mpd2glb-0.3.1.tar.gz`, and `SHA256SUMS.txt`.

## Guardrails and recovery

- The workflow refuses tags that are not `vX.Y.Z` semantic versions, and it
  refuses a tag whose version differs from `package.json`. Correct the mismatch
  in a new commit, move or recreate the tag deliberately, then push it again.
- It does **not** publish to npm. GitHub Release assets are the distribution
  channel.
- Archives intentionally omit `node_modules`, because native dependencies are
  platform-specific. They include `package-lock.json`; release users run
  `npm ci --omit=dev` (or `bun install --production`) after extracting them.
- Re-running the workflow for an existing tag replaces that release's assets
  only. It does not create duplicate releases.

## When changing supported runtimes

Keep these locations in sync: `package.json` (`engines.node` and
`engines.bun`), the prerequisite text in `README.md`, the setup action versions in
`.github/workflows/release.yml`, and the versions in this document.
