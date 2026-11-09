//! System audio minus our own process, on Windows.
//!
//! Plain WASAPI loopback (what cpal does) records the whole endpoint mix, which once we speak
//! the translation includes our own voice — it would be transcribed and translated again.
//! *Process loopback* (Windows 10 2004+) can exclude a process tree instead. It is not tied
//! to an endpoint: it always records the default render device, which is also where
//! [`crate::player`] plays, so `audio::start` only routes here when that is the device the
//! user picked. Any other device never hears us and keeps the plain path.

use anyhow::{anyhow, Result};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};
use std::sync::Arc;
use std::time::Duration;
use windows::core::{implement, Interface, Ref, HRESULT};
use windows::Win32::Media::Audio::*;
use windows::Win32::System::Com::StructuredStorage::{PROPVARIANT, PROPVARIANT_0, PROPVARIANT_0_0, PROPVARIANT_0_0_0};
use windows::Win32::System::Com::{CoInitializeEx, IAgileObject, IAgileObject_Impl, BLOB, COINIT_MULTITHREADED};
use windows::Win32::Foundation::CloseHandle;
use windows::Win32::System::Threading::{CreateEventW, WaitForSingleObject};
use windows::Win32::System::Variant::VT_BLOB;

use crate::audio::Pipe;

/// What we ask the engine to convert to (`AUTOCONVERTPCM`); the pipe takes it from there.
pub const RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;

/// Same contract as `pulse::start`: returns once capture is running, or with the error.
pub fn start(mut pipe: Pipe, stop: Arc<AtomicBool>) -> Result<()> {
    let (ready_tx, ready_rx) = channel::<Result<(), String>>();
    std::thread::spawn(move || {
        if let Err(e) = unsafe { capture(&mut pipe, &stop, &ready_tx) } {
            let _ = ready_tx.send(Err(e.to_string()));
        }
    });
    ready_rx
        .recv_timeout(Duration::from_secs(10))
        .map_err(|_| anyhow!("audio device did not start within 10s"))?
        .map_err(|e| anyhow!("system audio capture failed: {e}"))
}

/// The activation completes on a worker thread; this just says so. It must be agile, or
/// the activation fails with E_ILLEGAL_METHOD_CALL.
#[implement(IActivateAudioInterfaceCompletionHandler, IAgileObject)]
struct Done(Sender<()>);

impl IActivateAudioInterfaceCompletionHandler_Impl for Done_Impl {
    fn ActivateCompleted(&self, _: Ref<'_, IActivateAudioInterfaceAsyncOperation>) -> windows::core::Result<()> {
        let _ = self.0.send(());
        Ok(())
    }
}
impl IAgileObject_Impl for Done_Impl {}

