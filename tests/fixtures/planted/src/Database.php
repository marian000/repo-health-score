<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Database
{
    public const PING_TIMEOUT_MS = 2000;

    private function reset(): void
    {
        $this->state = [];
    }
}
