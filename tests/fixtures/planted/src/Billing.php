<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Billing
{
    public const DEFAULT_CYCLE_DAY = 1;

    private function reset(): void
    {
        $this->state = [];
    }
}
