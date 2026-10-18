---
id: release
title: Release
phase: extract
lifecycle: hardened
kind: work
writes: [${docs}, ${config}]
checks:
  - ${smoke-install}
irreversible:
  - ${make-public}
  - ${publish-npm}
  - ${publish-ext}
  - ${push-tags}
exits:
  - to: end
    when: the stable release is installed from the registry and the smoke install passed
    on: pass
  - to: bug-fix
    when: the smoke install failed after publishing
    on: fail
---

# Release

## Purpose

Publish the verified candidate to the channels the user picks, pre-release first, then stable, and show that what the registry serves works from an empty directory. Everything published here cannot be unpublished.

## Parameters

- Candidates for channels: the npm registry for the packages, the Open VSX registry for the extension, the GitHub release page. The user decides at the first gate, after seeing the result.
- Order: pre-release (`next` tag, pre-release channel), smoke install, stable (`latest` tag, stable channel), tags.

## Steps

1. Confirm the release report under `${docs}` has a go verdict for the exact commit at the head of `${trunk}` and that CI on it is green.
2. Run `${version}` to apply the changesets; read the version bumps and changelog entries, and match every breaking entry to the `${contract-check}` diff in the report.
3. Run `${pack-dry-run}` and read each package's file list and size once more.
4. [human-gate] The user chooses the channels, approves the exact package names and versions, and approves publishing the pre-release (and making the repository public if it is still private).
5. [irreversible] If the repository is still private, run `${make-public}`.
6. [irreversible] Publish the pre-release packages with `${publish-npm} --tag next`.
7. [irreversible] If the extension is included, publish its pre-release with `${publish-ext} --channel prerelease`.
8. Run `${smoke-install}` against the pre-release in an empty directory and keep the output.
9. [human-gate] The user approves widening to stable, with the smoke output in front of them.
10. [irreversible] Promote with `${publish-npm} --tag latest`, and with `${publish-ext} --channel stable` when the extension is included.
11. [irreversible] Push the release commit and tags with `${push-tags}`.
12. Record the published names, versions and registry pages in the release report.

## Done when

- `${smoke-install}` passes against the stable release from the registry, and the release report lists every published package with its version and registry page.

## Reply with

- What was published where, the smoke output, and any follow-up. A bad stable release is withdrawn by a patch release through `bug-fix`; deprecating a version is the user's decision.
