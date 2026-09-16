//! Translation history: one JSONL file per session under `app-data/history`.
//!
//! Append-only text rather than a database. The write path here is "one more sentence, right
//! now", which is exactly what an append is; a crash costs the last line instead of the file;
//! exporting is handing over the file; deleting is deleting. sqlite would buy cross-session
//! search and statistics, and neither exists yet.
//!
//! Nothing is written unless the user turns history on — the setting defaults to off, and
//! the frontend simply never calls [`history_append`] while it is.

use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

/// What the history panel lists: the session's own first line plus what it costs.
#[derive(Serialize)]
pub struct Session {
    /// File stem, and the handle every other command takes.
    id: String,
    /// The session's first JSONL line (languages, model, source), verbatim. Parsed in the
    /// frontend, which is where the shape is decided.
    meta: String,
    /// Sentences, i.e. lines after the meta one.
    count: usize,
    bytes: u64,
}

fn dir(app: &AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("history");
    fs::create_dir_all(&d).map_err(|e| e.to_string())?;
    Ok(d)
}

/// Ids come from the frontend and become a file name, so a bad one is refused outright
/// rather than scrubbed — there is no `..` left to sneak past a `join` this way.
fn slug_ok(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

fn path(app: &AppHandle, id: &str) -> Result<PathBuf, String> {
    if !slug_ok(id) {
        return Err(format!("bad history id: {id}"));
    }
    Ok(dir(app)?.join(format!("{id}.jsonl")))
}

/// Appends one JSON object as a line. The caller serialises it; a literal newline would
/// split one record into two unparseable halves, so it is refused.
#[tauri::command]
pub fn history_append(app: AppHandle, id: String, line: String) -> Result<(), String> {
    if line.contains('\n') {
        return Err("history line must be a single line of JSON".into());
    }
    let path = path(&app, &id)?;
    let mut f = OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
        .map_err(|e| e.to_string())?;
    writeln!(f, "{line}").map_err(|e| e.to_string())
}

/// Newest first. Reads every file to count its sentences — fine for the few hundred small
/// files this produces; give it an index if that ever stops being true.
#[tauri::command]
pub fn history_list(app: AppHandle) -> Result<Vec<Session>, String> {
    let mut out = Vec::new();
    for entry in fs::read_dir(dir(&app)?).map_err(|e| e.to_string())?.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
            continue;
        }
        let Some(id) = path.file_stem().and_then(|s| s.to_str()) else {
            continue;
        };
        // A file that cannot be read is skipped, not fatal: one damaged session must not
        // take the whole panel down with it.
        let Ok(text) = fs::read_to_string(&path) else {
            continue;
        };
        let mut lines = text.lines().filter(|l| !l.trim().is_empty());
        let Some(meta) = lines.next() else { continue };
        out.push(Session {
            id: id.to_string(),
            meta: meta.to_string(),
            count: lines.count(),
            bytes: entry.metadata().map(|m| m.len()).unwrap_or(0),
        });
    }
    // The id is an ISO timestamp, so lexical order is chronological order.
    out.sort_by(|a, b| b.id.cmp(&a.id));
    Ok(out)
}

/// The session's sentences, still as JSON text — the meta line is dropped.
#[tauri::command]
pub fn history_read(app: AppHandle, id: String) -> Result<Vec<String>, String> {
    let text = fs::read_to_string(path(&app, &id)?).map_err(|e| e.to_string())?;
    Ok(text
        .lines()
        .filter(|l| !l.trim().is_empty())
        .skip(1)
        .map(str::to_string)
        .collect())
}

#[tauri::command]
pub fn history_delete(app: AppHandle, id: String) -> Result<(), String> {
    fs::remove_file(path(&app, &id)?).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn history_clear(app: AppHandle) -> Result<(), String> {
    let d = dir(&app)?;
    fs::remove_dir_all(&d).map_err(|e| e.to_string())?;
    fs::create_dir_all(&d).map_err(|e| e.to_string())
}

/// For the "open folder" button — the frontend hands it to the opener plugin.
#[tauri::command]
pub fn history_dir(app: AppHandle) -> Result<String, String> {
    Ok(dir(&app)?.to_string_lossy().into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_that_could_escape_the_history_folder_are_refused() {
        assert!(slug_ok("2026-09-16T14-03-22-123Z"));
        assert!(!slug_ok(""));
        assert!(!slug_ok(".."));
        assert!(!slug_ok("../../settings"));
        assert!(!slug_ok("a/b"));
        assert!(!slug_ok("a\\b"));
        assert!(!slug_ok("a.jsonl"));
        assert!(!slug_ok(&"x".repeat(65)));
    }
}
