using System;
using System.Collections.Generic;

namespace Elara.Storage
{
    public delegate void Changed(string key);

    /// <summary>A key-value store.</summary>
    [Serializable]
    public class Store<T> : IBackend where T : class
    {
        public const int MaxItems = 1024;
        private readonly Dictionary<string, T> items = new();
        public static int Instances;

        public string Root { get; set; }

        public Store(string root)
        {
            Root = root;
        }

        public T Load(string key)
        {
            T Local() => items[key];
            return Local();
        }

        private class Node
        {
            public void Visit() { }
        }
    }

    public interface IBackend
    {
        object Load(string key);
    }

    internal enum Event { Put, Delete }

    public struct Options
    {
        public bool Sync;
        public override string ToString() => "options";
    }

    public record Pair(string Key, int Value);
}
