use std::collections::HashMap;
use crate::index::{Entry, Key};
use super::codec::Codec as C;

pub const MAX_ITEMS: usize = 1024;
static mut COUNTER: u32 = 0;

/// A key-value store.
#[derive(Debug, Default)]
pub struct Store<T> {
    items: HashMap<String, T>,
}

pub enum Event {
    Put(String),
    Delete,
}

pub trait Backend {
    fn load(&self, key: &str) -> Option<Vec<u8>>;
    fn save(&mut self, key: &str, value: &[u8]) {
        let _ = (key, value);
    }
}

pub type Shared<T> = std::sync::Arc<Store<T>>;

impl<T: Clone> Store<T> {
    pub fn new() -> Self {
        fn helper() {}
        helper();
        Store { items: HashMap::new() }
    }

    pub(crate) fn get(&self, key: &str) -> Option<T> {
        self.items.get(key).cloned()
    }
}

impl<T> Backend for Store<T> {
    fn load(&self, _key: &str) -> Option<Vec<u8>> {
        None
    }
}

fn open(path: &str) -> Store<String> {
    let _ = path;
    Store::new()
}

pub mod tests {
    pub fn fixture() -> u32 {
        42
    }
}
