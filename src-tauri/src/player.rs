//! Plays spoken translations through the system default or the output the user selected.
//!
//! Playback stays in this process on purpose: the "exclude myself" system-audio capture
//! (see [`crate::audio`]) works per process, and audio played by the webview would come out
//! of a separate WebView2 / WebKit process that the exclusion does not reliably cover.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{DeviceType, InterfaceType};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::resample::Resampler;

/// What the model sends: mono PCM16 at 24 kHz.
const IN_RATE: u32 = 24_000;

pub struct Player {
    queue: Arc<Mutex<VecDeque<f32>>>,
    resampler: Resampler,
    scratch: Vec<f32>,
    pcm: Vec<i16>,
    closed: Arc<AtomicBool>,
}

impl Player {
    /// Opens the default output and returns once it is running. The stream lives on its own
    /// thread (cpal streams are `!Send` on Windows) until the `Player` is dropped *and*
    /// everything queued has been played, so the last sentence is not cut off.
    pub fn start(output: &str) -> Result<Self> {
        let output = output.to_owned();
        let queue = Arc::new(Mutex::new(VecDeque::<f32>::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32, String>>();

        let (q, done) = (queue.clone(), closed.clone());
        std::thread::spawn(move || {
            let (stream, rate) = match build(q.clone(), &output) {
                Ok(s) => s,
                Err(e) => return drop(ready_tx.send(Err(e.to_string()))),
            };
            let _ = ready_tx.send(Ok(rate));
            while !(done.load(Ordering::Relaxed) && q.lock().unwrap().is_empty()) {
                std::thread::sleep(Duration::from_millis(100));
            }
            // Let the device drain its own buffer before the stream goes away.
            std::thread::sleep(Duration::from_millis(200));
            drop(stream);
        });

        let rate = ready_rx
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| anyhow!("audio output did not start within 10s"))?
            .map_err(|e| anyhow!(e))?;
        Ok(Self {
            queue,
            resampler: Resampler::new(IN_RATE, rate),
            scratch: Vec::new(),
            pcm: Vec::new(),
            closed,
        })
    }

    /// Queues one `response.audio.delta` payload (little-endian PCM16, already base64-decoded).
    pub fn push(&mut self, bytes: &[u8]) {
        self.scratch.clear();
        self.scratch.extend(
            bytes
                .as_chunks::<2>()
                .0
                .iter()
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / 32768.0),
        );
        self.pcm.clear();
        self.resampler.push(&self.scratch, &mut self.pcm);
        self.queue
            .lock()
            .unwrap()
            .extend(self.pcm.iter().map(|&s| s as f32 / 32768.0));
    }
}

impl Drop for Player {
    fn drop(&mut self) {
        self.closed.store(true, Ordering::Relaxed);
    }
}

#[derive(Debug, serde::Serialize)]
pub struct OutputDevice {
    value: String,
    name: String,
    kind: &'static str,
}

fn describe_output(id: &str, name: &str, device: DeviceType, interface: InterfaceType) -> OutputDevice {
    let kind = match (device, interface) {
        (DeviceType::Speaker, InterfaceType::BuiltIn) => "speaker",
        (DeviceType::Earpiece, InterfaceType::BuiltIn) => "earpiece",
        (_, InterfaceType::Bluetooth) => "bluetooth",
        (_, InterfaceType::Usb) => "usb",
        (DeviceType::Headphones | DeviceType::Headset, _) => "headphones",
        _ => "other",
    };
    OutputDevice {
        // Include the name so an Android id reused for a different device does not silently match.
        value: if matches!(kind, "speaker" | "earpiece") { kind.into() } else { format!("device|{id}|{}", name.trim()) },
        name: name.trim().into(),
        kind,
    }
}

fn playback_outputs() -> Result<Vec<(OutputDevice, cpal::Device)>, cpal::DevicesError> {
    Ok(cpal::default_host().output_devices()?.filter_map(|device| {
        let desc = device.description().ok()?;
        let id = device.id().ok()?.to_string();
        Some((describe_output(&id, desc.name(), desc.device_type(), desc.interface_type()), device))
    }).collect())
}

