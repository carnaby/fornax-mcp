// How the window talks to the tray's core: Tauri's commands and its "state" event. The preview (preview/main.ts)
// swaps in fixtures before the window starts (spec 06e § 4).
import { invoke as tauriInvoke } from '@tauri-apps/api/core';
import { listen as tauriListen } from '@tauri-apps/api/event';

export type Bridge = {
  invoke<T>(name: string, args?: Record<string, unknown>): Promise<T>;
  listen<T>(event: string, onPayload: (payload: T) => void): void;
};

let bridge: Bridge = {
  invoke: <T>(name: string, args?: Record<string, unknown>) => tauriInvoke<T>(name, args),
  listen: <T>(event: string, onPayload: (payload: T) => void) => {
    void tauriListen<T>(event, (e) => onPayload(e.payload));
  },
};

export function setBridge(next: Bridge): void {
  bridge = next;
}

export const invoke = <T>(name: string, args?: Record<string, unknown>): Promise<T> => bridge.invoke<T>(name, args);
export const listen = <T>(event: string, onPayload: (payload: T) => void): void => bridge.listen<T>(event, onPayload);

/** A command whose answer the window does not need; a failure goes to the console. */
export function call(name: string, args?: Record<string, unknown>): void {
  invoke(name, args).catch((e: unknown) => console.error(`${name} failed`, e));
}
