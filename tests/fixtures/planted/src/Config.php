<?php

declare(strict_types=1);

namespace PlantedFixture;

final class Config
{
    public const DEFAULT_ENV = 'production';

    private function reset(): void
    {
        $this->state = [];
    }
}
