//! API key storage, in the OS credential store rather than the config file.
//!
//! Encrypting it ourselves would be theatre: the app has to decrypt unattended, so the key
//! would have to ship inside the binary — which is open source. The OS stores are the only
//! thing here that actually protects a secret at rest: Windows Credential Manager (DPAPI),
//! macOS Keychain, and Secret Service on Linux all derive their key from the user's login.
//!
//! It defends against the config file leaking — synced to a cloud drive, sitting in a
//! backup, pasted into a bug report, read off a disk someone walked away with. It does not
//! defend against malware running as the same user: that can simply ask for the secret too.
//!
//! Linux without a running Secret Service provider (headless, or a minimal desktop) has no
//! store at all. There [`available`] is false and the frontend keeps the key in
//! settings.json as before — refusing to run would be worse than the status quo.
//!
//! Android takes the same fallback path by construction: the `keyring` crate is not even
//! in its dependency graph (it has no Android backend), so every function below folds to
//! the "no store" behaviour.

#[cfg(not(target_os = "android"))]
use keyring::Entry;

use crate::config::Protocol;

// Only the keyring-backed arms name it; Android's stubs never touch a service string.
#[cfg_attr(target_os = "android", allow(dead_code))]
const SERVICE: &str = "com.nosugark.realingo";

/// One slot per vendor, not per protocol: both Qwen protocols sign in with the same Model
/// Studio key. Qwen keeps the original name, so keys saved before OpenAI stay where they are.
fn user(protocol: Protocol) -> &'static str {
    match protocol {
        Protocol::Qwen35 | Protocol::Qwen38 => "api-key",
        Protocol::Openai => "api-key-openai",
        Protocol::Gemini => "api-key-gemini",
        Protocol::Volc => "api-key-volc",
    }
}

/// Whether this machine has a usable credential store. Probed once by keyring itself.
#[cfg(not(target_os = "android"))]
pub fn available() -> bool {
    Entry::store_status().is_ok()
}

/// Android: no store, full stop. The frontend's settings.json fallback takes the key.
#[cfg(target_os = "android")]
pub fn available() -> bool {
    false
}

pub fn get(protocol: Protocol) -> Option<String> {
    get_as(user(protocol))
}

/// An empty key deletes the entry — "clear the field" has to actually clear it.
pub fn set(protocol: Protocol, key: &str) -> Result<(), String> {
    set_as(user(protocol), key)
}

#[cfg(not(target_os = "android"))]
fn get_as(user: &str) -> Option<String> {
    let key = Entry::new(SERVICE, user).ok()?.get_password().ok()?;
    (!key.is_empty()).then_some(key)
}

#[cfg(target_os = "android")]
fn get_as(_user: &str) -> Option<String> {
    None
}

#[cfg(not(target_os = "android"))]
fn set_as(user: &str, key: &str) -> Result<(), String> {
    let entry = Entry::new(SERVICE, user).map_err(|e| e.to_string())?;
    if key.is_empty() {
        return match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        };
    }
    entry.set_password(key).map_err(|e| e.to_string())
}

#[cfg(target_os = "android")]
fn set_as(_user: &str, _key: &str) -> Result<(), String> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Round-trips against the real store under a throwaway name, so it never touches the
    /// user's actual key. Skipped where CI has no store (headless Linux) or a locked one
    /// (macOS runners) — that is an environment fact, not a bug in this module.
    #[test]
    fn stores_reads_and_clears() {
        const PROBE: &str = "api-key-selftest";
        if !available() || set_as(PROBE, "sk-probe").is_err() {
            return;
        }
        assert_eq!(get_as(PROBE).as_deref(), Some("sk-probe"));

        set_as(PROBE, "").unwrap();
        assert_eq!(get_as(PROBE), None, "an empty key must delete the entry, not store one");

        // Deleting something already gone is how a cleared field saves twice.
        set_as(PROBE, "").unwrap();
    }
}
