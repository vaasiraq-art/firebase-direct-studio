# Firebase Direct Studio

A local Windows dashboard for importing GitHub repositories, checking Firebase Hosting configuration, reviewing AI fixes, and deploying a website from your browser.

## Start

[Download the ZIP](https://github.com/vaasiraq-art/firebase-direct-studio/archive/refs/heads/main.zip), extract it to a folder, then follow these steps. The download contains no saved accounts, API keys, private projects, or user settings. Each Windows user connects their own accounts.

Install Node.js 22.16 or newer and Git for Windows. Double-click `Start-Firebase-Direct.bat` in this folder. The first launch installs the app's locked dependencies, including the Firebase CLI, and shows setup progress. An internet connection is required.

The launcher creates or refreshes the desktop icon automatically when it opens the browser. To recreate the icon manually, run:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\create-desktop-shortcut.ps1
```

Double-click **Firebase Direct Studio** on your desktop. The launcher starts the local server in the background, checks that it is ready, and opens your default browser at `http://localhost:4545`. Chrome, Edge, Firefox, and other modern browsers can open the same address while the app is running.

For a terminal setup, run `npm ci`, then `npm start`. A separate global Firebase CLI installation is unnecessary. The desktop shortcut uses the location of the current project folder; recreate it if you move the folder. Startup and first-launch installation logs are under `%LOCALAPPDATA%\FirebaseDirectStudio\logs`.

## Connect and deploy

1. In **Connections**, connect GitHub using the account already signed in on your computer. The app checks GitHub CLI credentials, then Git Credential Manager. If neither is available, use a GitHub token with access to the repositories you need. Private and organization repositories only appear when the credential permits access; some organizations also require SSO authorization.
2. Connect Firebase and finish Google's browser sign-in. Refresh the connection and choose your Firebase project.
3. Import a repository, select its branch, or choose a local project folder. If the repository contains several apps, choose the app folder.
4. Review the project checks and apply the available configuration fixes. AI code repair is optional.
5. Choose **Deploy** to install dependencies, build the selected app, and publish to Firebase Hosting. Progress and errors come from the real commands. The live link appears after Firebase reports success.

Import and build repositories you trust: package installation and build scripts run on your Windows account. If you have local fixes, keep GitHub sync off until those changes are committed; the app will not discard them to force a pull.

## Optional AI repair

Choose a provider, enter its API key, and choose a model your account can use. Gemini is optional. No AI key is needed to import repositories, run the deployment checks, or deploy.

| Provider | Default model | API documentation |
| --- | --- | --- |
| OpenAI | `gpt-4.1-mini` | [Responses API](https://developers.openai.com/api/docs/guides/text) |
| Anthropic / Claude | `claude-sonnet-4-6` | [Messages API](https://platform.claude.com/docs/en/api/messages/create) |
| Google Gemini | `gemini-2.5-flash` | [Generate content](https://ai.google.dev/api/generate-content) |
| OpenRouter | `openai/gpt-4.1-mini` | [Chat completions](https://openrouter.ai/docs/api/api-reference/chat/create-a-chat-completion) |
| Groq | `openai/gpt-oss-120b` | [OpenAI compatibility](https://console.groq.com/docs/openai) |
| DeepSeek | `deepseek-flash` | [Chat completions](https://api-docs.deepseek.com/api/create-chat-completion/) |

Model IDs are editable; availability, rate limits, billing, and provider policies depend on your account. AI repair sends selected project source and the supplied problem description to the chosen provider. Review the proposed files before applying changes. AI output is never executed as a command.

## Supported deployment targets

Firebase **Hosting** serves static files. Static HTML sites and client applications with a build output can use this flow. Next.js projects need a valid static export; server APIs, server actions, databases, and other server runtime features cannot be made static just by changing a configuration value.

Projects that need a server require an appropriate runtime and separate setup, such as Firebase App Hosting, Cloud Run, or another server host. Native desktop and mobile applications are not converted into websites. Firebase and AI billing or quotas are controlled by their respective providers; this app does not promise that every project is free to host.

## Credentials and local data

Settings are stored in `%LOCALAPPDATA%\FirebaseDirectStudio`. Saved API keys and manually entered GitHub tokens use Windows DPAPI encryption for the current Windows account. Existing legacy credentials are migrated from `config.json`. GitHub CLI and Git Credential Manager remain responsible for their own credentials.

Keep local configuration, imported workspaces, logs, credentials, and private source out of shared release packages. The repository's `.gitignore` excludes these files. See [SECURITY.md](SECURITY.md) for the trust boundary and limitations.

## Verify changes

```powershell
npm test
npm audit --omit=dev
```

Tests cover provider request formats and important validation/security regressions. Mocked provider tests do not consume AI credits or prove that a particular account can use a model. A successful live deployment still requires valid Firebase credentials, project permissions, and a buildable project.
