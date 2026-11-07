import { ref } from "vue";

export interface ToastMsg {
  id: number;
  text: string;
  /** Optional inline action, e.g. "重新开始" / "去设置". */
  action?: { label: string; run: () => void };
}

/**
 * The phone's only transient channel: top-right, 3 seconds, auto-gone (design rule — errors
 * and notices never block the stream). The desktop uses inline hints instead; nothing here
 * renders on it.
 */
export const toasts = ref<ToastMsg[]>([]);
let seq = 1;

export function toast(text: string, action?: ToastMsg["action"], ms = 3000) {
  const msg: ToastMsg = { id: seq++, text, action };
  toasts.value.push(msg);
  window.setTimeout(() => dismiss(msg.id), ms);
}

export function dismiss(id: number) {
  const i = toasts.value.findIndex((m) => m.id === id);
  if (i >= 0) toasts.value.splice(i, 1);
}
