use std::io::Write;
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x08000000;

/// Loopback port range the desktop server may pick from.
const PORT_RANGE_START: u16 = 3001;
const PORT_RANGE_END: u16 = 3999;

const ENC_KEY_FILE: &str = ".enc_key";
const SECRET_KEY_FILE: &str = ".secret_key";

/// Locate the bundled Node.js sidecar. Tauri `externalBin` sidecars may be
/// placed next to the executable (Windows NSIS), in a binaries folder, or inside
/// the resource dir depending on bundler version/target.
fn find_bundled_node(app: &tauri::AppHandle) -> Option<PathBuf> {
  let mut search_dirs = Vec::new();
  if let Ok(d) = app.path().resource_dir() {
    search_dirs.push(d.clone());
    search_dirs.push(d.join("binaries"));
    search_dirs.push(d.join("resources"));
    search_dirs.push(d.join("resources").join("binaries"));
  }
  if let Ok(exe) = std::env::current_exe() {
    if let Some(parent) = exe.parent() {
      search_dirs.push(parent.to_path_buf());
      search_dirs.push(parent.join("binaries"));
      search_dirs.push(parent.join("resources"));
      search_dirs.push(parent.join("resources").join("binaries"));
      if let Some(grandparent) = parent.parent() {
        search_dirs.push(grandparent.to_path_buf());
        search_dirs.push(grandparent.join("resources"));
      }
    }
  }
  for dir in search_dirs {
    if dir.exists() {
      if let Some(p) = find_node_in_dir(&dir) {
        return Some(p);
      }
    }
  }
  None
}

fn find_node_in_dir(dir: &Path) -> Option<PathBuf> {
  let entries = std::fs::read_dir(dir).ok()?;
  let mut candidates: Vec<PathBuf> = entries
    .filter_map(|e| e.ok())
    .map(|e| e.path())
    .filter(|p| {
      let n = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
      n == "node" || n == "node.exe" || (n.starts_with("node-") && (n.ends_with(".exe") || !n.contains('.')))
    })
    .collect();
  candidates.sort_by(|a, b| {
    let an = a.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let bn = b.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let a_score = if an == "node.exe" || an == "node" { 2 } else { 1 };
    let b_score = if bn == "node.exe" || bn == "node" { 2 } else { 1 };
    b_score.cmp(&a_score).then_with(|| b.file_name().cmp(&a.file_name()))
  });
  candidates.into_iter().next()
}

/// Tauri command: stop the managed Node sidecar (if running) so files under
/// the install dir are not locked — e.g. right before an updater install
/// replaces them. Best-effort: always Ok, failures are only logged.
#[tauri::command]
fn stop_node_sidecar(app: tauri::AppHandle) -> Result<bool, String> {
  // Take the child out from under a SHORT guard, then kill outside it: the
  // kill waits up to ~5s + 500ms grace, and holding the mutex across that
  // would serialize concurrent invokers / the exit handler behind it.
  let child = if let Some(state) = app.try_state::<NodeProcess>() {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
  } else {
    None
  };
  if let Some(mut child) = child {
    log::info!("Stopping Node server (pid {}) for update", child.id());
    kill_node_child(&mut child);
    if let Ok(dir) = app.path().app_data_dir() {
      let _ = std::fs::remove_file(dir.join("node.pid"));
    }
    return Ok(true);
  }
  // In-memory slot is empty (crashed child, or state lost) but a stale
  // pidfile may still point at a live Node holding install-dir locks — and
  // this command exists precisely to release those locks before an update.
  // Fall back to the verified pidfile kill so the updater never proceeds
  // with a locked `_up_` staging dir.
  if let Ok(dir) = app.path().app_data_dir() {
    let before = std::fs::read_to_string(dir.join("node.pid")).unwrap_or_default();
    kill_stale_pidfile(&dir);
    if !before.trim().is_empty() {
      return Ok(true);
    }
  }
  Ok(false)
}

/// Kill the managed child (if any) and drop the stale pidfile so the next
/// boot cannot mistake a recycled PID for our server. Use before every
/// post-spawn fatal exit — `process::exit` skips `RunEvent::Exit`, so
/// without this the orphaned Node keeps the port + install-dir locks.
fn kill_managed_child(app: &tauri::AppHandle) {
  // Same short-guard discipline as stop_node_sidecar: take, drop the guard,
  // then kill (which blocks).
  let child = if let Some(state) = app.try_state::<NodeProcess>() {
    state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
  } else {
    None
  };
  if let Some(mut child) = child {
    kill_node_child(&mut child);
  }
  if let Ok(dir) = app.path().app_data_dir() {
    let _ = std::fs::remove_file(dir.join("node.pid"));
  }
}

