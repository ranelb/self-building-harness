// SBH shell: spawn the core, hand its port to the webview, kill it on exit.
//
// The core is the only thing that spawns agents and answers permissions, so the
// shell's whole job is lifecycle: start it, tell the UI where it listens, stop it
// when the window closes. Nothing else lives in Rust.
use std::io::{BufRead, BufReader};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use tauri::{Manager, RunEvent, WebviewUrl, WebviewWindowBuilder};

/// The spawned core, kept so it can be stopped when the app exits. A child left
/// behind holds a loopback port and, worse, an agent with a shell.
struct CoreProcess(Mutex<Option<Child>>);

/// Extract `ws://127.0.0.1:<port>/ws` from the core's single startup line.
fn parse_core_url(line: &str) -> Option<String> {
  let start = line.find("ws://127.0.0.1:")?;
  let rest = &line[start..];
  let end = rest.find("/ws")? + "/ws".len();
  Some(rest[..end].to_string())
}

/// Resolve how to launch the core: a packaged sidecar if present, else Node in dev.
fn core_command(app: &tauri::AppHandle) -> (String, Vec<String>) {
  if let Ok(binary) = std::env::var("SBH_CORE_BIN") {
    return (binary, Vec::new());
  }
  // A packaged build ships the compiled core as a resource (a standalone binary,
  // no Node runtime needed).
  if let Ok(dir) = app.path().resource_dir() {
    let candidate = dir.join("binaries").join("sbh-core");
    if candidate.exists() {
      return (candidate.to_string_lossy().into_owned(), Vec::new());
    }
  }
  // Development: run the TypeScript core with the system Node.
  let root =
    std::env::var("SBH_ROOT").unwrap_or_else(|_| format!("{}/..", env!("CARGO_MANIFEST_DIR")));
  let node = std::env::var("SBH_NODE").unwrap_or_else(|_| "node".into());
  let args = vec![
    "--experimental-strip-types".to_string(),
    format!("{root}/core/index.ts"),
  ];
  (node, args)
}

fn spawn_core(command: String, args: Vec<String>) -> (String, Child) {
  let child = Command::new(&command)
    .args(&args)
    // 0 asks the OS for a free port; the core prints the one it got. An ambient
    // SBH_PORT pins it, which is how the companion phone server finds the core.
    .env("SBH_PORT", std::env::var("SBH_PORT").unwrap_or_else(|_| "0".into()))
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .spawn()
    .unwrap_or_else(|error| panic!("failed to spawn the sbh core via {command}: {error}"));

  let stdout = child.stdout.take().expect("core stdout was piped");
  let mut reader = BufReader::new(stdout);
  let mut line = String::new();
  loop {
    line.clear();
    match reader.read_line(&mut line) {
      Ok(0) => panic!("the core exited before it printed its port"),
      Ok(_) => {
        if let Some(url) = parse_core_url(&line) {
          // Keep draining stdout so the core can never block on a full pipe.
          std::thread::spawn(move || {
            let mut sink = String::new();
            while reader.read_line(&mut sink).unwrap_or(0) > 0 {
              sink.clear();
            }
          });
          return (url, child);
        }
      }
      Err(error) => panic!("reading the core's stdout failed: {error}"),
    }
  }
}

/// Stop the core politely. SIGTERM runs its handler, which closes the ACP
/// connection and so kills the agent; SIGKILL would orphan an agent with a shell.
fn stop_core(child: &mut Child) {
  let pid = child.id();
  let _ = Command::new("kill").args(["-TERM", &pid.to_string()]).status();
  for _ in 0..50 {
    if matches!(child.try_wait(), Ok(Some(_))) {
      return;
    }
    std::thread::sleep(std::time::Duration::from_millis(20));
  }
  let _ = child.kill();
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  // WebKitGTK's DMA-BUF renderer trips a Wayland protocol error on this GPU stack
  // (NVIDIA + Wayland) before the window is ever shown, and the app dies with no
  // window and an orphaned core. Disable it unless the operator set the variable
  // themselves. Must happen before GTK/WebKit initialise, i.e. before the builder.
  if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
    // SAFETY: still single-threaded here; no GTK, WebKit or runtime thread exists.
    unsafe { std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1") }
  }

  let app = tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let (command, args) = core_command(app.handle());
      let (core_url, child) = spawn_core(command, args);
      app.manage(CoreProcess(Mutex::new(Some(child))));

      // Injected before the page's own scripts, so `App` reads it at module load
      // rather than racing an `eval` against first paint.
      let script = format!(
        "window.__SBH_CORE_URL__ = {};",
        serde_json::to_string(&core_url).expect("the core url is a string")
      );
      WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("SBH")
        .inner_size(960.0, 680.0)
        .initialization_script(script)
        .build()?;

      Ok(())
    })
    .build(tauri::generate_context!())
    .expect("error while building tauri application");

  app.run(|app_handle, event| {
    if let RunEvent::Exit = event {
      if let Some(state) = app_handle.try_state::<CoreProcess>() {
        if let Ok(mut guard) = state.0.lock() {
          if let Some(mut child) = guard.take() {
            stop_core(&mut child);
          }
        }
      }
    }
  });
}
