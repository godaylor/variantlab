fn main() {
    // SQLx embeds migrations; new files must invalidate Cargo's cached binary.
    println!("cargo:rerun-if-changed=migrations");
}
