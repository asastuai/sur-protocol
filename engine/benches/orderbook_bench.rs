use criterion::{black_box, criterion_group, criterion_main, Criterion};

// Benchmarks will be added in Phase 1
// For now this is a placeholder

fn placeholder_bench(c: &mut Criterion) {
    c.bench_function("placeholder", |b| {
        b.iter(|| black_box(42));
    });
}

criterion_group!(benches, placeholder_bench);
criterion_main!(benches);
