//! Live capture: microphones, and system audio where the platform allows it.
//!
//! "Record what the speakers play" is the same cpal call everywhere — `build_input_stream`
//! on an *output* device — but the backends get there differently:
//!
//! - **Windows / WASAPI**: cpal adds `AUDCLNT_STREAMFLAGS_LOOPBACK` when the endpoint is a
//!   render device. Works on any supported Windows version.
//! - **macOS / CoreAudio**: for a device with no input, cpal creates a Core Audio *process
//!   tap* plus a private aggregate device. Needs macOS 14.4+, and the app bundle must carry
//!   `NSAudioCaptureUsageDescription` (see `Info.plist`) — without it TCC denies access
//!   *silently*, handing back perfectly valid buffers full of zeros. cpal 0.17's own tap
//!   never starts (also silence), so we build the tap ourselves: [`crate::tap`].
//! - **Linux / ALSA**: there is no loopback flag, and the monitor sources that would serve
//!   the purpose belong to PulseAudio/PipeWire, which ALSA does not enumerate. cpal
//!   therefore cannot reach them at all, so system audio here does not go through cpal: see
//!   [`crate::pulse`], which asks the sound server directly. Only when no sound server
//!   answers does the old story hold — no system-audio entries, route it in pavucontrol.
//!
//! When we speak the translation ourselves, system audio must leave our own voice out or it
//! gets translated again. `exclude_self` asks for that: Windows switches to process loopback
//! ([`crate::wasapi`]), macOS to a tap that lists our process as excluded ([`crate::tap`]).
//! Linux has no such filter, so the frontend does not offer speaking with system audio there.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::Sender;

use crate::resample::{chunk_samples, downmix, Resampler};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub loopback: bool,
}

const MIC: &str = "mic";
const SYS: &str = "sys";

/// Whether this machine can capture what the speakers are playing. See the module docs.
///
/// A function, not a constant, because on Linux the answer is a runtime one: it depends on
/// a sound server being up, which can change while the app is open. Elsewhere it folds to a
/// compile-time fact.
pub fn loopback_supported() -> bool {
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    {
        crate::pulse::available()
    }
    #[cfg(target_os = "android")]
    { true } // The native bridge further gates AudioPlaybackCapture on Android 10+.
    #[cfg(all(not(target_os = "android"), not(target_os = "linux")))]
    {
        cfg!(any(target_os = "windows", target_os = "macos"))
    }
}
/// `DeviceId`'s own Display already contains ':', so separate our prefix with something else.
const SEP: char = '|';

/// cpal's `DeviceId` is stable across reboots and reconnects; the display name is not
/// (two identical headsets report the same name), so match on the id and show the name.
fn describe(d: &cpal::Device, kind: &str) -> Option<DeviceInfo> {
    let id = d.id().ok()?.to_string();
    let name = d.description().ok()?.name().to_string();
    Some(DeviceInfo { id: format!("{kind}{SEP}{id}"), name, loopback: kind == SYS })
}

pub fn list_devices() -> Vec<DeviceInfo> {
    let host = cpal::default_host();
    let mut out = Vec::new();

    if let Ok(devices) = host.input_devices() {
        out.extend(devices.filter_map(|d| describe(&d, MIC)));
    }
    if let Some(default) = host.default_input_device().and_then(|d| describe(&d, MIC)) {
        if !out.iter().any(|d| d.id == default.id) { out.insert(0, default); }
    }
    #[cfg(target_os = "android")]
    out.push(DeviceInfo { id: "sys|android".into(), name: "Android playback audio".into(), loopback: true });
    // Listing output devices where loopback is impossible would only offer the user streams
    // that fail to build.
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    out.extend(crate::pulse::monitors().into_iter().map(|m| DeviceInfo {
        id: format!("{SYS}{SEP}{}", m.name),
        name: m.label,
        loopback: true,
    }));
    #[cfg(all(not(target_os = "android"), not(target_os = "linux")))]
    if loopback_supported() {
        if let Ok(devices) = host.output_devices() {
            out.extend(devices.filter_map(|d| describe(&d, SYS)));
        }
    }
    out
}

