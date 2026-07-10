<?php

declare(strict_types=1);

namespace CleanFixture;

final class Config
{
    /**
     * Value of an environment variable, or a default.
     */
    public function env(string $name, string $fallback = ''): string
    {
        return getenv($name) ?: $fallback;
    }
}
