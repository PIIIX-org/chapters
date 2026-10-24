package com.example.store;

import java.util.HashMap;
import java.util.Map;
import com.example.index.Entry;
import static com.example.index.Keys.normalize;

/** A key-value store. */
@Service
public class Store<T> implements Backend {
    public static final int MAX_ITEMS = 1024;
    private final Map<String, T> items = new HashMap<>();
    protected int hits, misses;

    public Store() {
        Runnable r = new Runnable() {
            public void run() {}
        };
    }

    @Override
    public T load(String key) {
        return items.get(normalize(key));
    }

    private static class Node {
        void visit() {}
    }
}

interface Backend {
    String NAME = "backend";

    Object load(String key);

    default void close() {}
}

enum Event {
    PUT, DELETE;

    boolean destructive() {
        return this == DELETE;
    }
}

record Pair(String key, int value) {
    int size() { return 2; }
}
