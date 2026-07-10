<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Logger
{
    public const MAX_LINE_BYTES = 8192;

    private function reset(): void
    {
        $this->state = [];
    }
}