/// Best guess for the initial UI selection: default mic, else default output (loopback).
pub fn default_device_id(loopback: bool) -> Option<String> {
    #[cfg(target_os = "android")]
    if loopback { return Some("sys|android".into()); }
    let host = cpal::default_host();
    if !loopback {
        return host.default_input_device().and_then(|d| describe(&d, MIC)).map(|d| d.id);
    }

    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    {
        // Fall back to the first monitor: `pactl get-default-sink` can name a sink whose
        // monitor is not actually offered (a just-removed device), and an id that matches
        // nothing leaves the picker looking empty.
        let all = crate::pulse::monitors();
        let preferred = crate::pulse::default_monitor()
            .filter(|n| all.iter().any(|m| &m.name == n))
            .or_else(|| all.first().map(|m| m.name.clone()))?;
        Some(format!("{SYS}{SEP}{preferred}"))
    }
    #[cfg(any(target_os = "android", not(target_os = "linux")))]
    {
        if !loopback_supported() {
            return None;
        }
        host.default_output_device().and_then(|d| describe(&d, SYS)).map(|d| d.id)
    }
}

fn find(id: &str) -> Result<(cpal::Device, cpal::SupportedStreamConfig)> {
    let host = cpal::default_host();
    let (prefix, target) = id
        .split_once(SEP)
        .ok_or_else(|| anyhow!("bad device id: {id}"))?;
    let loopback = prefix == SYS;

    let mut devices: Box<dyn Iterator<Item = cpal::Device>> = if loopback {
        Box::new(host.output_devices()?)
    } else {
        Box::new(host.input_devices()?)
    };
    // AAudio's default is a routing sentinel (id -1), not one of AudioManager's
    // enumerated hardware ids. It is valid to open even when absent from the list.
    let default = if loopback { host.default_output_device() } else { host.default_input_device() };
    let device = default.into_iter().chain(devices.by_ref())
        .find(|d| d.id().map(|i| i.to_string() == target).unwrap_or(false))
        .ok_or_else(|| anyhow!("audio device is no longer available"))?;

    // A render endpoint has no *input* config; its mix format is the output config, and that
    // is exactly what the loopback stream delivers.
    let config = if loopback { device.default_output_config()? } else { device.default_input_config()? };
    Ok((device, config))
}

/// Starts capture on its own thread (cpal streams are `!Send` on Windows) and returns once
/// the stream is actually running, so the caller learns about device errors immediately.
pub fn start(
    id: &str,
    rate: u32,
    tx: Sender<Vec<i16>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
    exclude_self: bool,
) -> Result<()> {
    #[cfg(target_os = "android")]
    if id == "sys|android" { return crate::android_audio::start(rate, tx, level, stop); }
    // Linux system audio never reaches cpal — it is a `parec` pipe, which owns its own
    // thread and reports failure synchronously already.
    #[cfg(all(target_os = "linux", not(target_os = "android")))]
    if let Some(source) = id.strip_prefix(SYS).and_then(|r| r.strip_prefix(SEP)) {
        return crate::pulse::start(source, rate, tx, level, stop);
    }

    #[cfg(windows)]
    if exclude_self && is_default_output(id) {
        let pipe = Pipe::new(crate::wasapi::RATE, crate::wasapi::CHANNELS as usize, rate, tx, level);
        return crate::wasapi::start(pipe, stop);
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    let _ = exclude_self;

    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let id = id.to_string();

    std::thread::spawn(move || {
        // macOS: system audio always goes through our own tap — cpal 0.17's loopback leaves
        // tap auto-start off and records silence. The tap has to outlive the stream.
        #[cfg(target_os = "macos")]
        let (_tap, id) = match id
            .strip_prefix(SYS)
            .and_then(|r| r.strip_prefix(SEP))
            .map(|output| crate::tap::Tap::new(output, exclude_self))
        {
            None => (None, id),
            Some(Ok(tap)) => {
                let id = format!("{MIC}{SEP}{}", tap.device_id);
                (Some(tap), id)
            }
            Some(Err(e)) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        let stream = match build(&id, rate, tx, level) {
            Ok(s) => s,
            Err(e) => {
                let _ = ready_tx.send(Err(e.to_string()));
                return;
            }
        };
        if let Err(e) = stream.play() {
            let _ = ready_tx.send(Err(e.to_string()));
            return;
        }
        let _ = ready_tx.send(Ok(()));
        while !stop.load(Ordering::Relaxed) {
            std::thread::sleep(Duration::from_millis(60));
        }
        drop(stream);
    });

    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| anyhow!("audio device did not start within 10s"))?
        .map_err(|e| anyhow!(e))
}

/// Whether `id` is the system-audio entry for the default output — the device we play on.
#[cfg(windows)]
fn is_default_output(id: &str) -> bool {
    let Some(target) = id.strip_prefix(SYS).and_then(|r| r.strip_prefix(SEP)) else {
        return false;
    };
    cpal::default_host()
        .default_output_device()
        .and_then(|d| d.id().ok())
        .is_some_and(|d| d.to_string() == target)
}

fn build(id: &str, rate: u32, tx: Sender<Vec<i16>>, level: Arc<AtomicU32>) -> Result<cpal::Stream> {
    let (device, supported) = find(id)?;
    let sample_format = supported.sample_format();
    let channels = supported.channels() as usize;
    let in_rate = supported.sample_rate();
    let config: cpal::StreamConfig = supported.into();

    let mut pipe = Pipe::new(in_rate, channels, rate, tx, level);
    let sink = move |frames: &[f32]| pipe.feed(frames);

    match sample_format {
        SampleFormat::F32 => typed::<f32>(&device, &config, sink),
        SampleFormat::I16 => typed::<i16>(&device, &config, sink),
        SampleFormat::U16 => typed::<u16>(&device, &config, sink),
        SampleFormat::I32 => typed::<i32>(&device, &config, sink),
        SampleFormat::I8 => typed::<i8>(&device, &config, sink),
        other => Err(anyhow!("unsupported sample format: {other}")),
    }
}

fn typed<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    mut sink: impl FnMut(&[f32]) + Send + 'static,
) -> Result<cpal::Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let mut scratch: Vec<f32> = Vec::new();
    let stream = device.build_input_stream::<T, _, _>(
        config,
        move |data: &[T], _| {
            scratch.clear();
            scratch.extend(data.iter().map(|&s| f32::from_sample(s)));
            sink(&scratch);
        },
        |e| eprintln!("[audio] stream error: {e}"),
        None,
    )?;
    Ok(stream)
}