/// Tauri command: Open a native folder picker and return the selected path.
#[tauri::command]
fn pick_folder(app: tauri::AppHandle) -> Result<String, String> {
  use tauri_plugin_dialog::DialogExt;

  let path = app
    .dialog()
    .file()
    .set_title("Select folder to open as workspace")
    .blocking_pick_folder();

  match path {
    Some(p) => Ok(p.to_string()),
    None => Err("No folder selected".to_string()),
  }
}

/// Find an available TCP port on the loopback interface within the allowed range.
fn find_available_port(base_port: u16) -> Option<u16> {
  for port in base_port..=PORT_RANGE_END {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok() {
      return Some(port);
    }
  }
  None
}

/// Generate a 64-char lowercase hex secret from a real CSPRNG.
/// Fallible: callers route the error through `fail_startup` (dialog + log
/// tail) instead of aborting via `expect` (silent under `panic = "abort"`).
fn generate_secure_secret() -> Result<String, String> {
  let mut bytes = [0u8; 32];
  getrandom::getrandom(&mut bytes)
    .map_err(|e| format!("CSPRNG failure: could not fill the encryption key buffer ({})", e))?;
  Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

/// Generate a 32-char hex token for instance identity verification.
fn generate_instance_token() -> Result<String, String> {
  let mut bytes = [0u8; 16];
  getrandom::getrandom(&mut bytes)
    .map_err(|e| format!("CSPRNG failure: could not fill the instance token buffer ({})", e))?;
  Ok(bytes.iter().map(|b| format!("{:02x}", b)).collect())
}

fn is_valid_key(raw: &str) -> bool {
  raw.len() == 64 && raw.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Write a secret file with owner-only permissions where supported.
fn write_secret_file(path: &Path, contents: &str) -> std::io::Result<()> {
  #[cfg(unix)]
  {
    use std::os::unix::fs::OpenOptionsExt;
    let mut f = std::fs::OpenOptions::new()
      .create(true)
      .truncate(true)
      .write(true)
      .mode(0o600)
      .open(path)?;
    f.write_all(contents.as_bytes())?;
    f.flush()
  }
  #[cfg(not(unix))]
  {
    std::fs::write(path, contents)
  }
}

/// Best-effort native error popup for paths where the Tauri event loop (and
/// therefore tauri_plugin_dialog) is unavailable — i.e. `setup` failures.
/// No new crates: on Windows this is a one-shot PowerShell
/// System.Windows.Forms MessageBox; everywhere else it is a no-op (the
/// %TEMP% file + stderr carry the message). Blocks the setup thread until
/// acknowledged — correct here (no window exists yet, the app cannot
/// proceed anyway); never runs in CI/test (setup never executes there).
#[cfg(target_os = "windows")]
fn show_native_error(title: &str, msg: &str) {
  // PowerShell string-literal safety: single the quotes ('' escape), strip
  // CR/LF (a pasted log line must not break out of the quoted argument).
  let safe_msg: String = msg.replace('\'', "''").chars().filter(|&c| c != '\r' && c != '\n').collect();
  let safe_title: String = title.replace('\'', "''");
  let script = format!(
    "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.MessageBox]::Show('{msg}', '{title}', 'OK', 'Error') | Out-Null",
    msg = safe_msg,
    title = safe_title
  );
  let mut cmd = Command::new("powershell");
  cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
  cmd.creation_flags(CREATE_NO_WINDOW);
  let _ = cmd.status();
}

#[cfg(not(target_os = "windows"))]
fn show_native_error(_title: &str, _msg: &str) {}

/// Fatal startup failure: log everywhere we can, show a message dialog when
/// possible, then abort. Never continues with an insecure fallback.
///
/// Kills the managed Node child FIRST: `process::exit` skips `RunEvent::Exit`,
/// so without this any caller that fires after a successful spawn would leak
/// an orphaned Node holding the port + install-dir locks. Pre-spawn callers
/// are unaffected (no child to kill — no-op).
fn fail_startup(handle: &tauri::AppHandle, msg: &str) -> ! {
  kill_managed_child(handle);
  log::error!("{}", msg);
  eprintln!("{}", msg);
  let app_data = handle.path().app_data_dir().unwrap_or_default();
  if let Ok(mut f) = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(app_data.join("node-debug.log"))
  {
    let _ = writeln!(f, "[startup:error] {}", msg);
  }

  let owned = msg.to_string();
  let dialog_handle = handle.clone();
  std::thread::spawn(move || {
    use tauri_plugin_dialog::DialogExt;
    let _ = dialog_handle
      .dialog()
      .message(owned)
      .title("HermOS IDE - Startup Error")
      .blocking_show();
    std::process::exit(1);
  });
  // Give the dialog thread time to render before tearing the app down.
  std::thread::sleep(Duration::from_secs(8));
  std::process::exit(1);
}

/// Resolve (or create, then persist) the per-installation encryption key.
fn resolve_encryption_key(app_data_dir: &Path) -> Result<String, String> {
  let enc_key_file = app_data_dir.join(ENC_KEY_FILE);
  let secret_key_file = app_data_dir.join(SECRET_KEY_FILE);

  let enc_key = if enc_key_file.exists() {
    let raw = std::fs::read_to_string(&enc_key_file).map_err(|e| {
      format!(
        "Encryption key file {:?} exists but cannot be read: {}. Refusing to start with a fallback key — remove the file to regenerate.",
        enc_key_file, e
      )
    })?;
    let key = raw.trim().to_string();
    if !is_valid_key(&key) {
      return Err(format!(
        "Encryption key file {:?} contains an invalid key (expected exactly 64 hex characters, got {}). Refusing to start with a fallback key — remove the file to regenerate.",
        enc_key_file,
        key.len()
      ));
    }
    key
  } else {
    let new_key = generate_secure_secret()?;
    write_secret_file(&enc_key_file, &new_key).map_err(|e| {
      format!(
        "Failed to write encryption key to {:?}: {}. Refusing to start without a persisted key.",
        enc_key_file, e
      )
    })?;
    log::info!("Generated new encryption key at {:?}", enc_key_file);
    new_key
  };

  if let Err(e) = write_secret_file(&secret_key_file, &enc_key) {
    log::warn!(
      "Failed to mirror encryption key to {:?}: {}",
      secret_key_file,
      e
    );
  }

  Ok(enc_key)
}

/// Kill the Node child and (on Windows) its whole process tree, then WAIT for
/// the OS to actually release file locks (bounded: up to ~5s poll + 500ms
/// Windows grace; if the child demonstrably survives the kill we log and
/// return WITHOUT waiting forever — the retry loop moves to the next port
/// and the update path leans on its install retries + manual fallback).
///
/// Why the wait matters: on Windows the updater (NSIS) replaces files under
/// the install dir (the `_up_` staging step). If `install()` runs while the
/// Node sidecar is still tearing down, the install dir is still locked
/// (open `server.js` handles) and the update fails with an `_up` / "file in
/// use" lock error. Every caller that precedes an install must go through
/// this path to minimize that race (with the TS-side re-stop + install
/// retries as the backstop — a transient lock can never be ruled out
/// entirely on Windows).
fn kill_node_child(child: &mut Child) {
  // Fast path: already exited (crash/EADDRINUSE) — nothing to taskkill and
  // no grace sleep needed; this keeps port retries on the hot path.
  let already_dead = matches!(child.try_wait(), Ok(Some(_)));
  let pid = child.id();
  if !already_dead {
    #[cfg(target_os = "windows")]
    {
      let mut cmd = Command::new("taskkill");
      cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
      cmd.creation_flags(CREATE_NO_WINDOW);
      match cmd.status() {
        Ok(s) => log::info!("taskkill sent to node pid {} ({})", pid, s),
        Err(e) => log::warn!("taskkill failed for node pid {}: {}", pid, e),
      }
    }
    let _ = child.kill();
  }
  // Poll for actual exit up to 5s (Next.js graceful shutdown can take a
  // moment); then give Windows an extra beat to drop file locks.
  // Skipped entirely when the child was already dead on entry.
  if !already_dead {
    for _ in 0..50 {
      match child.try_wait() {
        Ok(Some(_)) => break,
        Ok(None) => std::thread::sleep(Duration::from_millis(100)),
        Err(_) => break,
      }
    }
    // Bounded reap: if the kill genuinely failed the child is still alive —
    // blocking forever on wait() (while some caller holds the process mutex)
    // is worse than a logged zombie the OS reaps on our exit. The retry loop
    // simply moves to the next port; the update path retries the install.
    match child.try_wait() {
      Ok(Some(_)) | Err(_) => {
        let _ = child.wait();
        #[cfg(target_os = "windows")]
        std::thread::sleep(Duration::from_millis(500));
      }
      Ok(None) => {
        log::error!(
          "Node child pid {} survived kill; NOT waiting (moving on, OS reaps on exit)",
          pid
        );
      }
    }
  } else {
    let _ = child.wait();
  }
}

/// Fast stale-PID cleanup: kill ONLY the PID we recorded in the last run,
/// and only after verifying it is actually a Node process.
///
/// The old implementation shelled out to PowerShell
/// (`Get-CimInstance Win32_Process` + `Get-NetTCPConnection`) on EVERY boot
/// and every port retry — 2-5s of black screen before the window even
/// exists. A pidfile kill is a single `taskkill /PID` (~50ms).
///
/// PID reuse guard: `node.pid` survives clean exits, so the recorded PID may
/// have been recycled by the OS for an unrelated process. On Windows we ask
/// `tasklist` for the image name first and only `taskkill` when it looks
/// like Node; otherwise we leave the process alone and drop the stale file.
/// Shared image-name predicate for the PID-reuse guard: exact `node` /
/// `node.exe`, plus the `node-<target-triple>[.exe]` sidecar form shipped by
/// provision-node-sidecar. Prefix-only on `node-` (with dash): a
/// whole-output substring would match "anode.exe" or a "node" CLI argument
/// of an unrelated program, and a bare starts_with("node") would match
/// "nodepad.exe". (Deliberately slightly wider than find_node_in_dir, which
/// additionally requires `.exe`-or-extensionless: for a kill-guard,
/// fail-closed identity with the dash namespaced form is the right trade —
/// see the triplet discussion at the call sites.)
fn is_node_image_name(literal: &str) -> bool {
  let n = literal.trim().to_ascii_lowercase();
  n == "node" || n == "node.exe" || n.starts_with("node-")
}

/// Verify a PID is actually a Node process before killing it (PID-reuse
/// guard). Parses the tasklist CSV's FIRST field (image name) and compares
/// with is_node_image_name — never a whole-output substring.
#[cfg(target_os = "windows")]
fn pid_is_node(pid: u32) -> bool {
  let mut cmd = Command::new("tasklist");
  cmd.args([
    "/FI",
    &format!("PID eq {}", pid),
    "/FO",
    "CSV",
    "/NH",
  ]);
  cmd.creation_flags(CREATE_NO_WINDOW);
  let out = match cmd.output() {
    Ok(o) => o,
    Err(_) => return false,
  };
  let text = String::from_utf8_lossy(&out.stdout);
  for line in text.lines() {
    // CSV shape: "node.exe","1234","..." — first quoted field is the image.
    let first = line.split(',').next().unwrap_or("").trim().trim_matches('"');
    if is_node_image_name(first) {
      return true;
    }
  }
  false
}

#[cfg(target_os = "linux")]
fn pid_is_node(pid: u32) -> bool {
  // Best-effort: read /proc/<pid>/comm where available (/proc comm
  // truncates to 15 chars, so a triplet binary shows as "node-x86_64-pc" —
  // the node- prefix arm covers that); unknown => refuse.
  let comm = std::fs::read_to_string(format!("/proc/{}/comm", pid)).unwrap_or_default();
  is_node_image_name(comm.trim())
}

/// macOS has no /proc — ask `ps` for the process name instead. Unknown or
/// unparseable => refuse to kill (a leaked stale Node is cheaper than
/// killing a stranger's process).
#[cfg(target_os = "macos")]
fn pid_is_node(pid: u32) -> bool {
  let out = match Command::new("ps")
    .args(["-p", &pid.to_string(), "-o", "comm="])
    .output()
  {
    Ok(o) => o,
    Err(_) => return false,
  };
  let name = String::from_utf8_lossy(&out.stdout);
  let base = name.trim().rsplit('/').next().unwrap_or("");
  is_node_image_name(base)
}

#[cfg(not(any(target_os = "windows", target_os = "linux", target_os = "macos")))]
fn pid_is_node(_pid: u32) -> bool {
  false
}

fn kill_stale_pidfile(app_data_dir: &Path) {
  let pidfile = app_data_dir.join("node.pid");
  let raw = match std::fs::read_to_string(&pidfile) {
    Ok(s) => s,
    Err(_) => return,
  };
  let pid: u32 = match raw.trim().parse() {
    Ok(p) if p > 0 => p,
    _ => {
      log::warn!("node.pid is unparsable; dropping pidfile without killing");
      let _ = std::fs::remove_file(&pidfile);
      return;
    }
  };
  // Never kill ourselves or PID 0/1 — and don't leave the bogus pidfile
  // behind to be re-checked on every future boot.
  if pid == std::process::id() || pid <= 1 {
    log::warn!("node.pid holds {} (self/reserved); dropping pidfile without killing", pid);
    let _ = std::fs::remove_file(&pidfile);
    return;
  }
  if !pid_is_node(pid) {
    log::info!(
      "Stale node.pid holds {} but that process is not Node (or is gone); dropping pidfile without killing",
      pid
    );
    let _ = std::fs::remove_file(&pidfile);
    return;
  }
  #[cfg(target_os = "windows")]
  {
    let mut cmd = Command::new("taskkill");
    cmd.args(["/PID", &pid.to_string(), "/T", "/F"]);
    cmd.creation_flags(CREATE_NO_WINDOW);
    // Best-effort: most boots have no stale process; silence the failure.
    let _ = cmd.status();
  }
  #[cfg(not(target_os = "windows"))]
  {
    let _ = Command::new("kill")
      .args(["-9", &pid.to_string()])
      .status();
  }
  let _ = std::fs::remove_file(&pidfile);
}

fn write_pidfile(app_data_dir: &Path, pid: u32) {
  let _ = std::fs::write(app_data_dir.join("node.pid"), pid.to_string());
}

/// Cached-port helpers: reuse the last working loopback port so warm boots
/// skip the port scan entirely (~instant). The cache is advisory — if the
/// port is busy we fall through to the normal scan.
fn load_cached_port(app_data_dir: &Path) -> Option<u16> {
  let raw = std::fs::read_to_string(app_data_dir.join("hermos.port")).ok()?;
  let p: u16 = raw.trim().parse().ok()?;
  if (PORT_RANGE_START..=PORT_RANGE_END).contains(&p) {
    Some(p)
  } else {
    None
  }
}

fn save_cached_port(app_data_dir: &Path, port: u16) {
  let _ = std::fs::write(app_data_dir.join("hermos.port"), port.to_string());
}

fn warmup_server(server_url: &str) {
  log::info!("Warming up server on {}...", server_url);
  let warmup = reqwest::blocking::Client::builder()
    .timeout(Duration::from_secs(10))
    .build()
    .unwrap_or_else(|_| reqwest::blocking::Client::new());
  for path in &["/api/auth/me", "/api/auth/status"] {
    let url = format!("{}{}", server_url, path);
    match warmup.get(&url).send() {
      Ok(r) => log::info!("Warmup {} -> {}", path, r.status()),
      Err(e) => log::warn!("Warmup {} failed: {}", path, e),
    }
  }
  log::info!("Warmup done");
}

/// Verify that the listener on `addr` is our own Node sidecar by checking
/// the `X-HermOS-Instance-Token` header on `/api/health`.
///
/// Timeouts are tight on purpose: this runs in the startup hot path (polled
/// every 50ms), and the desktop `/api/health` intentionally skips the DB so
/// it answers in <50ms once Node is up.
fn server_reachable_with_token(addr: &str, expected_token: &str) -> bool {
  let socket_addr: SocketAddr = match addr.parse() {
    Ok(a) => a,
    Err(_) => return false,
  };
  let mut stream = match TcpStream::connect_timeout(&socket_addr, Duration::from_millis(200)) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(800)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
  let req = format!(
    "GET /api/health HTTP/1.1\r\nHost: {}\r\nConnection: close\r\n\r\n",
    addr
  );
  if stream.write_all(req.as_bytes()).is_err() {
    return false;
  }
  let mut buf = Vec::new();
  let mut tmp = [0u8; 2048];
  loop {
    use std::io::Read;
    match stream.read(&mut tmp) {
      Ok(0) => break,
      Ok(n) => {
        buf.extend_from_slice(&tmp[..n]);
        if buf.len() > 8192 {
          break;
        }
        if buf.windows(4).any(|w| w == b"\r\n\r\n") {
          break;
        }
      }
      Err(_) => break,
    }
  }
  let headers = String::from_utf8_lossy(&buf).to_ascii_lowercase();
  let status_ok = headers
    .lines()
    .next()
    .map(|line| line.contains(" 200 "))
    .unwrap_or(false);
  if !status_ok {
    return false;
  }
  let token_lower = expected_token.to_ascii_lowercase();
  headers.contains(&format!("x-hermos-instance-token: {}", token_lower))
}

struct NodeProcess(Mutex<Option<Child>>);

/// Background boot: spawn the Node sidecar, wait for /api/health with the
/// instance token, then navigate the splash window to the real app.
///
/// Runs off the Tauri setup thread so the splash window paints in
/// milliseconds. Warmup (`/api/auth/me`) happens AFTER navigation so the
/// user sees the IDE shell while the DB provisions, instead of staring at
/// a black screen.
fn boot_backend_and_navigate(app_handle: tauri::AppHandle) {
  let instance_token = match generate_instance_token() {
    Ok(t) => t,
    Err(msg) => fail_startup(&app_handle, &msg),
  };

  let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
    let fallback = std::env::var("APPDATA")
      .or_else(|_| std::env::var("HOME"))
      .unwrap_or_else(|_| ".".to_string());
    PathBuf::from(&fallback).join("com.hermos.ide")
  });
  if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
    log::warn!("Failed to create app data dir {:?}: {}", app_data_dir, e);
  }

  // One cheap pidfile kill — NOT the old PowerShell full-system sweep.
  kill_stale_pidfile(&app_data_dir);

  let enc_key = match resolve_encryption_key(&app_data_dir) {
    Ok(k) => k,
    Err(msg) => fail_startup(&app_handle, &msg),
  };

  const SERVER_RELS: &[&str] = &[
    "_up_/.next-build/standalone/server.js",
    ".next-build/standalone/server.js",
    "_up_/.next/standalone/server.js",
    ".next/standalone/server.js",
    "standalone/server.js",
    "server.js",
  ];
  let mut search_bases: Vec<PathBuf> = Vec::new();
  if let Ok(d) = app_handle.path().resource_dir() {
    search_bases.push(d);
  }
  if let Ok(exe) = std::env::current_exe() {
    if let Some(parent) = exe.parent() {
      search_bases.push(parent.to_path_buf());
      search_bases.push(parent.join("resources"));
    }
  }
  let server_js = search_bases.iter().find_map(|base| {
    SERVER_RELS.iter().find_map(|rel| {
      let candidate = base.join(rel);
      if candidate.exists() {
        Some(candidate)
      } else {
        None
      }
    })
  });

  let server_path = match server_js {
    Some(p) if p.exists() => p,
    _ => fail_startup(
      &app_handle,
      "Server bundle (server.js) not found in resource directory. Installation may be corrupted.",
    ),
  };

  let bundled_node = find_bundled_node(&app_handle);

  // Prefer the last working port (warm boot = zero scan), then env override,
  // then a fresh scan. The cached port is advisory — busy means next port.
  // NOTE: the bind-then-drop check has an inherent TOCTOU race (another
  // process can grab the port before spawn); the retry loop below is the
  // real protection, not this probe.
  let env_port = std::env::var("HERMOS_DESKTOP_PORT")
    .ok()
    .and_then(|p| p.parse::<u16>().ok())
    .filter(|p| (PORT_RANGE_START..=PORT_RANGE_END).contains(p));
  let port_from_env = env_port.is_some();
  let initial_port = env_port
    .or_else(|| {
      if let Some(cached) = load_cached_port(&app_data_dir) {
        if TcpListener::bind((Ipv4Addr::LOCALHOST, cached)).is_ok() {
          log::info!("Reusing cached port {}", cached);
          return Some(cached);
        }
        log::info!("Cached port {} busy, scanning...", cached);
      }
      None
    })
    .or_else(|| find_available_port(PORT_RANGE_START))
    .unwrap_or_else(|| {
      fail_startup(
        &app_handle,
        "No free loopback port in 3001..=3999. Close the conflicting process and restart.",
      )
    });

  let host_str = "127.0.0.1";
  let mut active_port = initial_port;
  let mut server_ready = false;
  let mut final_server_url = String::new();

  let node_log_path = app_data_dir.join("node-debug.log");
  let node_log_file = std::fs::OpenOptions::new()
    .create(true)
    .append(true)
    .open(&node_log_path)
    .map_err(|e| log::warn!("Could not open node-debug.log: {}", e))
    .ok();
  if let Some(ref f) = node_log_file {
    use std::io::Write as _;
    let _ = writeln!(
      &mut &*f,
      "--- HermOS boot at {:?} ---",
      std::time::SystemTime::now()
    );
  }

  // 3 attempts max (was 5 with 150ms sleeps + 12s polls each). The desktop
  // /api/health skips the DB so a healthy Node answers in <200ms; a slow
  // tick almost always means EADDRINUSE/crash, so fail fast to the next port.
  for retry_attempt in 0..3 {
    if active_port > PORT_RANGE_END {
      break;
    }
    let current_port = active_port;
    let port_str = current_port.to_string();
    let server_url = format!("http://127.0.0.1:{}", current_port);
    let check_addr = format!("127.0.0.1:{}", current_port);

    log::info!(
      "Attempt {}/3: Spawning Next.js server on port {}...",
      retry_attempt + 1,
      current_port
    );

    let mut cmd = if let Some(ref p) = bundled_node {
      log::info!("Using bundled Node sidecar at {:?}", p);
      Command::new(p)
    } else {
      log::warn!("Bundled Node sidecar not found; falling back to system `node` on PATH");
      Command::new("node")
    };

    #[cfg(target_os = "windows")]
    cmd.creation_flags(CREATE_NO_WINDOW);
    // IMPORTANT for updates: run with CWD OUTSIDE the install dir.
    // The old code used `current_dir(server_dir)` inside the install tree,
    // so Windows held a CWD lock on the install dir and the updater could
    // not replace files (`_up` lock error). server.js resolves its assets
    // relative to its own location, and prisma/migrations resolve via
    // __dirname walk, so app-data CWD is safe.
    cmd.current_dir(&app_data_dir);
    cmd.arg(&server_path);
    cmd.env("PORT", &port_str);
    cmd.env("HOSTNAME", host_str);
    cmd.env("NODE_ENV", "production");
    cmd.env("NEXT_TELEMETRY_DISABLED", "1");
    cmd.env("HERMOS_DESKTOP", "true");
    let db_dir = app_data_dir.join("db");
    if let Err(e) = std::fs::create_dir_all(&db_dir) {
      log::warn!("Failed to create db directory {:?}: {}", db_dir, e);
    }
    let db_path = db_dir.join("hermos.db");
    let database_url = format!("file:{}", db_path.to_string_lossy().replace('\\', "/"));
    cmd.env("DATABASE_URL", &database_url);
    cmd.env(
      "HERMOS_APP_DATA_DIR",
      app_data_dir.to_string_lossy().as_ref(),
    );
    cmd.env("ENCRYPTION_KEY", &enc_key);
    cmd.env("HERMOS_INSTANCE_TOKEN", &instance_token);

    // Open the log ONCE per boot (append) so attempt 2/3 never truncate the
    // crash evidence from attempt 1. `node_log_file` is created before the
    // retry loop; each attempt clones the handle.
    if let Some(f) = node_log_file.as_ref().and_then(|f| f.try_clone().ok()) {
      if let Ok(err_f) = f.try_clone() {
        cmd.stdout(std::process::Stdio::from(f));
        cmd.stderr(std::process::Stdio::from(err_f));
      }
    }

    // true = server may come up on this port; false = move to the next port.
    // (Named bool, not an enum: the only question the loop asks is advance
    // vs poll. A missing binary fails fast via fail_startup below instead.)
    let spawned: bool = match cmd.spawn() {
      Ok(child) => {
        let pid = child.id();
        write_pidfile(&app_data_dir, pid);
        if let Some(state) = app_handle.try_state::<NodeProcess>() {
          *state.0.lock().unwrap_or_else(|e| e.into_inner()) = Some(child);
        }
        log::info!("Node process spawned successfully for port {}", current_port);
        true
      }
      Err(err) => {
        log::error!("Failed to spawn Node process on port {}: {}", current_port, err);
        if err.kind() == std::io::ErrorKind::NotFound {
          // Deterministic (missing binary), not a port conflict — retrying
          // the next port cannot help.
          fail_startup(
            &app_handle,
            &format!(
              "Could not launch the bundled Node.js runtime ({}) and no system `node` is on PATH. Reinstall the app.",
              err
            ),
          );
        }
        false
      }
    };

    if !spawned {
      if active_port >= PORT_RANGE_END {
        break;
      }
      active_port += 1;
      continue;
    }

    // Poll until the server answers HTTP 200 with instance token.
    // 50ms ticks x 80 = 4s max per port (was 100ms x 120 = 12s).
    for wait_tick in 0..80 {
      std::thread::sleep(Duration::from_millis(50));
      if server_reachable_with_token(&check_addr, &instance_token) {
        server_ready = true;
        final_server_url = server_url.clone();
        log::info!(
          "Server verified ready and authenticated on {} after {}ms",
          server_url,
          (wait_tick + 1) * 50
        );
        break;
      }

      // Check if Node process crashed prematurely (guard scoped so the
      // mutex is never held across the poll loop's 80 ticks by waiters).
      let crashed: Option<std::process::ExitStatus> = {
        if let Some(state) = app_handle.try_state::<NodeProcess>() {
          let mut slot = state.0.lock().unwrap_or_else(|e| e.into_inner());
          match slot.as_mut().map(|c| c.try_wait()) {
            Some(Ok(Some(s))) => Some(s),
            _ => None,
          }
        } else {
          None
        }
      };
      if let Some(status) = crashed {
        log::warn!(
          "Node process exited with status {} on port {} (port conflict or crash); retrying next port...",
          status,
          current_port
        );
        break;
      }
    }

    if server_ready {
      break;
    } else {
      // Short guard again: take, then kill outside the lock.
      let child = if let Some(state) = app_handle.try_state::<NodeProcess>() {
        state.0.lock().unwrap_or_else(|e| e.into_inner()).take()
      } else {
        None
      };
      if let Some(mut child) = child {
        kill_node_child(&mut child);
      }
      if active_port >= PORT_RANGE_END {
        break;
      }
      active_port += 1;
    }
  }

  if !server_ready {
    let log_path = app_data_dir.join("node-debug.log");
    let tail = std::fs::read_to_string(&log_path)
      .map(|s| {
        let lines: Vec<&str> = s.lines().collect();
        let start = lines.len().saturating_sub(40);
        lines[start..].join("\n")
      })
      .unwrap_or_else(|_| "(no node-debug.log)".to_string());
    fail_startup(
      &app_handle,
      &format!(
        "HermOS backend server failed to start.\n\nNode log ({}):\n{}",
        log_path.display(),
        tail
      ),
    );
  }

  // Don't persist an ephemeral HERMOS_DESKTOP_PORT override — it would defeat
  // the warm-boot cache on the next run.
  if !port_from_env {
    save_cached_port(&app_data_dir, active_port);
  }

  // Navigate the already-visible splash window to the real app.
  if let Some(window) = app_handle.get_webview_window("main") {
    let url: tauri::Url = match final_server_url.parse() {
      Ok(u) => u,
      Err(e) => {
        kill_managed_child(&app_handle);
        fail_startup(&app_handle, &format!("Backend URL is invalid ({}); cannot display the app.", e));
      }
    };
    if let Err(e) = window.navigate(url) {
      kill_managed_child(&app_handle);
      fail_startup(
        &app_handle,
        &format!("Backend is ready but the window could not navigate: {}", e),
      );
    }
    log::info!("Window navigated to {}", final_server_url);
  } else {
    kill_managed_child(&app_handle);
    fail_startup(&app_handle, "Application window disappeared during startup.");
  }

  // Warmup AFTER first paint so provisioning (/api/auth/me -> SQLite
  // migrate on first boot) overlaps the IDE shell instead of blocking it.
  warmup_server(&final_server_url);
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let builder = tauri::Builder::default()
    .plugin(tauri_plugin_process::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(
      {
        #[cfg(debug_assertions)]
        let updater_builder = match std::env::var("HERMOS_TAURI_UPDATER_PUBKEY") {
          Ok(pubkey) if !pubkey.trim().is_empty() => {
            log::info!("Using HERMOS_TAURI_UPDATER_PUBKEY override for updater (debug)");
            tauri_plugin_updater::Builder::new().pubkey(pubkey)
          }
          _ => tauri_plugin_updater::Builder::new(),
        };
        #[cfg(not(debug_assertions))]
        let updater_builder = tauri_plugin_updater::Builder::new();
        updater_builder
      }
      .build(),
    )
    .plugin(
      tauri_plugin_log::Builder::default()
        .level(log::LevelFilter::Info)
        .build(),
    )
    .manage(NodeProcess(Mutex::new(None)))
    .invoke_handler(tauri::generate_handler![pick_folder, stop_node_sidecar]);

  let app = builder
    .setup(move |app| {
      log::info!("HermOS IDE starting...");
      let app_handle = app.handle().clone();

      // Show the window IMMEDIATELY (splash) so cold boot feels instant.
      // The Node sidecar boots in a background thread and the window
      // navigates to the real app the moment /api/health is verified.
      // Previously the window was created only after the backend was ready
      // (Node spawn + 150ms sweep sleeps + up-to-12s poll + blocking warmup
      // of /api/auth/*) — a black screen of up to ~15s on installed builds.
      // NOTE: a splash failure here returns Err (no dialog + no 8s sleep:
      // setup runs before the event loop, so fail_startup's dialog could
      // never paint). Because a GUI release has no visible console, the
      // message is ALSO shown natively (Windows MessageBox) and persisted
      // to %TEMP%/hermos-startup-error.txt so the failure is diagnosable
      // after exit. A missing splash.html asset vs a broken WebView2
      // need different fixes — say which one the error looks like.
      match WebviewWindowBuilder::new(
        &app_handle,
        "main",
        WebviewUrl::App("splash.html".into()),
      )
      .title("HermOS IDE")
      .inner_size(1280.0, 800.0)
      .min_inner_size(900.0, 600.0)
      .decorations(false)
      .shadow(true)
      .resizable(true)
      .center()
      .build()
      {
        Ok(_w) => {},
        Err(e) => {
          let msg = e.to_string();
          // The window handle is owned by the app; no binding needed here.
          let hint = if msg.contains("splash") || msg.contains("not found") || msg.contains("404") {
            format!("Splash asset missing (splash.html not in frontendDist): {}", msg)
          } else {
            format!("Failed to create application window (WebView2 may be missing or corrupted): {}", msg)
          };
          eprintln!("{}", hint);
          let err_file = std::env::temp_dir().join("hermos-startup-error.txt");
          let _ = std::fs::write(&err_file, format!("{}\n", hint));
          show_native_error("HermOS IDE - Startup Error", &hint);
          return Err(e.into());
        }
      };

      let boot_handle = app_handle.clone();
      std::thread::spawn(move || {
        boot_backend_and_navigate(boot_handle);
      });

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    match event {
      RunEvent::ExitRequested { .. } | RunEvent::Exit => {
        log::info!("Terminating Node server on exit");
        kill_managed_child(app_handle);
      }
      _ => {}
    }
  });
}
