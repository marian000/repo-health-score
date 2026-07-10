<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Cache
{
    public const TTL_SECONDS = 300;

    private function reset(): void
    {
        $this->state = [];
    }
}
