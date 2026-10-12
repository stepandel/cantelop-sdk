import type { NativeEvent } from "../../native-harness/cli.js";

export type SessionMessage = { type: "prompt"; prompt: string };
export type SessionEvent = NativeEvent;
