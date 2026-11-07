//! Plays the spoken translation on the default output device.
//!
//! Playback stays in this process on purpose: the "exclude myself" system-audio capture
//! (see [`crate::audio`]) works per process, and audio played by the webview would come out
//! of a separate WebView2 / WebKit process that the exclusion does not reliably cover.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
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
    pub fn start() -> Result<Self> {
        let queue = Arc::new(Mutex::new(VecDeque::<f32>::new()));
        let closed = Arc::new(AtomicBool::new(false));
        let (ready_tx, ready_rx) = std::sync::mpsc::channel::<Result<u32, String>>();

        let (q, done) = (queue.clone(), closed.clone());
        std::thread::spawn(move || {
            let (stream, rate) = match build(q.clone()) {
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

/// The stream plus the device rate the queue has to be filled at.
fn build(queue: Arc<Mutex<VecDeque<f32>>>) -> Result<(cpal::Stream, u32)> {
    let device = cpal::default_host()
        .default_output_device()
        .ok_or_else(|| anyhow!("no audio output device"))?;
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
