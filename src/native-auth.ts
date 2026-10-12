/** Workspace-scoped native CLI authentication. Attempts live only in the auth Sandbox. */
export type NativeAuthCommand =
  | { readonly type: "methods" }
  | { readonly type: "status" }
  | { readonly type: "logout" }
  | { readonly type: "login"; readonly method: string; readonly force?: boolean }
  | { readonly type: "submit"; readonly attemptId: string; readonly code: string }
  | { readonly type: "cancel"; readonly attemptId: string };

export type NativeAuthResult =
  | { readonly type: "methods"; readonly methods: readonly string[] }
  | { readonly type: "status"; readonly authenticated: boolean }
  | { readonly type: "login"; readonly attemptId: string; readonly method: string; readonly url: string; readonly expiresAt: string }
  | { readonly type: "cancelled"; readonly attemptId: string };

export const NATIVE_AUTH_SESSION_ID = "cantelop-native-auth";
