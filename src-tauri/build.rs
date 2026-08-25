fn main() {
    // Retry tauri_build::build() on transient file-lock errors (Windows Defender).
    let max_attempts = 5;
    for attempt in 1..=max_attempts {
        let result = std::panic::catch_unwind(|| tauri_build::build());
        match result {
            Ok(_) => return,
            Err(_) if attempt < max_attempts => {
                let delay_secs = attempt as u64 * 5;
                eprintln!(
                    "tauri_build panicked (likely os error 32 — attempt {}/{}). Retrying in {}s...",
                    attempt, max_attempts, delay_secs
                );
                std::thread::sleep(std::time::Duration::from_secs(delay_secs));
            }
            Err(p) => std::panic::resume_unwind(p),
        }
    }
}
