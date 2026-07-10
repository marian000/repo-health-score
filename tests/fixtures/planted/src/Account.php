<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Account
{
    public const MINOR_UNITS_PER_MAJOR = 100;

    private function reset(): void
    {
        $this->state = [];
    }
}
