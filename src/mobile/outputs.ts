import { computed, onMounted, onUnmounted, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { t } from "../core/i18n";

export interface OutputDevice {
  value: string;
  name: string;
  kind: "speaker" | "earpiece" | "headphones" | "bluetooth" | "usb" | "other";
}

const labels = { speaker: "outSpeaker", earpiece: "outEarpiece", headphones: "outHeadphones", bluetooth: "outBluetooth", usb: "outUsb", other: "outOther" } as const;

export function selectedOutput(value: string, devices: OutputDevice[]): string {
  // Preserve the old broad headphones preference until the user chooses a specific device.
  return value === "headphones" ? devices.find(d => ["headphones", "bluetooth", "usb"].includes(d.kind))?.value ?? value : value;
}

export function outputName(value: string, devices: OutputDevice[]): string {
  if (!value) return t("outAuto");
  const device = devices.find(d => d.value === selectedOutput(value, devices));
  if (!device) return t("outputMissingShort");
  return ["speaker", "earpiece"].includes(device.kind) ? t(labels[device.kind]) : device.name || t(labels[device.kind]);
}

export function useOutputDevices() {
  const devices = ref<OutputDevice[]>([]);
  const loading = ref(true);
  const failed = ref(false);
  let request = 0;
  let disposed = false;
  async function refresh() {
    const ticket = ++request;
    loading.value = true;
    try {
      const next = await invoke<OutputDevice[]>("output_devices");
      if (disposed || ticket !== request) return;
      devices.value = next;
      failed.value = false;
    } catch {
      if (disposed || ticket !== request) return;
      devices.value = [];
      failed.value = true;
    } finally {
      if (!disposed && ticket === request) loading.value = false;
    }
  }
  const changed = () => { void refresh(); };
  const visible = () => { if (!document.hidden) changed(); };
  onMounted(() => {
    window.addEventListener("realingo:outputs", changed);
    document.addEventListener("visibilitychange", visible);
    changed();
  });
  onUnmounted(() => {
    disposed = true;
    window.removeEventListener("realingo:outputs", changed);
    document.removeEventListener("visibilitychange", visible);
  });
  const options = computed<{ value: string; label: string; detail?: string }[]>(() => [
    { value: "", label: t("outAuto") },
    ...devices.value.map(d => ({ value: d.value, label: outputName(d.value, devices.value),
      detail: ["speaker", "earpiece"].includes(d.kind) ? undefined : t(labels[d.kind]) })),
  ]);
  return { devices, options, loading, failed, refresh };
}
