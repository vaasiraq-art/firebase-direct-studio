# Security

Firebase Direct Studio is a tool for one Windows user working with trusted local projects. It is not a sandbox, a shared hosting administration service, or a guarantee that imported application code is secure.

## Local access

The service binds to loopback. Browser requests are restricted to the local app origin, with a session token required for writes. Keep it local: do not expose its port through a public reverse proxy, tunnel, or router forwarding. Other programs running as your Windows user may still be able to access local services and files.

The launcher verifies the app's health response before opening a browser. If another service or an older server occupies the port, it reports the conflict rather than opening that service.

## Credentials

Saved GitHub tokens and provider API keys are encrypted with Windows DPAPI for the current user and stored in local application data outside the project source. Public configuration responses expose connection flags, not the saved secret values. Existing GitHub CLI, Git Credential Manager, and Firebase CLI credentials remain managed by those tools.

Windows account access is the security boundary. Encryption does not protect against malware running as that same user. Give GitHub tokens only the repository access needed and revoke them through GitHub if compromised. Do not commit credential files, local settings, build logs, or private workspaces.

GitHub tokens are passed to Git through the process environment instead of being embedded in repository URLs. AI keys travel in request headers to fixed HTTPS provider endpoints; redirects and arbitrary custom endpoints are rejected. Provider errors are returned as sanitized messages.

## Source changes and builds

Installing dependencies and building a repository can execute repository-controlled code with your Windows permissions. Only run builds for projects you trust. These processes may read files accessible to your account; clearing secret environment variables is not a sandbox.

Configuration repairs and reviewed AI fixes are intended to stay within the selected project. File path validation, symlink checks, and backups reduce accidental or malicious writes. Review code changes and keep a Git history. Automatic checks detect supported deployment issues; they cannot establish that an entire application is free of bugs or vulnerabilities.

AI analysis sends selected source files and the supplied problem description to the provider you choose. Sensitive file names and generated folders are excluded from the automatic context, but secrets hardcoded in ordinary source files or manually pasted into a prompt may still be sent. Follow your organization's policy for sharing private source with an AI provider.

## Deployment

Deployment publishes the selected output to Firebase Hosting. Review the selected Firebase project and output before deploying. Keep server credentials and private files out of browser bundles, regardless of hosting ignore rules. Applications requiring a server runtime need an appropriate host and their own authentication, authorization, database rules, and security review.

## Dependency overrides

The bundled Firebase CLI is pinned to `firebase-tools@15.34.0`. Scoped npm overrides address known transitive advisories without downgrading that CLI:

| Dependency | Pinned override | Compatibility considered |
| --- | --- | --- |
| Firebase CLI's `chokidar` | `4.0.3` | Removes the unpatched `braces` dependency. CommonJS `watch` and `FSWatcher` remain available; v4 removes glob support. This dashboard uses Firebase Hosting and account/project commands, not emulator watchers. |
| Pub/Sub's `@opentelemetry/core` | `2.8.0` | Patches baggage parsing limits. The bundled Pub/Sub client uses `W3CTraceContextPropagator`; the required OpenTelemetry API peer version is retained. |
| `gaxios@6.7.1`'s `uuid` | `11.1.1` | Patches UUID buffer bounds checks and retains CommonJS exports. Gaxios uses the compatible zero-argument `v4()` call. |

These overrides are scoped to the dependency paths in `package.json` and recorded in the lockfile. Compatibility validation covers this dashboard's Hosting flow; it does not establish compatibility for all commands or emulators in the bundled CLI. Use a separate upstream Firebase CLI installation for emulator workflows.

References: [braces advisory](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), [Chokidar migration notes](https://github.com/paulmillr/chokidar#upgrading), [OpenTelemetry advisory](https://github.com/advisories/GHSA-8988-4f7v-96qf), and [UUID advisory](https://github.com/advisories/GHSA-w5hq-g745-h8pq).

Run `npm audit --omit=dev` after dependency changes. A clean audit means the registry reported no matching known advisories at that time; it does not prove that dependencies or application code have no security defects.

## Reporting a problem

Report a vulnerability privately to the repository maintainer when a private reporting channel is available. Provide the affected version, reproduction steps, and expected behavior. Remove real tokens, personal information, and private source from reports and screenshots. Avoid posting exploit details publicly before a fix is available.
