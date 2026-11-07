import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

/** What `platform` answers: the host OS plus the two capabilities the UI has to honour. */
export interface Caps {
  os: string;
  loopback: true | false;
  keyring: boolean;
}

export const caps = ref<Caps>({ os: "", loopback: true, keyring: true });

/**
 * Whether this is the phone layout rather than the desktop window.
 *
 * Seeded synchronously from the UA so the first paint is already the right shell — waiting
 * on `invoke` would render the desktop grid for a frame and then swap under the user. The
 * `platform` command is the authority; a desktop window merely resized narrow is not a phone,
 * and an Android WebView is not a small window.
 */
export const isMobile = ref(/android/i.test(navigator.userAgent));

export async function loadCaps(): Promise<Caps> {
  caps.value = await invoke<Caps>("platform");
  // `std::env::consts::OS` on Android is "android"; nothing else in the graph reports that.
  isMobile.value = caps.value.os === "android";
  document.documentElement.toggleAttribute("data-mobile", isMobile.value);
  return caps.value;
}
