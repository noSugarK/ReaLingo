//! System audio, optionally minus our own process, on macOS 14.4+.
//!
//! cpal 0.17's loopback builds a Core Audio process tap with auto-start off, so it records
//! silence, and it excludes nobody, so once we speak the translation our own voice would be
//! recorded too. This builds the tap ourselves — with our process on the exclusion list when
//! asked — wraps it in an aggregate device, and hands that to cpal as an ordinary input.
//! The device is private, so only this process sees it, and both objects go when `Tap` drops.

use anyhow::{anyhow, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::AnyThread;
use objc2_core_audio::{
    kAudioAggregateDeviceIsPrivateKey, kAudioAggregateDeviceNameKey, kAudioAggregateDeviceTapAutoStartKey,
    kAudioAggregateDeviceTapListKey, kAudioAggregateDeviceUIDKey, kAudioHardwarePropertyTranslatePIDToProcessObject,
    kAudioObjectPropertyElementMain, kAudioObjectPropertyScopeGlobal, kAudioObjectSystemObject,
    kAudioSubTapDriftCompensationKey, kAudioSubTapUIDKey, AudioHardwareCreateAggregateDevice,
    AudioHardwareCreateProcessTap, AudioHardwareDestroyAggregateDevice, AudioHardwareDestroyProcessTap,
    AudioObjectGetPropertyData, AudioObjectID, AudioObjectPropertyAddress, CATapDescription, CATapMuteBehavior,
};
use objc2_core_foundation::CFDictionary;
use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString};
use std::ffi::{c_void, CStr};
use std::ptr::NonNull;
use std::str::FromStr;
use std::time::Duration;

pub struct Tap {
    tap: AudioObjectID,
    aggregate: AudioObjectID,
    /// cpal's id for the aggregate device, to open it like any other input.
    pub device_id: String,
}

impl Tap {
    /// `output` is the cpal device id of the output whose mix we want; `exclude_self` leaves
    /// our own playback out of it.
    pub fn new(output: &str, exclude_self: bool) -> Result<Self> {
        let uid = cpal::DeviceId::from_str(output).map_err(|e| anyhow!("{e}"))?.1;
        // Only known once we have played something; `Player` starts before capture for that.
        let excluded = if exclude_self { vec![NSNumber::new_u32(own_process_object()?)] } else { Vec::new() };

        let desc = unsafe {
            CATapDescription::initExcludingProcesses_andDeviceUID_withStream(
                CATapDescription::alloc(),
                &NSArray::from_retained_slice(&excluded),
                &NSString::from_str(&uid),
                0,
            )
        };
        unsafe {
            desc.setMuteBehavior(CATapMuteBehavior::Unmuted); // keep playing to the speakers
            desc.setPrivate(true);
        }
        let mut tap: AudioObjectID = 0;
        check(unsafe { AudioHardwareCreateProcessTap(Some(&desc), &mut tap) }, "create tap")?;

        let tap_uid = unsafe { desc.UUID().UUIDString() };
        let sub_tap = dict(&[
            (kAudioSubTapUIDKey, &*tap_uid),
            (kAudioSubTapDriftCompensationKey, &*NSNumber::new_bool(true)),
        ]);
        let agg_uid = NSString::from_str(&format!("app.realingo.tap.{tap_uid}"));
        let props = dict(&[
            (kAudioAggregateDeviceNameKey, &*NSString::from_str("ReaLingo system audio")),
            (kAudioAggregateDeviceUIDKey, &*agg_uid),
            (kAudioAggregateDeviceTapListKey, &*NSArray::from_retained_slice(&[sub_tap])),
            // Off, the tap never starts and the device delivers silence (cpal 0.18 fixed the same).
            (kAudioAggregateDeviceTapAutoStartKey, &*NSNumber::new_bool(true)),
            (kAudioAggregateDeviceIsPrivateKey, &*NSNumber::new_bool(true)),
        ]);
        // NSDictionary and CFDictionary are toll-free bridged.
        let cf = unsafe { &*(Retained::as_ptr(&props) as *const CFDictionary) };
        let mut aggregate: AudioObjectID = 0;
        let status = unsafe { AudioHardwareCreateAggregateDevice(cf, NonNull::from(&mut aggregate)) };
        if let Err(e) = check(status, "create aggregate device") {
            unsafe { AudioHardwareDestroyProcessTap(tap) };
            return Err(e);
        }

        // From here `Drop` cleans up whatever happens.
        let mut this = Self { tap, aggregate, device_id: String::new() };
        // A fresh aggregate device takes a moment before it reports input configs, and until
        // then cpal's `input_devices()` leaves it out, so wait for it.
        let agg_uid = agg_uid.to_string();
        for _ in 0..40 {
            let ready = cpal::default_host()
                .devices()?
                .find(|d| d.id().is_ok_and(|id| id.1 == agg_uid))
                .filter(|d| d.supports_input());
            if let Some(d) = ready {
                this.device_id = d.id()?.to_string();
                return Ok(this);
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err(anyhow!("system audio tap did not show up as an input device"))
    }
}

impl Drop for Tap {
    fn drop(&mut self) {
        unsafe {
            AudioHardwareDestroyAggregateDevice(self.aggregate);
            AudioHardwareDestroyProcessTap(self.tap);
        }
    }
}

fn own_process_object() -> Result<AudioObjectID> {
    let pid = std::process::id() as i32;
    let address = AudioObjectPropertyAddress {
        mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain,
    };
    let mut object: AudioObjectID = 0;
    let mut size = std::mem::size_of::<AudioObjectID>() as u32;
    let status = unsafe {
        AudioObjectGetPropertyData(
            kAudioObjectSystemObject as AudioObjectID,
            NonNull::from(&address),
            std::mem::size_of::<i32>() as u32,
            &pid as *const i32 as *const c_void,
            NonNull::from(&mut size),
            NonNull::from(&mut object).cast(),
        )
    };
    check(status, "look up own audio process")?;
    if object == 0 {
        return Err(anyhow!("Core Audio does not know this process yet"));
    }
    Ok(object)
}

fn dict(entries: &[(&CStr, &AnyObject)]) -> Retained<NSDictionary<NSString, AnyObject>> {
    let keys: Vec<Retained<NSString>> = entries
        .iter()
        .map(|(k, _)| NSString::from_str(k.to_str().unwrap()))
        .collect();
    let keys: Vec<&NSString> = keys.iter().map(|k| &**k).collect();
    let values: Vec<&AnyObject> = entries.iter().map(|(_, v)| *v).collect();
    NSDictionary::from_slices(&keys, &values)
}

fn check(status: i32, what: &str) -> Result<()> {
    if status == 0 {
        Ok(())
    } else {
        Err(anyhow!("{what} failed (OSStatus {status})"))
    }
}
