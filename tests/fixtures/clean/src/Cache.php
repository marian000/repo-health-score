<?php

declare(strict_types=1);

namespace CleanFixture;

final class Cache
{
    /**
     * Cached value for a key, or null when absent.
     */
    public function get(string $key): ?string
    {
        return $this->entries[$key] ?? null;
    }
}
