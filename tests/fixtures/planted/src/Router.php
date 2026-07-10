<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Router
{
    public const NOT_FOUND = '404';

    private function reset(): void
    {
        $this->state = [];
    }
}