/// Interleaved device frames -> mono -> model rate -> 100 ms chunks on the channel.
pub(crate) struct Pipe {
    resampler: Resampler,
    mono: Vec<f32>,
    pcm: Vec<i16>,
    chunk: usize,
    channels: usize,
    tx: Sender<Vec<i16>>,
    level: Arc<AtomicU32>,
}

impl Pipe {
    pub(crate) fn new(in_rate: u32, channels: usize, out_rate: u32, tx: Sender<Vec<i16>>, level: Arc<AtomicU32>) -> Self {
        Self {
            resampler: Resampler::new(in_rate, out_rate),
            mono: Vec::new(),
            pcm: Vec::new(),
            chunk: chunk_samples(out_rate),
            channels,
            tx,
            level,
        }
    }

    pub(crate) fn feed(&mut self, frames: &[f32]) {
        self.mono.clear();
        downmix(frames, self.channels, &mut self.mono);

        let peak = self.mono.iter().fold(0f32, |m, s| m.max(s.abs()));
        self.level.store(peak.to_bits(), Ordering::Relaxed);

        self.resampler.push(&self.mono, &mut self.pcm);
        while self.pcm.len() >= self.chunk {
            let chunk: Vec<i16> = self.pcm.drain(..self.chunk).collect();
            // Never block the audio thread: if the uplink is backed up, drop the chunk.
            if self.tx.try_send(chunk).is_err() {
                break;
            }
        }
    }
}

pub fn read_level(level: &AtomicU32) -> f32 {
    f32::from_bits(level.load(Ordering::Relaxed))
}

/// Read real capture frames without opening a network session or needing an API key.
pub async fn probe(id: String) -> Result<usize> {
    let stop = Arc::new(AtomicBool::new(false));
    let (tx, mut rx) = tokio::sync::mpsc::channel(8);
    let worker_stop = stop.clone();
    let started = tauri::async_runtime::spawn_blocking(move ||
        start(&id, 16_000, tx, Arc::new(AtomicU32::new(0)), worker_stop, false)
    ).await;
    let result = match started {
        Ok(Ok(())) => {
            tokio::time::timeout(Duration::from_secs(3), rx.recv()).await
                .map_err(|_| anyhow!("audio source did not deliver frames within 3s"))
                .and_then(|samples| samples.map(|s| s.len()).ok_or_else(|| anyhow!("audio capture stopped")))
        }
        Ok(Err(e)) => Err(e),
        Err(e) => Err(anyhow!(e)),
    };
    stop.store(true, Ordering::Relaxed);
    result
}
