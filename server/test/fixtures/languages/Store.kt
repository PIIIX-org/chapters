package com.example.store

import com.example.index.Entry
import kotlinx.coroutines.flow.*
import com.example.codec.Codec as C

const val MAX_ITEMS = 1024
private val cache = mutableMapOf<String, Any>()

/** A key-value store. */
@JvmInline
class Store<T>(private val root: String) : Backend {
    val size: Int get() = 0
    private var hits = 0

    override fun load(key: String): T? {
        fun local() = key
        return null
    }

    companion object {
        fun create(): Store<String> = Store("/")
    }

    class Node {
        fun visit() {}
    }
}

interface Backend {
    fun load(key: String): Any?
}

enum class Event { PUT, DELETE }

object Registry {
    fun register(store: Store<*>) {}
}

typealias Stores = List<Store<String>>

fun open(root: String): Store<String> = Store(root)
