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

fn spawn_core() -> (String, Child) {
  // Dev: the repo root is the manifest's parent. A packaged app ships the core as
  // a sidecar and resolves it from the resource dir instead; that is deferred.
  let root =
    std::env::var("SBH_ROOT").unwrap_or_else(|_| format!("{}/..", env!("CARGO_MANIFEST_DIR")));
  let script = format!("{root}/core/index.ts");
  let node = std::env::var("SBH_NODE").unwrap_or_else(|_| "node".into());

  let mut child = Command::new(&node)
    .arg("--experimental-strip-types")
    .arg(&script)
    // 0 asks the OS for a free port; the core prints the one it got.
    .env("SBH_PORT", "0")
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::inherit())
    .spawn()
    .unwrap_or_else(|error| panic!("failed to spawn the sbh core via {node}: {error}"));

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
  let app = tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      let (core_url, child) = spawn_core();
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
