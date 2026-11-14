use rdocx_word_engine::Session;

#[test]
fn opens_basic_fixture() {
    let bytes = std::fs::read(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../fixtures/basic.docx"
    ))
    .expect("fixtures/basic.docx");
    let session = Session::from_bytes(&bytes).expect("open basic.docx");
    assert!(session.paragraph_count() > 10);
    assert!(session.text().contains("Quarterly report"));
}
