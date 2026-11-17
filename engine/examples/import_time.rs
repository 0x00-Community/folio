use std::time::Instant;

use rdocx::Document;
use rdocx_word_engine::import::import;

fn main() {
    for path in std::env::args().skip(1) {
        let bytes = std::fs::read(&path).expect("read");
        let started = Instant::now();
        let doc = match Document::from_bytes(&bytes) {
            Ok(doc) => doc,
            Err(error) => {
                println!("{path}: parse failed: {error}");
                continue;
            }
        };
        let parse_ms = started.elapsed().as_secs_f64() * 1000.0;
        let started = Instant::now();
        let imported = import(&doc);
        let import_ms = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "{path}: {} KB, parse {parse_ms:.0} ms, import {import_ms:.0} ms, {} block sources",
            bytes.len() / 1024,
            imported.sources.blocks.len()
        );
    }
}
