<?php

declare(strict_types=1);

namespace CleanFixture;

final class Router
{
    /**
     * Handler registered for a path, or null.
     */
    public function match(string $path): ?string
    {
        return $this->routes[$path] ?? null;
    }
}
