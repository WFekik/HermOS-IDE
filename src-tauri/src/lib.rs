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

/// How long to wait for the Node server before creating the window.
const STARTUP_WAIT_SECS: u64 = 5;
/// Overall readiness budget; if the server never comes up within this many
/// seconds the webview keeps showing the connection error.
const TOTAL_WAIT_SECS: u64 = 30;

const ENC_KEY_FILE: &str = ".enc_key";
const SECRET_KEY_FILE: &str = ".secret_key";

/// Locate the bundled Node.js sidecar inside the Tauri resource directory.
/// The bundler renames external binaries to include the target triple
/// (e.g. node-x86_64-pc-windows-msvc.exe), so the exact filename depends
/// on the build target. Scanning for the node-* pattern is robust
/// across targets and Tauri versions.
fn find_bundled_node(resource_dir: &Path) -> Option<PathBuf> {
  let entries = std::fs::read_dir(resource_dir).ok()?;
  entries
    .filter_map(|e| e.ok())
    .map(|e| e.path())
    .filter(|p| {
      p.file_name()
        .and_then(|n| n.to_str())
        .is_some_and(|n| n.starts_with("node-") && (n.ends_with(".exe") || !n.contains('.')))
    })
    .max() // Pick deterministic match
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
/// Returns `None` when every port is occupied so the caller can fail loudly
/// instead of falling back to an occupied port and showing a white screen.
fn find_available_port(base_port: u16) -> Option<u16> {
  for port in base_port..=PORT_RANGE_END {
    if TcpListener::bind((Ipv4Addr::LOCALHOST, port)).is_ok() {
      return Some(port);
    }
  }
  None
}

/// Percent-encode a filesystem path for use in a `file:` URL.
/// Encodes characters that would break URL parsing (`%`, spaces, `#`, `?`).
fn encode_file_url_path(path: &str) -> String {
  path
    .replace('%', "%25")
    .replace(' ', "%20")
    .replace('#', "%23")
    .replace('?', "%3F")
}

/// Generate a 64-char lowercase hex secret from a real CSPRNG.
/// The Node side (`src/lib/encryption.ts`) validates exactly 64 hex chars.
fn generate_secure_secret() -> String {
  let mut bytes = [0u8; 32];
  getrandom::getrandom(&mut bytes)
    .expect("CSPRNG failure: getrandom could not fill the encryption key buffer");
  bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Generate a 32-char hex token for instance identity verification.
/// Passed to the Node sidecar via HERMOS_INSTANCE_TOKEN env var; the health
/// endpoint (`/api/health`) echoes it back as `X-HermOS-Instance-Token` header.
/// The readiness check requires this header to match before the webview
/// navigates — this prevents a port-squatting local process from serving its
/// content inside the app window with IPC capability.
fn generate_instance_token() -> String {
  let mut bytes = [0u8; 16];
  getrandom::getrandom(&mut bytes)
    .expect("CSPRNG failure: getrandom could not fill the instance token buffer");
  bytes.iter().map(|b| format!("{:02x}", b)).collect()
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

/// Fatal startup failure: log everywhere we can, show a message dialog when
/// possible, then abort. Never continues with an insecure fallback.
fn fail_startup(handle: &tauri::AppHandle, msg: &str) -> ! {
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
/// Fails closed: an existing but unreadable/invalid key aborts startup instead
/// of silently falling back to a hardcoded value. The key is mirrored to
/// `.secret_key` so the Node-side encryption module agrees.
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
    let new_key = generate_secure_secret();
    write_secret_file(&enc_key_file, &new_key).map_err(|e| {
      format!(
        "Failed to write encryption key to {:?}: {}. Refusing to start without a persisted key.",
        enc_key_file, e
      )
    })?;
    log::info!("Generated new encryption key at {:?}", enc_key_file);
    new_key
  };

  // Keep Node's `src/lib/encryption.ts` (which reads `.secret_key` when the
  // ENCRYPTION_KEY env var is absent) in sync with the authoritative key.
  if let Err(e) = write_secret_file(&secret_key_file, &enc_key) {
    log::warn!(
      "Failed to mirror encryption key to {:?}: {}",
      secret_key_file,
      e
    );
  }

  Ok(enc_key)
}

/// Kill the Node child and (on Windows) its whole process tree.
fn kill_node_child(child: &mut Child) {
  let pid = child.id();
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
  let _ = child.wait();
}

/// Sweep stale `node server.js` processes left behind by crashed/forced exits.
/// Conservative: only kills node.exe processes whose command line references
/// this app's specific data dir, or (as a fallback) one that looks like this
/// app's standalone server (`server.js` inside a `.next-build` path) — both
/// markers together, so unrelated node projects are never matched.
#[cfg(target_os = "windows")]
fn sweep_stale_servers(app_data_dir: &Path) {
  let marker = app_data_dir.to_string_lossy().replace('\'', "''");
  let script = format!(
    "$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | Where-Object {{ $_.CommandLine -like '*{marker}*' -or ($_.CommandLine -like '*server.js*' -and $_.CommandLine -like '*.next-build*') }} | ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}"
  );
  let mut cmd = Command::new("powershell");
  cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
  cmd.creation_flags(CREATE_NO_WINDOW);
  match cmd.status() {
    Ok(s) => log::info!("Stale server sweep finished: {}", s),
    Err(e) => log::warn!("Stale server sweep failed: {}", e),
  }
}

#[cfg(not(target_os = "windows"))]
fn sweep_stale_servers(_app_data_dir: &Path) {
  log::info!("Stale server sweep skipped on this platform");
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
/// the `X-HermOS-Instance-Token` header on `/api/health`. Uses a raw TCP
/// HTTP/1.1 request so it does not depend on the same port being claimed
/// by a foreign process that happens to answer TCP.
fn server_reachable_with_token(addr: &str, expected_token: &str) -> bool {
  let socket_addr: SocketAddr = match addr.parse() {
    Ok(a) => a,
    Err(_) => return false,
  };
  let mut stream = match TcpStream::connect_timeout(&socket_addr, Duration::from_secs(2)) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_secs(3)));
  let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
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
  // Health must be HTTP 200 and token header must match exactly
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

fn wait_for_our_server(addr: &str, expected_token: &str, timeout_secs: u64) -> bool {
  for i in 0..timeout_secs {
    std::thread::sleep(Duration::from_secs(1));
    if server_reachable_with_token(addr, expected_token) {
      log::info!("Server verified (token match) after {}s", i + 1);
      return true;
    }
    log::info!("Waiting for verified server... ({}/{})", i + 1, timeout_secs);
  }
  false
}

struct NodeProcess(Mutex<Option<Child>>);

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // Signature for update artifacts. The pubkey compiled into tauri.conf.json
  // is authoritative. HERMOS_TAURI_UPDATER_PUBKEY overrides it ONLY in debug
  // builds when the variable is present AND non-empty — in release builds the
  // compiled-in key is always used so a runtime env cannot subvert pinning.
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
    .invoke_handler(tauri::generate_handler![pick_folder]);

  let app = builder
    .setup(move |app| {
      log::info!("HermOS IDE starting...");
      let app_handle = app.handle().clone();

      // Instance token for port-identity verification (prevents a local
      // process squatting the port from serving content into our webview).
      let instance_token = generate_instance_token();

      let desktop_port = std::env::var("HERMOS_DESKTOP_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| (PORT_RANGE_START..=PORT_RANGE_END).contains(p))
        .unwrap_or_else(|| {
          match find_available_port(PORT_RANGE_START) {
            Some(p) => p,
            None => fail_startup(
              &app_handle,
              &format!(
                "No free loopback port in range {}..={} — all ports are occupied. Close other local servers and restart.",
                PORT_RANGE_START, PORT_RANGE_END
              ),
            ),
          }
        });

      let port_str = desktop_port.to_string();
      let host_str = "127.0.0.1";
      let server_url = format!("http://127.0.0.1:{}", desktop_port);
      let check_addr = format!("127.0.0.1:{}", desktop_port);

      log::info!("Desktop Server configured for loopback: {}", server_url);

      let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
        let fallback = std::env::var("APPDATA")
          .or_else(|_| std::env::var("HOME"))
          .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(&fallback).join("com.hermos.ide")
      });
      if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
        log::warn!("Failed to create app data dir {:?}: {}", app_data_dir, e);
      }

      // Kill stale servers from previous, hard-killed sessions before spawning.
      sweep_stale_servers(&app_data_dir);

      // Encryption key: fail closed on unreadable/invalid persisted keys.
      let enc_key = match resolve_encryption_key(&app_data_dir) {
        Ok(k) => k,
        Err(msg) => fail_startup(&app_handle, &msg),
      };

      let server_js = app_handle
        .path()
        .resource_dir()
        .ok()
        .and_then(|d| {
          // Try _up_ layout first (installed), then flat layout
          for rel in [
            "_up_/.next-build/standalone/server.js",
            ".next-build/standalone/server.js",
            "_up_/.next/standalone/server.js",
            ".next/standalone/server.js",
          ] {
            let candidate = d.join(rel);
            if candidate.exists() {
              return Some(candidate);
            }
          }
          None
        });

      if let Some(ref path) = server_js {
        log::info!("Looking for server at: {:?}", path);
        if path.exists() {
          log::info!("Starting Next.js server on port {}...", desktop_port);
          let server_dir = path.parent().unwrap_or(path);
          // Prefer the Node binary bundled as a Tauri sidecar so the app has
          // no system dependency on Node; fall back to `node` on PATH.
          let bundled_node = app_handle
            .path()
            .resource_dir()
            .ok()
            .and_then(|d| find_bundled_node(&d));
          let mut cmd = if let Some(ref p) = bundled_node {
            log::info!("Using bundled Node at {:?}", p);
            Command::new(p)
          } else {
            log::warn!("Bundled Node sidecar not found in resource dir; falling back to system `node` on PATH");
            Command::new("node")
          };
          #[cfg(target_os = "windows")]
          cmd.creation_flags(CREATE_NO_WINDOW);
          cmd.current_dir(server_dir);
          cmd.arg("server.js");
          cmd.env("PORT", &port_str);
          cmd.env("HOSTNAME", host_str);
          cmd.env("NODE_ENV", "production");
          cmd.env("HERMOS_DESKTOP", "true");
          let db_path = app_data_dir.join("hermos.db");
          let database_url = format!("file:{}", encode_file_url_path(&db_path.display().to_string()));
          cmd.env("DATABASE_URL", &database_url);
          cmd.env(
            "HERMOS_APP_DATA_DIR",
            app_data_dir.to_str().unwrap_or("."),
          );
          cmd.env("ENCRYPTION_KEY", &enc_key);
          cmd.env("HERMOS_INSTANCE_TOKEN", &instance_token);

          // Redirect node stdout/stderr to a log file for debugging
          let node_log = app_data_dir.join("node-debug.log");
          if let Ok(f) = std::fs::File::create(&node_log) {
            if let Ok(clone) = f.try_clone() {
              cmd.stdout(std::process::Stdio::from(clone));
              cmd.stderr(std::process::Stdio::from(f));
            }
          }

          match cmd.spawn() {
            Ok(child) => {
              if let Some(state) = app_handle.try_state::<NodeProcess>() {
                *state.0.lock().unwrap() = Some(child);
              }
              log::info!("Node server spawned on port {}", desktop_port);
            }
            Err(err) => {
              fail_startup(&app_handle, &format!("Failed to spawn Node sidecar: {}. Is the installation corrupted?", err));
            }
          }
        } else {
          fail_startup(&app_handle, &format!("server.js not found at {:?} — installation may be corrupted, try reinstalling.", path));
        }
      } else {
        fail_startup(&app_handle, "Server bundle not found in resource directory — installation may be corrupted, try reinstalling.");
      }

      // Short readiness wait: verify the listener is OUR sidecar by checking
      // the instance token echoed on /api/health, not just a bare TCP connect.
      let ready = wait_for_our_server(&check_addr, &instance_token, STARTUP_WAIT_SECS);
      if ready {
        warmup_server(&server_url);
      } else {
        log::warn!(
          "Verified server not reachable after {}s; opening window anyway and retrying in background",
          STARTUP_WAIT_SECS
        );
      }

      // Load the webview directly from the Next.js server on loopback — never
      // from a hardcoded or dev URL. Decorations are off so the app's own
      // TopBar doubles as the native title bar (opencode-style merged header:
      // saves ~32px and looks professional). `shadow` keeps the native window
      // shadow on frameless Windows; titleBarStyle Overlay keeps macOS traffic
      // lights visible.
      let window = match WebviewWindowBuilder::new(
        &app_handle,
        "main",
        WebviewUrl::External(server_url.parse().expect("invalid loopback URL")),
      )
      .title("HermOS IDE")
      .inner_size(1280.0, 800.0)
      .min_inner_size(900.0, 600.0)
      .decorations(false)
      .shadow(true)
      .resizable(true)
      .center()
      .build() {
        Ok(w) => w,
        Err(e) => fail_startup(&app_handle, &format!("Failed to create application window: {} — WebView2 may be missing or corrupted.", e)),
      };

      if !ready {
        let background_window = window.clone();
        let addr = check_addr.clone();
        let background_url = server_url.clone();
        let bg_token = instance_token.clone();
        std::thread::spawn(move || {
          let remaining = TOTAL_WAIT_SECS.saturating_sub(STARTUP_WAIT_SECS);
          for i in 0..remaining {
            std::thread::sleep(Duration::from_secs(1));
            if server_reachable_with_token(&addr, &bg_token) {
              log::info!(
                "Server became ready after background wait ({}s); reloading webview",
                STARTUP_WAIT_SECS + i + 1
              );
              warmup_server(&background_url);
              let target = background_url.clone();
              let nav_window = background_window.clone();
              let _ = background_window.run_on_main_thread(move || {
                if let Ok(url) = target.parse() {
                  let _ = nav_window.navigate(url);
                }
              });
              return;
            }
          }
          log::error!(
            "Server never became reachable within {}s; webview keeps showing the connection error",
            TOTAL_WAIT_SECS
          );
        });
      }

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    match event {
      RunEvent::ExitRequested { .. } | RunEvent::Exit => {
        if let Some(state) = app_handle.try_state::<NodeProcess>() {
          if let Some(mut child) = state.0.lock().unwrap().take() {
            log::info!("Terminating Node server (pid {})", child.id());
            kill_node_child(&mut child);
          }
        }
      }
      _ => {}
    }
  });
}
