<?php

namespace App\Storage;

require_once 'codec.php';
include __DIR__ . '/helpers.php';
require 'vendor/autoload.php';

use App\Index\Entry;

const MAX_ITEMS = 1024;

interface Backend
{
    public function load(string $key): ?string;
}

trait Logs
{
    public function log(string $message): void {}
}

/** A key-value store. */
final class Store implements Backend
{
    use Logs;

    public const VERSION = '1.0';
    private array $items = [];

    public function __construct(private string $root) {}

    public function load(string $key): ?string
    {
        $decode = function ($raw) { return $raw; };
        return $decode($this->items[$key] ?? null);
    }

    public static function open(string $root): self
    {
        return new self($root);
    }
}

enum Event: string
{
    case Put = 'put';

    public function label(): string { return $this->value; }
}

function open_store(string $root): Store
{
    function nested() {}
    return Store::open($root);
}