fn matches_output(device: &OutputDevice, choice: &str) -> bool {
    device.value == choice || (choice == "headphones" && matches!(device.kind, "headphones" | "bluetooth" | "usb"))
}

/// Connected outputs, including individual Bluetooth/USB devices instead of one headphones bucket.
#[tauri::command]
pub fn output_devices() -> Result<Vec<OutputDevice>, String> {
    let mut devices: Vec<_> = playback_outputs().map_err(|e| e.to_string())?.into_iter().map(|(desc, _)| desc).collect();
    devices.sort_by_key(|d| match d.kind { "speaker" => 0, "earpiece" => 1, _ => 2 });
    devices.dedup_by(|a, b| a.value == b.value);
    Ok(devices)
}

/// The stream plus the device rate the queue has to be filled at.
fn build(queue: Arc<Mutex<VecDeque<f32>>>, output: &str) -> Result<(cpal::Stream, u32)> {
    // A kind that is no longer connected (headphones unplugged) falls back to the system's
    // own routing rather than failing the session.
    let picked = if output.is_empty() { None } else {
        playback_outputs().unwrap_or_default().into_iter().find(|(d, _)| matches_output(d, output)).map(|(_, d)| d)
    };
    let device = match picked {
        Some(d) => d,
        None => cpal::default_host().default_output_device().ok_or_else(|| anyhow!("no audio output device"))?,
    };
    let supported = device.default_output_config()?;
    let channels = supported.channels() as usize;
    let rate = supported.sample_rate();
    // ponytail: assumes the host takes f32 output, true of WASAPI shared mode, CoreAudio and
    // ALSA's plug layer; dispatch on `sample_format()` like `audio::build` if one refuses.
    let config: cpal::StreamConfig = supported.into();

    let stream = device.build_output_stream::<f32, _, _>(
        &config,
        move |out: &mut [f32], _| {
            let mut q = queue.lock().unwrap();
            for frame in out.chunks_mut(channels) {
                // Mono to every channel; silence once the queue runs dry.
                frame.fill(q.pop_front().unwrap_or(0.0));
            }
        },
        |e| eprintln!("[player] stream error: {e}"),
        None,
    )?;
    stream.play()?;
    Ok((stream, rate))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bluetooth_and_usb_outputs_keep_their_names_and_distinct_device_ids() {
        let first = describe_output("AAudio:12", " Buds A ", DeviceType::Unknown, InterfaceType::Bluetooth);
        let second = describe_output("AAudio:13", "Buds B", DeviceType::Headset, InterfaceType::Bluetooth);
        let usb = describe_output("AAudio:14", "USB DAC", DeviceType::Unknown, InterfaceType::Usb);
        assert_eq!(first.name, "Buds A");
        assert_eq!(first.kind, "bluetooth");
        assert_ne!(first.value, second.value);
        assert_eq!(second.value, "device|AAudio:13|Buds B");
        assert!(matches_output(&second, &second.value));
        assert!(!matches_output(&first, &second.value));
        let replaced = describe_output("AAudio:13", "Different headset", DeviceType::Headset, InterfaceType::Bluetooth);
        assert!(!matches_output(&replaced, &second.value));
        assert!(matches_output(&first, "headphones"));
        assert!(matches_output(&usb, "headphones"));
        assert!(!matches_output(&first, ""));
        assert!(!matches_output(&first, "device|AAudio:99"));
    }

    #[test]
    fn built_in_choices_remain_stable_and_other_outputs_are_not_hidden() {
        let speaker = describe_output("AAudio:1", "Phone", DeviceType::Speaker, InterfaceType::BuiltIn);
        let earpiece = describe_output("AAudio:2", "Phone", DeviceType::Earpiece, InterfaceType::BuiltIn);
        let hdmi = describe_output("AAudio:3", "Monitor", DeviceType::Unknown, InterfaceType::Hdmi);
        assert_eq!(speaker.value, "speaker");
        assert_eq!(earpiece.value, "earpiece");
        assert_eq!(hdmi.kind, "other");
        assert!(!matches_output(&hdmi, "headphones"));
    }
}
