# Security policy

## Scope

Even when it receives untrusted data and untrusted predicates or queries, fusenduck aims to uphold the following.

- It reads no file other than the ones allowed, and writes nowhere (read-only).
- The MCP server and `fusen resolve` do not open files outside `--root` (a Ref carries its own file location, so this matters). The Web UI also does not open files outside `--root`. `fusen card`, `peek` and `ref` open whatever path the person at the keyboard gives them.
- Text hidden in the data does not reach the agent as a tool description or an error message.
- The MCP HTTP server does not answer anyone outside loopback, or anyone without the right token.
- The Web UI server (`fusen-web`) does not answer anyone outside loopback, anyone without the token, or a page from another origin. Cell values do not run as script in the page.

If you find a way to break any of these, a path by which a secret value leaks into output or logs, an input that exhausts resources, or anything similar, please report it.

## How to report

**Please do not write about it in a public issue or pull request.**

Use GitHub's private vulnerability reporting: the repository's **Security** tab → **Report a vulnerability** (<https://github.com/zwire/fusenduck/security/advisories/new>).

In your report, include the steps to reproduce (ideally how to build a small Parquet file, and the commands), what you expected and what actually happened, and the OS, Node and fusenduck commit you used.

We will reply within 7 days of receiving a report, and then discuss the fix and the timing of disclosure with you.

## Supported versions

There has been no release yet. Only the latest commit on `main` is covered.
