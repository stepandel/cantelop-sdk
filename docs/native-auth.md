# Native harness authentication

`app.workspace(selector).auth()` addresses one reserved `cantelop-native-auth` Session in the selected Workspace. Applications must derive `selector` from their verified user identity. The reference is lazy and does not resolve the Workspace until called.

```ts
const auth = app.workspace({ slug: user.workspaceSlug }).auth();
const methods = await auth.methods();
if (!await auth.status()) {
  const attempt = await auth.login({ method: methods[0] });
  if (attempt.type === "login") {
    // Show attempt.url to the user, then accept their code in your own API.
    await auth.submit({ attemptId: attempt.attemptId, code });
  }
}
```

The public methods are `methods`, `status`, `login`, `submit`, `cancel`, and `logout`. They use the App's authenticated `/commands` route and selector-bound request delivery. `{ id }` on each call supplies a stable command ID for retries. The Edge accepts auth commands only for the reserved Session. An App's ordinary `workspace.session()` refuses that ID.

A harness opts in by implementing `auth(command, context)`. `context.hold(promise)` keeps the auth runtime non-quiescent while a native login process waits for user input; it must be called for every attempt that outlives the initial `login` reply. Attempts are in Sandbox memory and should expire, release native processes on shutdown, and reject stale IDs. Credentials belong to the native CLI in the persistent Workspace. An unsupported harness rejects the auth request.

The Claude Code example supports the `browser-code` method with the stock `claude auth` commands. Its PTY relay disables input echo, limits raw output, accepts only Anthropic-hosted HTTPS sign-in links, and never emits the terminal transcript. Other native examples can add methods through the same harness capability.

Auth submissions follow the platform's ordinary request delivery. The platform stores delivery payloads encrypted for its normal retention period, including submitted codes. Applications should avoid logging request bodies. These requests must not be automatically replayed after an attempt is lost; an old `attemptId` is rejected by the new auth runtime.
