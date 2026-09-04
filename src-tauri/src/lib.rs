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
  if let Some(state) = app.try_state::<NodeProcess>() {
    if let Some(mut child) = state.0.lock().unwrap().take() {
      log::info!("Stopping Node server (pid {}) for update", child.id());
      kill_node_child(&mut child);
      return Ok(true);
    }
  }
  Ok(false)
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
fn generate_secure_secret() -> String {
  let mut bytes = [0u8; 32];
  getrandom::getrandom(&mut bytes)
    .expect("CSPRNG failure: getrandom could not fill the encryption key buffer");
  bytes.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Generate a 32-char hex token for instance identity verification.
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

/// Sweep stale `node server.js` processes and any processes holding the port.
#[cfg(target_os = "windows")]
fn sweep_stale_servers(_app_data_dir: &Path, port: u16) {
  let script = format!(
    "$ErrorActionPreference='SilentlyContinue'; \
     Get-CimInstance Win32_Process -Filter \"Name = 'node.exe'\" | \
     Where-Object {{ $_.CommandLine -like '*server.js*' }} | \
     ForEach-Object {{ Stop-Process -Id $_.ProcessId -Force }}; \
     Get-NetTCPConnection -LocalPort {} -State Listen -ErrorAction SilentlyContinue | \
     ForEach-Object {{ Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }}",
    port
  );
  let mut cmd = Command::new("powershell");
  cmd.args(["-NoProfile", "-NonInteractive", "-Command", &script]);
  cmd.creation_flags(CREATE_NO_WINDOW);
  let _ = cmd.status();
}

#[cfg(not(target_os = "windows"))]
fn sweep_stale_servers(_app_data_dir: &Path, port: u16) {
  let _ = Command::new("fuser")
    .args(["-k", "-n", "tcp", &port.to_string()])
    .status();
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
fn server_reachable_with_token(addr: &str, expected_token: &str) -> bool {
  let socket_addr: SocketAddr = match addr.parse() {
    Ok(a) => a,
    Err(_) => return false,
  };
  let mut stream = match TcpStream::connect_timeout(&socket_addr, Duration::from_millis(500)) {
    Ok(s) => s,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_secs(2)));
  let _ = stream.set_write_timeout(Some(Duration::from_secs(1)));
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

      let instance_token = generate_instance_token();

      let app_data_dir = app_handle.path().app_data_dir().unwrap_or_else(|_| {
        let fallback = std::env::var("APPDATA")
          .or_else(|_| std::env::var("HOME"))
          .unwrap_or_else(|_| ".".to_string());
        PathBuf::from(&fallback).join("com.hermos.ide")
      });
      if let Err(e) = std::fs::create_dir_all(&app_data_dir) {
        log::warn!("Failed to create app data dir {:?}: {}", app_data_dir, e);
      }

      let enc_key = match resolve_encryption_key(&app_data_dir) {
        Ok(k) => k,
        Err(msg) => fail_startup(&app_handle, &msg),
      };

      let server_js = app_handle
        .path()
        .resource_dir()
        .ok()
        .and_then(|d| {
          for rel in [
            "_up_/.next-build/standalone/server.js",
            ".next-build/standalone/server.js",
            "_up_/.next/standalone/server.js",
            ".next/standalone/server.js",
            "standalone/server.js",
            "server.js",
          ] {
            let candidate = d.join(rel);
            if candidate.exists() {
              return Some(candidate);
            }
          }
          if let Ok(exe) = std::env::current_exe() {
            if let Some(parent) = exe.parent() {
              for rel in [
                "resources/_up_/.next-build/standalone/server.js",
                "resources/.next-build/standalone/server.js",
                "_up_/.next-build/standalone/server.js",
                ".next-build/standalone/server.js",
                "standalone/server.js",
                "server.js",
              ] {
                let candidate = parent.join(rel);
                if candidate.exists() {
                  return Some(candidate);
                }
              }
            }
          }
          None
        });

      let server_path = match server_js {
        Some(p) if p.exists() => p,
        _ => fail_startup(
          &app_handle,
          "Server bundle (server.js) not found in resource directory. Installation may be corrupted.",
        ),
      };

      let server_dir = server_path.parent().unwrap_or(&server_path);
      let bundled_node = find_bundled_node(&app_handle);

      let initial_port = std::env::var("HERMOS_DESKTOP_PORT")
        .ok()
        .and_then(|p| p.parse::<u16>().ok())
        .filter(|p| (PORT_RANGE_START..=PORT_RANGE_END).contains(p))
        .or_else(|| find_available_port(PORT_RANGE_START))
        .unwrap_or(PORT_RANGE_START);

      let host_str = "127.0.0.1";
      let mut active_port = initial_port;
      let mut server_ready = false;
      let mut final_server_url = String::new();

      for retry_attempt in 0..5 {
        let current_port = active_port;
        let port_str = current_port.to_string();
        let server_url = format!("http://127.0.0.1:{}", current_port);
        let check_addr = format!("127.0.0.1:{}", current_port);

        sweep_stale_servers(&app_data_dir, current_port);
        std::thread::sleep(Duration::from_millis(150));

        log::info!(
          "Attempt {}/5: Spawning Next.js server on port {}...",
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
        cmd.current_dir(server_dir);
        cmd.arg("server.js");
        cmd.env("PORT", &port_str);
        cmd.env("HOSTNAME", host_str);
        cmd.env("NODE_ENV", "production");
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
          app_data_dir.to_str().unwrap_or("."),
        );
        cmd.env("ENCRYPTION_KEY", &enc_key);
        cmd.env("HERMOS_INSTANCE_TOKEN", &instance_token);

        let node_log = app_data_dir.join("node-debug.log");
        if let Ok(f) = std::fs::File::create(&node_log) {
          if let Ok(clone) = f.try_clone() {
            cmd.stdout(std::process::Stdio::from(clone));
            cmd.stderr(std::process::Stdio::from(f));
          }
        }

        let spawned = match cmd.spawn() {
          Ok(child) => {
            if let Some(state) = app_handle.try_state::<NodeProcess>() {
              *state.0.lock().unwrap() = Some(child);
            }
            log::info!("Node process spawned successfully for port {}", current_port);
            true
          }
          Err(err) => {
            log::error!("Failed to spawn Node process on port {}: {}", current_port, err);
            false
          }
        };

        if !spawned {
          active_port += 1;
          continue;
        }

        // Poll until the server answers HTTP 200 with instance token
        for wait_tick in 0..120 {
          std::thread::sleep(Duration::from_millis(100));
          if server_reachable_with_token(&check_addr, &instance_token) {
            server_ready = true;
            final_server_url = server_url.clone();
            log::info!(
              "Server verified ready and authenticated on {} after {}ms",
              server_url,
              (wait_tick + 1) * 100
            );
            break;
          }

          // Check if Node process crashed prematurely
          if let Some(state) = app_handle.try_state::<NodeProcess>() {
            if let Some(ref mut child) = *state.0.lock().unwrap() {
              if let Ok(Some(status)) = child.try_wait() {
                log::warn!(
                  "Node process exited with status {} on port {} (EADDRINUSE or crash); retrying next port...",
                  status,
                  current_port
                );
                break;
              }
            }
          }
        }

        if server_ready {
          break;
        } else {
          if let Some(state) = app_handle.try_state::<NodeProcess>() {
            if let Some(mut child) = state.0.lock().unwrap().take() {
              kill_node_child(&mut child);
            }
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

      warmup_server(&final_server_url);

      // Create and display the window ONLY when the backend is 100% verified ready.
      let _window = match WebviewWindowBuilder::new(
        &app_handle,
        "main",
        WebviewUrl::External(final_server_url.parse().expect("invalid loopback URL")),
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
        Err(e) => fail_startup(
          &app_handle,
          &format!("Failed to create application window: {} — WebView2 may be missing or corrupted.", e),
        ),
      };

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