unsafe fn capture(pipe: &mut Pipe, stop: &AtomicBool, ready: &Sender<Result<(), String>>) -> Result<()> {
    CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;

    let mut params = AUDIOCLIENT_ACTIVATION_PARAMS {
        ActivationType: AUDIOCLIENT_ACTIVATION_TYPE_PROCESS_LOOPBACK,
        Anonymous: AUDIOCLIENT_ACTIVATION_PARAMS_0 {
            ProcessLoopbackParams: AUDIOCLIENT_PROCESS_LOOPBACK_PARAMS {
                TargetProcessId: std::process::id(),
                ProcessLoopbackMode: PROCESS_LOOPBACK_MODE_EXCLUDE_TARGET_PROCESS_TREE,
            },
        },
    };
    // ManuallyDrop: windows-rs drops a PROPVARIANT with PropVariantClear, which would hand
    // this stack pointer to CoTaskMemFree — heap corruption the moment capture ends.
    let blob = std::mem::ManuallyDrop::new(PROPVARIANT {
        Anonymous: PROPVARIANT_0 {
            Anonymous: std::mem::ManuallyDrop::new(PROPVARIANT_0_0 {
                vt: VT_BLOB,
                Anonymous: PROPVARIANT_0_0_0 {
                    blob: BLOB {
                        cbSize: std::mem::size_of_val(&params) as u32,
                        pBlobData: &mut params as *mut _ as *mut u8,
                    },
                },
                ..Default::default()
            }),
        },
    });

    let (done_tx, done_rx) = channel();
    let handler: IActivateAudioInterfaceCompletionHandler = Done(done_tx).into();
    let op = ActivateAudioInterfaceAsync(VIRTUAL_AUDIO_DEVICE_PROCESS_LOOPBACK, &IAudioClient::IID, Some(&*blob), &handler)?;
    done_rx
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| anyhow!("process loopback activation timed out"))?;
    let mut hr = HRESULT(0);
    let mut unknown = None;
    op.GetActivateResult(&mut hr, &mut unknown)?;
    hr.ok()?;
    let client: IAudioClient = unknown.ok_or_else(|| anyhow!("no audio client"))?.cast()?;

    // Process loopback has no mix format to ask for (GetMixFormat is not implemented), so
    // name one and let the engine convert.
    let block = CHANNELS * 2;
    let format = WAVEFORMATEX {
        wFormatTag: WAVE_FORMAT_PCM as u16,
        nChannels: CHANNELS,
        nSamplesPerSec: RATE,
        nAvgBytesPerSec: RATE * block as u32,
        nBlockAlign: block,
        wBitsPerSample: 16,
        cbSize: 0,
    };
    client.Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM,
        2_000_000, // 200 ms, in 100 ns units
        0,
        &format,
        None,
    )?;
    let event = CreateEventW(None, false, false, None)?;
    client.SetEventHandle(event)?;
    let reader: IAudioCaptureClient = client.GetService()?;
    client.Start()?;
    let _ = ready.send(Ok(()));

    let mut frames_f32 = Vec::new();
    while !stop.load(Ordering::Relaxed) {
        // A timeout, not INFINITE: nothing playing means no packets, and stop must still land.
        WaitForSingleObject(event, 100);
        while reader.GetNextPacketSize()? > 0 {
            let (mut data, mut frames, mut flags) = (std::ptr::null_mut(), 0u32, 0u32);
            reader.GetBuffer(&mut data, &mut frames, &mut flags, None, None)?;
            let n = frames as usize * CHANNELS as usize;
            frames_f32.clear();
            // An empty packet can come back with a null pointer, which from_raw_parts rejects
            // even at length 0.
            if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 || data.is_null() {
                frames_f32.resize(n, 0.0);
            } else {
                let samples = std::slice::from_raw_parts(data as *const i16, n);
                frames_f32.extend(samples.iter().map(|&s| s as f32 / 32768.0));
            }
            reader.ReleaseBuffer(frames)?;
            pipe.feed(&frames_f32);
        }
    }
    let _ = client.Stop();
    let _ = CloseHandle(event);
    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::audio;
    use crate::player::Player;
    use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
    use std::sync::Arc;
    use std::time::Duration;

    /// Peak of one second of system audio, captured with or without excluding ourselves.
    fn peak(exclude_self: bool) -> i16 {
        let id = audio::default_device_id(true).expect("no default output");
        let (tx, mut rx) = tokio::sync::mpsc::channel(64);
        let stop = Arc::new(AtomicBool::new(false));
        audio::start(&id, 16_000, tx, Arc::new(AtomicU32::new(0)), stop.clone(), exclude_self).unwrap();
        std::thread::sleep(Duration::from_secs(1));
        stop.store(true, Ordering::Relaxed);
        // Let the capture thread wind down: teardown is where a bad free would surface.
        std::thread::sleep(Duration::from_millis(500));
        let mut peak = 0;
        while let Ok(chunk) = rx.try_recv() {
            peak = chunk.iter().fold(peak, |m: i16, s| m.max(s.saturating_abs()));
        }
        peak
    }

    /// Needs real speakers and an otherwise quiet machine:
    /// `cargo test own_playback -- --ignored`
    #[test]
    #[ignore]
    fn own_playback_is_heard_by_plain_loopback_but_not_by_process_loopback() {
        let mut player = Player::start().unwrap();
        let tone: Vec<u8> = (0..24_000 * 4)
            .map(|i| ((i as f32 * 440.0 * std::f32::consts::TAU / 24_000.0).sin() * 8000.0) as i16)
            .flat_map(i16::to_le_bytes)
            .collect();
        player.push(&tone);
        std::thread::sleep(Duration::from_millis(300));

        let plain = peak(false);
        let excluded = peak(true);
        assert!(plain > 2000, "plain loopback should hear the tone, peak {plain}");
        assert!(excluded < 500, "process loopback should not, peak {excluded}");
    }
}
