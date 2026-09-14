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
//!   *silently*, handing back perfectly valid buffers full of zeros.
//! - **Linux / ALSA**: there is no loopback flag, and the monitor sources that would serve
//!   the purpose belong to PulseAudio/PipeWire, which ALSA does not enumerate. So no system
//!   audio entries are offered; the user routes our recording stream to a monitor in
//!   pavucontrol instead, which needs no code on our side.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc::Sender;

use crate::resample::{downmix, Resampler, CHUNK_SAMPLES, TARGET_RATE};

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceInfo {
    pub id: String,
    pub name: String,
    pub loopback: bool,
}

const MIC: &str = "mic";
const SYS: &str = "sys";

/// Whether this platform can capture what the speakers are playing. See the module docs.
pub const LOOPBACK_SUPPORTED: bool = cfg!(any(target_os = "windows", target_os = "macos"));
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
    // Listing output devices where loopback is impossible would only offer the user streams
    // that fail to build.
    if LOOPBACK_SUPPORTED {
        if let Ok(devices) = host.output_devices() {
            out.extend(devices.filter_map(|d| describe(&d, SYS)));
        }
    }
    out
}

/// Best guess for the initial UI selection: default mic, else default output (loopback).
pub fn default_device_id(loopback: bool) -> Option<String> {
    let host = cpal::default_host();
    if loopback {
        if !LOOPBACK_SUPPORTED {
            return None;
        }
        host.default_output_device().and_then(|d| describe(&d, SYS)).map(|d| d.id)
    } else {
        host.default_input_device().and_then(|d| describe(&d, MIC)).map(|d| d.id)
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
    let device = devices
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
    tx: Sender<Vec<i16>>,
    level: Arc<AtomicU32>,
    stop: Arc<AtomicBool>,
) -> Result<()> {
    let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<(), String>>();
    let id = id.to_string();

    std::thread::spawn(move || {
        let stream = match build(&id, tx, level) {
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

fn build(id: &str, tx: Sender<Vec<i16>>, level: Arc<AtomicU32>) -> Result<cpal::Stream> {
    let (device, supported) = find(id)?;
    let sample_format = supported.sample_format();
    let channels = supported.channels() as usize;
    let in_rate = supported.sample_rate();
    let config: cpal::StreamConfig = supported.into();

    let mut pipe = Pipe {
        resampler: Resampler::new(in_rate, TARGET_RATE),
        mono: Vec::new(),
        pcm: Vec::new(),
        channels,
        tx,
        level,
    };
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

/// Interleaved device frames -> mono -> 16 kHz -> 100 ms chunks on the channel.
struct Pipe {
    resampler: Resampler,
    mono: Vec<f32>,
    pcm: Vec<i16>,
    channels: usize,
    tx: Sender<Vec<i16>>,
    level: Arc<AtomicU32>,
}

impl Pipe {
    fn feed(&mut self, frames: &[f32]) {
        self.mono.clear();
        downmix(frames, self.channels, &mut self.mono);

        let peak = self.mono.iter().fold(0f32, |m, s| m.max(s.abs()));
        self.level.store(peak.to_bits(), Ordering::Relaxed);

        self.resampler.push(&self.mono, &mut self.pcm);
        while self.pcm.len() >= CHUNK_SAMPLES {
            let chunk: Vec<i16> = self.pcm.drain(..CHUNK_SAMPLES).collect();
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
